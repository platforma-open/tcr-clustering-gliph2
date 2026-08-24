import polars as pl
import argparse
import re
import base64
import hashlib
import kalign

# --- Computed-centroid (kalign MSA consensus) constants ---
# Each cluster's distinct member sequences are aligned with kalign (multiple
# sequence alignment); the centroid is the per-column majority residue over that
# MSA. By default each clonotype's summed abundance is applied as a per-row weight
# during the column vote (rather than by replicating sequences, so kalign sees each
# distinct sequence once). With --no-abundance-weighting every clonotype instead
# counts equally (weight 1), so the centroid reflects the cluster's sequence set
# rather than which clones expanded; column ties then break deterministically
# (non-gap over gap, then alphabetically). The same weight vector drives the
# profile-distance/medoid, so centroid and distance-to-centroid stay consistent.
#   MSA_MAX_MEMBERS — cap on distinct members per cluster fed to kalign; the
#                     top-MSA_MAX_MEMBERS by weight are kept and the rest are
#                     dropped (logged, never silent).
# A column only commits a residue when its winning residue holds at least
# --consensus-threshold of the column's total weight; otherwise the position is
# ambiguous and emits "X". This keeps a 51/49 column from being reported with the
# same confidence as a 70/30 one.
MSA_MAX_MEMBERS = 1000

parser = argparse.ArgumentParser(description='Process clustering results and compute summaries')
parser.add_argument('--consensus-threshold', type=float, default=0.6,
                    help='Minimum fraction (0-1) of a MSA column\'s total abundance weight '
                         'the winning residue must hold for the theoretical (consensus) centroid '
                         'to commit that residue; below it the position is ambiguous and emits "X". '
                         'Default 0.6.')
parser.add_argument('--no-abundance-weighting', action='store_true',
                    help='Ignore clonotype abundance when building the centroid (and the profile '
                         'distance/medoid measured against it): every clonotype counts equally '
                         '(weight 1) instead of by its summed abundance. Column ties then break '
                         'deterministically (non-gap over gap, then alphabetically). '
                         'Default off (abundance-weighted).')
args = parser.parse_args()

consensus_threshold = args.consensus_threshold
no_abundance_weighting = args.no_abundance_weighting

clustersCsv = "clusters.csv"
cloneTableTsv = "cloneTable.tsv"
dedupMappingTsv = "dedup_mapping.tsv"
clusterToSeqTsv = "cluster-to-seq.tsv"
cloneToClusterTsv = "clone-to-cluster.tsv"
abundancesTsv = "abundances.tsv"
abundancesPerClusterTsv = "abundances-per-cluster.tsv"
clusterRadiusTsv = "cluster-radius.tsv"
sequencesTsv = "sequences.tsv"

# sampleId, clonotypeKey, clonotypeKeyLabel,sequence_..., 
# ...VGene, JGene
cloneTable = pl.read_csv(cloneTableTsv, separator="\t", infer_schema_length=0)
# Keys are read as strings (infer_schema_length=0, matching prep.py) so downstream joins never hit
# Int/Utf8 dtype mismatches; abundance is the only numeric column, cast back explicitly.
if "abundance" in cloneTable.columns:
    cloneTable = cloneTable.with_columns(pl.col("abundance").cast(pl.Int64))

# Get all sequence columns if we have them
sequence_cols = [col for col in cloneTable.columns 
                 if col.startswith('sequence_')]

# Create a 'fullSequence' column by concatenating sequence_cols if they exist
if not sequence_cols:
    print("Warning: No sequence columns (e.g., 'sequence_0') found. Sequence-based distance calculation might fail or be incorrect.")
else:
    sorted_sequence_cols = sorted(sequence_cols)
    cloneTable = cloneTable.with_columns(
        pl.concat_str([pl.col(c).fill_null("") for c in sorted_sequence_cols], separator="====").alias('fullSequence')
    )

# Transform clonotypeKeyLabel from "C-XXXXXX" (clonotype, MiXCR-side) or "P-XXXXXX"
# (peptide, peptide-extraction-side) into "CL-XXXXXX" (the cluster label).
# The computed centroid's own "Peptide Id" is NOT derived here — it is a hash of the
# consensus sequence itself, computed once the plurality centroid is known (see the
# peptideLabel derivation on plurality_df below).
cloneTable = cloneTable.with_columns(
    pl.col('clonotypeKeyLabel').str.replace(r'^[CP]-', 'CL-').alias('clusterLabel'),
)

# Leiden partition output (output.csv): seq_id = representative clonotypeKey, cluster = provisional
# integer cluster id (one row per unique sequence). Read as [clusterId, clonotypeKey]; the expand
# step below maps each representative back to every clonotype sharing its sequence. clusterId is the
# provisional integer here — it is relabelled to the cluster's medoid clonotypeKey after the kalign
# pass (see "Medoid relabel" below).
clusters = pl.read_csv(clustersCsv, separator=",", infer_schema_length=0).rename(
    {"seq_id": "clonotypeKey", "cluster": "clusterId"}
)

# --- Expand de-duplicated clusters back to all original clonotypeKeys ---
# The prep step deduped to UNIQUE sequences (one representative per group of identical clustering
# keys) and emitted dedup_mapping.tsv (representativeKey -> clonotypeKey); GLIPH2 + Leiden then
# clustered the unique set. Expand each representative back to every clonotypeKey sharing its sequence.
dedup_mapping = pl.read_csv(dedupMappingTsv, separator="\t", infer_schema_length=0)
# dedup_mapping has columns: representativeKey, clonotypeKey

num_representatives = clusters.select(pl.col("clonotypeKey").n_unique()).item()
clusters = clusters.rename({"clonotypeKey": "representativeKey"}).join(
    dedup_mapping,
    on="representativeKey",
    how="inner"
).drop("representativeKey")
print(f"Expanded clusters: {num_representatives} representatives -> {clusters.height} total clonotype-cluster assignments")

# --- Calculate cluster sizes directly in the clusters dataframe ---
clusters = clusters.with_columns(
    pl.col('clonotypeKey').count().over('clusterId').alias('size')
)

# Label lookup: the centroid's "CL-XXXX" label, keyed by clonotypeKey (aliased to clusterId to
# match the join key). NOT joined here — clusterId is still the Leiden provisional integer, which
# matches no clonotypeKey, so the join would only produce nulls. It is applied once clusterId has
# been relabelled to the medoid clonotypeKey (see "Medoid relabel" below; the no-sequence-cols
# branch joins it too, purely to keep the clusterLabel column present downstream).
labelsTable_for_join = cloneTable.select(
    pl.col('clonotypeKey').alias('clusterId'), # Alias to 'clusterId' to match the left table's key name
    'clusterLabel', # The "CL-XXXX" label associated with this key in cloneTable
).unique(subset=['clusterId'], keep='first') # Unique on the new 'clusterId' column

# --- Compute per-clonotype abundance weight ---
# Weight = abundance summed over sampleId per clonotypeKey. If there is no
# abundance column, or --no-abundance-weighting is set, every clonotype gets
# weight 1 so it contributes equally to the centroid/medoid.
if "abundance" in cloneTable.columns and not no_abundance_weighting:
    clonotype_weights = (
        cloneTable
        .group_by("clonotypeKey")
        .agg(pl.sum("abundance").cast(pl.Float64).alias("weight"))
        .with_columns(
            # Guard against null / non-positive total abundance -> fall back to 1.0
            pl.when(pl.col("weight").is_null() | (pl.col("weight") <= 0))
              .then(pl.lit(1.0, dtype=pl.Float64))
              .otherwise(pl.col("weight"))
              .alias("weight")
        )
    )
else:
    clonotype_weights = (
        cloneTable
        .select("clonotypeKey")
        .unique("clonotypeKey", keep="first")
        .with_columns(pl.lit(1.0, dtype=pl.Float64).alias("weight"))
    )


# kalign only understands biological-sequence letters. A stray non-letter — a stop
# codon "*", an underscore, a space (the one that actually bit us before) — either makes
# kalign choke or, worse, gets silently rewritten in its aligned output. The silent case
# corrupts the profile distance: _msa_profile_distances keys each member by its
# gap-stripped aligned row, and the caller looks that up with the original sequence, so
# any byte kalign changes makes the lookup miss and the member is charged full distance
# (and excluded from the medoid). To keep the round-trip exact, every non-letter is mapped
# to "X" (unknown residue) up front and that sanitized form is used as the canonical key
# everywhere — kalign feed, dedup key, and distance lookup. Length-preserving (1 char ->
# 1 char), so member lengths are unaffected. A no-op on clean input.
_NON_ALPHA_RE = re.compile(r"[^A-Za-z]")


def _sanitize_seq(seq: str) -> str:
    """Replace any non-letter character with 'X' so kalign never sees stray bytes."""
    return _NON_ALPHA_RE.sub("X", seq)


def _msa_consensus(aligned: list[str], weights: list[float], threshold: float) -> str:
    """Abundance-weighted column-majority consensus over a kalign MSA.

    `aligned` are equal-length gap-padded rows from kalign; `weights[i]` is the
    abundance weight of row i. For each column the residue with the greatest total
    weight wins (ties broken deterministically: non-gap over gap, then lexically).
    Columns whose majority residue is a gap contribute nothing to the centroid.

    A non-gap winner is only committed when it holds at least `threshold` of the
    column's total weight; otherwise no residue dominates and the position emits
    "X" (ambiguous). This stops a 51/49 column being reported as confidently as a
    70/30 one.
    """
    out = []
    for col in range(len(aligned[0])):
        tally: dict[str, float] = {}
        for row, w in zip(aligned, weights):
            c = row[col]
            tally[c] = tally.get(c, 0.0) + w
        # Max total weight; on ties prefer a real residue, then the smaller letter.
        best = max(tally.items(), key=lambda kv: (kv[1], kv[0] != "-", -ord(kv[0])))
        if best[0] == "-":
            continue  # gap-majority column: not part of the centroid
        total = sum(tally.values())
        # Commit the residue only when it clears the threshold, else mark ambiguous.
        out.append(best[0] if total > 0 and best[1] / total >= threshold else "X")
    return "".join(out)


def _align_chain(values: list[str], weights: list[float], cluster_id: str):
    """Build one cluster's per-chain kalign MSA ONCE; everything else derives from it.

    The alignment is a pure function of the (deduplicated, ordered, capped) sequence
    set — the abundance weights only matter to the column vote downstream, not to the
    alignment. So this runs kalign a single time and the consensus (theoretical
    centroid), the plurality consensus (threshold 0) and the profile distances/medoid
    all read the SAME result, instead of re-aligning the same sequences 2-4× (the
    redundancy was worst in single-cell, one extra pass per chain). See derive_consensus
    / derive_distances.

    - Drops empty sequences (a member missing this chain contributes nothing here).
    - Deduplicates identical sequences, summing their abundance weights, so kalign
      aligns each distinct sequence once and the weight still drives the column vote.
    - Sanitizes (see _sanitize_seq) before keying so stray non-letters never reach kalign.
    - Caps distinct members at MSA_MAX_MEMBERS by descending weight; logs how many
      dropped (no silent truncation).

    Returns a (mode, payload) bundle:
      - ("empty", None)               — 0 non-empty members.
      - ("single", seq)               — exactly one distinct member (kalign needs >= 2).
      - ("msa", (aligned, weights))   — gap-padded rows + their member weights.
    """
    # Collapse identical sequences, summing weights (one row per distinct sequence).
    weight_by_seq: dict[str, float] = {}
    for v, w in zip(values, weights):
        if v:
            s = _sanitize_seq(v)
            weight_by_seq[s] = weight_by_seq.get(s, 0.0) + w
    if not weight_by_seq:
        return ("empty", None)

    # Deterministic feed order for kalign (§4): descending weight, then lexicographic
    # on the sequence. This fixes the MSA — and hence the centroid, the medoid and the
    # clusterId labels derived from them — run-to-run, removing the CID-conflict risk.
    pairs = sorted(weight_by_seq.items(), key=lambda p: (-p[1], p[0]))

    # Cap distinct members per cluster, keeping the top MSA_MAX_MEMBERS in that same
    # deterministic order (no silent truncation; the kept set is stable too).
    if len(pairs) > MSA_MAX_MEMBERS:
        dropped = len(pairs) - MSA_MAX_MEMBERS
        pairs = pairs[:MSA_MAX_MEMBERS]
        print(f"  cluster {cluster_id}: capped to {MSA_MAX_MEMBERS} distinct members "
              f"by weight, dropped {dropped}")

    if len(pairs) == 1:
        return ("single", pairs[0][0])

    seqs = [s for s, _ in pairs]
    member_weights = [w for _, w in pairs]
    aligned = kalign.align(seqs, seq_type="auto")
    return ("msa", (aligned, member_weights))


def derive_consensus(bundle, threshold: float) -> str:
    """Abundance-weighted column-majority consensus from an _align_chain bundle.

    0 members -> ""; a single distinct member -> that sequence unchanged; otherwise the
    weighted consensus over the shared MSA (see _msa_consensus). At threshold 0.0 the "X"
    branch is unreachable, giving the X-free plurality centroid.
    """
    mode, payload = bundle
    if mode == "empty":
        return ""
    if mode == "single":
        return payload
    aligned, member_weights = payload
    return _msa_consensus(aligned, member_weights, threshold)


def _msa_profile_distances(aligned: list[str], weights: list[float]) -> tuple[dict[str, float], int]:
    """Positional profile distance of each aligned row to the column profile (§3).

    `aligned` are equal-length gap-padded rows from kalign; `weights[i]` is the
    abundance weight of row i. For each column j build the abundance-weighted
    fraction p_j(a) = w_j(a) / W over residues a (the gap "-" is treated as a
    residue, so Σ_a p_j(a) = 1). The cost of a residue in a column is 1 - p_j(a),
    applied on EVERY column (gap columns included), so a row's distance is

        D = Σ_j ( 1 - p_j( row[j] ) ).

    Returns (D_by_seq, L_cons) where D_by_seq maps each aligned row's sequence
    string (with gaps stripped, i.e. the original member sequence) to its profile
    distance D, and L_cons is the number of non-gap-majority consensus columns
    (the column count that contributes to the centroid; used for normalization).
    """
    n_cols = len(aligned[0])
    W = sum(weights)
    # Per-column fractions p_j(a) and the gap-majority flag (mirrors _msa_consensus).
    col_fracs: list[dict[str, float]] = []
    l_cons = 0
    for col in range(n_cols):
        tally: dict[str, float] = {}
        for row, w in zip(aligned, weights):
            c = row[col]
            tally[c] = tally.get(c, 0.0) + w
        col_fracs.append({a: (wa / W if W > 0 else 0.0) for a, wa in tally.items()})
        # Same column winner / tie-break as the consensus: non-gap over gap, then lexical.
        best = max(tally.items(), key=lambda kv: (kv[1], kv[0] != "-", -ord(kv[0])))
        if best[0] != "-":
            l_cons += 1  # non-gap-majority column: part of the centroid length

    # Each member's distance is the sum over columns of 1 - p_j(its residue).
    d_by_seq: dict[str, float] = {}
    for row in aligned:
        d = 0.0
        for col in range(n_cols):
            d += 1.0 - col_fracs[col].get(row[col], 0.0)
        d_by_seq[row.replace("-", "")] = d
    return d_by_seq, l_cons


def derive_distances(bundle) -> tuple[dict[str, float], int]:
    """Per-distinct-member profile distance (§3) from an _align_chain bundle.

    Because it reads the SAME alignment as derive_consensus, the distance is computed
    over exactly the alignment that underlies the centroid — no second kalign pass.
    Returns (D_by_seq, L_cons):
      - D_by_seq maps each distinct (gap-stripped, sanitized) member sequence to its
        profile distance D^(s) for this chain. The caller looks up with the same
        sanitized form.
      - L_cons is the number of non-gap-majority consensus columns for this chain.
    Members dropped by the cap are not in D_by_seq; the caller charges them full length.

    Edge cases: 0 non-empty members -> ({}, 0); a single distinct member -> distance 0
    against itself, L_cons = its length.
    """
    mode, payload = bundle
    if mode == "empty":
        return {}, 0
    if mode == "single":
        seq = payload
        return {seq: 0.0}, len(seq)
    aligned, member_weights = payload
    return _msa_profile_distances(aligned, member_weights)


def compute_centroid_and_distance(clusters_df: pl.DataFrame,
                                  cloneTable: pl.DataFrame,
                                  weights_df: pl.DataFrame,
                                  seq_cols: list[str],
                                  threshold: float):
    """Single per-cluster pass: align each chain ONCE and derive everything from it.

    Each (cluster, chain) is aligned a single time via _align_chain; the theoretical
    centroid (abundance-weighted column consensus), the per-member profile distance and
    the medoid all read that one alignment, instead of re-aligning the same per-cluster,
    per-chain sequences multiple times.

    Returns (centroid_df, distance_df, medoid_df) with the columns/schemas downstream
    assembly expects:
      - centroid_df:  [clusterId, centroid_<seq_cols>]
      - distance_df:  [clusterId, clonotypeKey, distanceToCentroid]
      - medoid_df:    [clusterId, medoid_key]
    """
    # One row per (clusterId, clonotypeKey) carrying every chain value and the weight;
    # grouped into per-cluster lists in a single pass. All list aggregations in one .agg()
    # share the same per-group row order, so __keys / __weights / __vals_* stay
    # index-aligned (the distance assembly relies on this).
    value_lookup = cloneTable.select(
        [pl.col("clonotypeKey")]
        + [pl.col(c).fill_null("").alias(f"__v_{c}") for c in seq_cols]
    ).unique("clonotypeKey", keep="first")

    members = (
        clusters_df
        .select(["clusterId", "clonotypeKey"])
        .unique(subset=["clusterId", "clonotypeKey"], keep="first")
        .join(value_lookup, on="clonotypeKey", how="left")
        .join(weights_df, on="clonotypeKey", how="left")
        .with_columns(
            [pl.col(f"__v_{c}").fill_null("") for c in seq_cols]
            + [pl.col("weight").fill_null(1.0)]
        )
    )

    grouped = (
        members
        .group_by("clusterId")
        .agg(
            pl.col("clonotypeKey").alias("__keys"),
            pl.col("weight").alias("__weights"),
            *[pl.col(f"__v_{c}").alias(f"__vals_{c}") for c in seq_cols],
        )
    )

    # Output column accumulators (lists, one entry per cluster row).
    centroid_out = {"clusterId": []}
    for c in seq_cols:
        centroid_out[f"centroid_{c}"] = []

    dist_clusters = []
    dist_keys = []
    dist_values = []
    medoid_clusters = []
    medoid_keys = []

    for row in grouped.iter_rows(named=True):
        cluster_id = row["clusterId"]
        keys = row["__keys"]
        wts = row["__weights"]

        cons_seq: dict[str, str] = {}             # seq_col -> theoretical centroid (@ threshold)
        d_by_seq_chain: dict[str, dict] = {}      # seq_col -> {sanitized seq: D^(s)}
        l_cons_chain: dict[str, int] = {}         # seq_col -> L_cons^(s)

        for sc in seq_cols:
            # Align this chain ONCE; consensus and distance read the same alignment.
            bundle = _align_chain(row[f"__vals_{sc}"], wts, cluster_id)
            cons_seq[sc] = derive_consensus(bundle, threshold)
            d_by_seq_chain[sc], l_cons_chain[sc] = derive_distances(bundle)

        # --- centroid row ---
        centroid_out["clusterId"].append(cluster_id)
        for c in seq_cols:
            centroid_out[f"centroid_{c}"].append(cons_seq[c])

        # --- profile distance (§3) + medoid (§2) over the chains ---
        # weight is per clonotypeKey (constant across the cluster's chains).
        weight_by_key: dict[str, float] = {}
        seq_by_key: dict[str, str] = {}
        d_total_by_key: dict[str, float] = {}
        norm_by_key: dict[str, float] = {}
        complete_by_key: dict[str, bool] = {}   # has every chain the cluster actually has
        for idx, k in enumerate(keys):
            weight_by_key[k] = wts[idx]
            sum_d = 0.0          # Σ_s D_i^(s) (raw numerator, also the medoid key)
            sum_norm = 0.0       # Σ_s max(L_cons^(s), ℓ_i^(s))
            joined_parts = []
            complete = True      # member carries every chain present in the cluster
            for sc in seq_cols:
                seq = row[f"__vals_{sc}"][idx]
                joined_parts.append(seq)
                member_len = len(seq)
                if seq:
                    # d_by_seq is keyed by the sanitized sequence (see _sanitize_seq); look
                    # up with the same form or stray-char members would miss and be charged
                    # full distance. Sanitizing is length-preserving, so member_len is
                    # unchanged. Dropped-by-cap members are absent from d_by_seq -> charge
                    # full length.
                    d_s = d_by_seq_chain[sc].get(_sanitize_seq(seq), float(member_len))
                    sum_d += d_s
                    sum_norm += max(l_cons_chain[sc], member_len)
                else:
                    # Missing chain. A dropout is a sequencing artifact, not biology, so we
                    # do NOT penalize it: the chain is dropped from BOTH the numerator and the
                    # denominator, leaving its absence neutral to the distance. But a member
                    # missing a chain the cluster actually has (l_cons_chain[sc] > 0) is an
                    # incomplete clone and must not be picked as the reference centroid, so
                    # flag it (see medoid below). When no member has this chain at all
                    # (l_cons_chain[sc] == 0) the chain simply doesn't exist for the cluster.
                    if l_cons_chain[sc] > 0:
                        complete = False
            seq_by_key[k] = "====".join(joined_parts)
            d_total_by_key[k] = sum_d
            norm_by_key[k] = min(1.0, sum_d / sum_norm) if sum_norm > 0 else 0.0
            complete_by_key[k] = complete

        for k in keys:
            dist_clusters.append(cluster_id)
            dist_keys.append(k)
            dist_values.append(norm_by_key[k])

        # Medoid (reference centroid): argmin D_i, tie-break (min D_i, -w_i, seq, clonotypeKey), but
        # ONLY over COMPLETE members — a clone missing a chain (now unpenalized in the distance)
        # must not be chosen as the biological reference. Dropped-by-cap members carry
        # inflated D_i so they don't win the argmin. Fall back to all members only if no
        # member is complete (degenerate cluster where every member lacks some chain).
        # The final clonotypeKey tie-break is REQUIRED for determinism: members sharing a CDR3
        # (deduped for clustering, then re-expanded here) tie on (D_i, w_i, seq), so without it
        # min() would pick by the non-deterministic group_by iteration order — a non-reproducible
        # medoid = clusterId, which also flips every clusterId-keyed output and triggers backend
        # CID conflicts.
        candidate_keys = [k for k in keys if complete_by_key[k]] or keys
        best_key = min(
            candidate_keys,
            key=lambda k: (d_total_by_key[k], -weight_by_key[k], seq_by_key[k], k)
        )
        medoid_clusters.append(cluster_id)
        medoid_keys.append(best_key)

    centroid_schema = {"clusterId": clusters_df.schema["clusterId"]}
    for c in seq_cols:
        centroid_schema[f"centroid_{c}"] = pl.String
    centroid_df = pl.DataFrame(centroid_out, schema=centroid_schema)

    distance_df = pl.DataFrame(
        {
            "clusterId": dist_clusters,
            "clonotypeKey": dist_keys,
            "distanceToCentroid": dist_values,
        },
        schema={
            "clusterId": clusters_df.schema["clusterId"],
            "clonotypeKey": clusters_df.schema["clonotypeKey"],
            "distanceToCentroid": pl.Float64,
        },
    )
    medoid_df = pl.DataFrame(
        {"clusterId": medoid_clusters, "medoid_key": medoid_keys},
        schema={"clusterId": clusters_df.schema["clusterId"], "medoid_key": pl.String},
    )
    return centroid_df, distance_df, medoid_df


# --- Theoretical centroid + profile distance/medoid ---
# Both derive from a SINGLE per-cluster, per-chain kalign MSA (see
# compute_centroid_and_distance), instead of re-aligning the same sequences in separate
# passes. The theoretical centroid (abundance-weighted consensus) drives the
# distance/radius metrics; the reference centroid (medoid) is computed from the same
# alignment and kept purely as a reference.
centroid_df = None
distance_member_df = None    # [clusterId, clonotypeKey, distanceToCentroid]
reference_df = None          # reference_centroid_* per clusterId
reference_cluster_to_seq_cols = []

if sequence_cols:
    centroid_df, distance_member_df, medoid_df = compute_centroid_and_distance(
        clusters, cloneTable, clonotype_weights,
        sequence_cols, consensus_threshold,
    )

    # --- Medoid relabel (Design A) ---
    # clusterId so far is the Leiden provisional integer. Relabel it to the cluster's MEDOID — the
    # real clonotypeKey closest to the kalign-consensus centre (argmin distance; also the reference
    # centroid). Follows the embedding-clustering convention (clusterId = medoid). Remap the 
    # membership + the centroid/distance/medoid frames, then re-derive the CL-XXXX label from
    # the medoid.
    _remap = medoid_df.select(["clusterId", "medoid_key"])

    def _to_medoid(df):
        return (
            df.join(_remap, on="clusterId", how="left")
            .with_columns(pl.coalesce(pl.col("medoid_key"), pl.col("clusterId")).alias("clusterId"))
            .drop("medoid_key")
        )

    clusters = (
        _to_medoid(clusters)
        .join(labelsTable_for_join, on="clusterId", how="left")
    )
    centroid_df = _to_medoid(centroid_df)
    distance_member_df = _to_medoid(distance_member_df)
    medoid_df = medoid_df.with_columns(pl.col("medoid_key").alias("clusterId"))
else:
    medoid_df = None
    # No sequence columns -> no medoid relabel; clusterId stays the Leiden integer. Join the label
    # lookup anyway (matches nothing here, so clusterLabel is null) to keep the column present
    # for the downstream assembly, which references clusterLabel unconditionally.
    clusters = clusters.join(labelsTable_for_join, on="clusterId", how="left")

# Ordered list of centroid columns emitted into cluster-to-seq.tsv.
centroid_cluster_to_seq_cols = [f"centroid_{c}" for c in sequence_cols]

# --- Reference centroid (medoid) columns from the medoid computed above ---
if sequence_cols:
    # Reference centroid = the medoid member's own per-chain sequences (a real member),
    # mirroring the centroid_* set: reference_centroid_<sequence_N>.
    ref_lookup = (
        cloneTable
        .select(
            [pl.col("clonotypeKey").alias("medoid_key")]
            + [pl.col(c).fill_null("").alias(f"reference_centroid_{c}") for c in sequence_cols]
        )
        .unique("medoid_key", keep="first")
    )
    reference_df = medoid_df.join(ref_lookup, on="medoid_key", how="left").drop("medoid_key")

    reference_cluster_to_seq_cols = [f"reference_centroid_{c}" for c in sequence_cols]

# --- Generate cluster-to-seq.tsv ---
# Prepare the right DataFrame for the join, ensuring 'clusterId' and 'size' are treated as payload.
# The 'clusterLabel' here is the centroid's transformed label.
# We also need the centroid's sequence columns for this file.

# First, ensure 'clusters' has 'clusterLabel' (it should from the join above)
# Then, get sequence columns from the centroid.
# Centroid's key is 'clusterId' in the 'clusters' table.
# We need to join 'clusters' with 'cloneTable' (where 'clonotypeKey' is centroid's key)
# to fetch the sequence_cols for the centroid.

# Select sequence columns and 'clonotypeKey' from cloneTable for centroids
centroid_sequences_for_cts = cloneTable.select(
    [pl.col('clonotypeKey').alias("centroid_key_cts")] + sequence_cols
).unique("centroid_key_cts", keep="first")

required_cols_cts = ['clusterId', 'clusterLabel', 'size'] + sequence_cols
# Select necessary columns. The sequence_cols will be from the centroid.
# We need to ensure we pick one row per clusterId.
# The join above might create multiple rows if a clusterId appeared multiple times in clusters
# (e.g. if clusters wasn't unique by clusterId before, though size calculation implies it's grouped by clusterId)
# However, the goal is one centroid sequence per cluster.
# The 'clusters' table after size calculation effectively lists members and their clusterId.
# For cluster-to-seq, we need one entry per clusterId, with its centroid's details.

# Let's use the 'clusterId' (centroid key) and its 'clusterLabel' and 'size' from the 'clusters' table,
# then join to get the centroid's sequences from 'cloneTable'.
# Create a base for cluster_to_seq from unique clusterIds and their already determined labels/sizes.
# Note: 'clusters' contains member clonotypeKeys. We need unique clusterIds.
unique_clusters_info = clusters.select(["clusterId", "clusterLabel", "size"]).unique(subset=["clusterId"], keep="first")

cluster_to_seq_df = unique_clusters_info.join(
    centroid_sequences_for_cts, # Contains centroid_key_cts and its sequence_cols
    left_on="clusterId",
    right_on="centroid_key_cts",
    how="left"
)

# Attach theoretical centroid (consensus) columns, keyed by clusterId.
if centroid_df is not None:
    cluster_to_seq_df = cluster_to_seq_df.join(centroid_df, on="clusterId", how="left")

# Attach reference centroid (medoid) columns, keyed by clusterId. Always emitted.
if reference_df is not None:
    cluster_to_seq_df = cluster_to_seq_df.join(reference_df, on="clusterId", how="left")

cluster_to_seq = cluster_to_seq_df.select(
    required_cols_cts + centroid_cluster_to_seq_cols + reference_cluster_to_seq_cols
)
cluster_to_seq.write_csv(clusterToSeqTsv, separator="\t")


# --- Generate clone-to-cluster.tsv ---
# 'clusters' should have: clusterId (centroid key), clonotypeKey (member key), clusterLabel (centroid's CL-label)
clone_to_cluster = clusters.select(['clusterId',
                                    'clonotypeKey',
                                    'clusterLabel']
                                   ).with_columns(pl.lit(1).alias('link'))
clone_to_cluster.write_csv(cloneToClusterTsv, separator="\t")


# --- Generate abundances.tsv ---
# Merge cloneTable and clusters to link abundances to clusters
# We need 'clusterId' from the 'clusters' table.
merged_abundances = cloneTable.select(['sampleId', 'clonotypeKey', 'abundance']).join(
    clusters.select(['clusterId', 'clonotypeKey']).unique(subset=["clonotypeKey"], keep="first"), # Ensure one cluster per clonotypeKey
    left_on='clonotypeKey', 
    right_on='clonotypeKey', 
    how='inner'
)

cluster_abundances = merged_abundances.group_by(['sampleId', 'clusterId']).agg(
    pl.sum('abundance').alias('abundance')
)

cluster_abundances = cluster_abundances.with_columns(
    pl.sum('abundance').over('sampleId').alias('total_sample_abundance')
)
cluster_abundances = cluster_abundances.with_columns(
    # Guard the division: a sample whose abundances all sum to 0 would otherwise yield NaN/inf.
    # Mirrors the per-cluster fraction guard below.
    pl.when(pl.col('total_sample_abundance') > 0)
      .then(pl.col('abundance') / pl.col('total_sample_abundance'))
      .otherwise(pl.lit(0.0, dtype=pl.Float64))
      .alias('abundance_normalized')
)
cluster_abundances = cluster_abundances.drop('total_sample_abundance')

cluster_abundances.write_csv(abundancesTsv, separator="\t")

# --- Generate abundances-per-cluster.tsv ---
abundances_per_cluster = cluster_abundances.group_by(
    'clusterId').agg(pl.sum('abundance').alias('abundance_per_cluster'))

# Calculate abundance fraction per cluster (fraction of total abundance across all clusters)
total_abundance = abundances_per_cluster.select(pl.sum('abundance_per_cluster')).item()
abundances_per_cluster = abundances_per_cluster.with_columns(
    pl.when(pl.lit(total_abundance) > 0)
      .then(pl.col('abundance_per_cluster') / pl.lit(total_abundance))
      .otherwise(pl.lit(0.0, dtype=pl.Float64))
      .alias('abundance_fraction_per_cluster')
)

abundances_per_cluster.write_csv(abundancesPerClusterTsv, separator="\t")

# --- Get top clusters for bubble plot ---
top_cluster_ids_df = abundances_per_cluster.sort(
    'abundance_per_cluster', descending=True
).head(100).select('clusterId')

# --- Export per-clonotype sequences (MSA viewer input) ---
if sequence_cols:
    select_exprs = [pl.col("clonotypeKey")]
    if "fullSequence" in cloneTable.columns:
        select_exprs.append(pl.col("fullSequence"))
    for c in sorted(sequence_cols):
        if c in cloneTable.columns:
            select_exprs.append(pl.col(c))

    (
        cloneTable
        .select(select_exprs)
        .unique(subset=["clonotypeKey"], keep="first")
    ).write_csv(sequencesTsv, separator="\t")
else:
    # No sequences — write empty file with headers
    pl.DataFrame({
        "clonotypeKey": [],
        "fullSequence": []
    }).write_csv(sequencesTsv, separator="\t")

# --- Generate distance_to_centroid.tsv (New Segmented Approach) ---

# Base DataFrame: member's key and original label
# 'clonotypeKey' is the member's key.
# 'clonotypeKeyLabel' is the member's original label (e.g., "C-YYYY").
# 'clusterId' is the centroid's key.
# 'clusterLabel' is the centroid's transformed label (e.g., "CL-XXXX"), already in 'clusters' table.

# Start with the member-to-centroid assignments from the 'clusters' table.
# 'clusters' has: clonotypeKey (member), clusterId (centroid), size, clusterLabel (centroid's CL-label).
distance_df_base = clusters.select([
    pl.col("clonotypeKey"),             # Member's key
    pl.col("clusterId"),               # Centroid's key
    pl.col("clusterLabel")             # Centroid's transformed "CL-" label
])

# Add member's original 'clonotypeKeyLabel'
member_original_labels = cloneTable.select([
    pl.col("clonotypeKey").alias("member_key_for_label_join"),
    pl.col("clonotypeKeyLabel")        # Member's original "C-" label
]).unique("member_key_for_label_join", keep="first")

distance_df = distance_df_base.join(
    member_original_labels,
    left_on="clonotypeKey",
    right_on="member_key_for_label_join",
    how="left" # Should always find a match if clonotypeKey comes from cloneTable initially
)


if not sequence_cols:
    print("No sequence columns found. Setting distanceToCentroid to 0.0 for all entries.")
    distance_df = distance_df.with_columns(
        pl.lit(0.0, dtype=pl.Float64).alias("distanceToCentroid")
    )
else:
    # distanceToCentroid is the positional profile distance (§3), precomputed per
    # member over the same per-cluster MSA as the centroid (see
    # compute_centroid_and_distance). Attach it by (clusterId, clonotypeKey);
    # this replaces the previous whole-string pds.str_leven against the centroid.
    distance_df = distance_df.join(
        distance_member_df,
        on=["clusterId", "clonotypeKey"],
        how="left"
    ).with_columns(
        pl.col("distanceToCentroid").fill_null(0.0)
    )


# Select final columns for the output TSV
# Ensure all these columns exist in distance_df at this point
# clonotypeKey, clusterId, clusterLabel, clonotypeKeyLabel, distanceToCentroid
output_columns = [
    "clonotypeKey",        # Member's key
    "clusterId",           # Centroid's key
    "clonotypeKeyLabel",   # Member's original "C-" label
    "clusterLabel",        # Centroid's transformed "CL-" label
    "distanceToCentroid"
]
# Reorder/select columns if necessary, ensuring they exist
# If any are missing (e.g. if clonotypeKeyLabel was not joined correctly), this would error.
# The construction of distance_df above should ensure these are present.
distance_df_to_write = distance_df.select(output_columns)


# Drop duplicate rows based on clonotypeKey (member's key), keeping the first occurrence.
# This ensures one distance entry per member clonotype.
distance_df_to_write = distance_df_to_write.unique(subset=["clonotypeKey"], keep="first")

# Output to TSV
output_distance_tsv = "distance_to_centroid.tsv"
distance_df_to_write.write_csv(output_distance_tsv, separator="\t")

print(f"Generated {output_distance_tsv}")

if distance_df_to_write.height == distance_df_to_write.select(pl.col("clonotypeKey").n_unique()).item():
    print(f"Verified: All clonotypeKey values in the written {output_distance_tsv} are unique.")
else:
    print(f"WARNING: clonotypeKey values in the written {output_distance_tsv} are still not unique. This is unexpected after dropping duplicates.")

# --- Generate cluster-radius.tsv ---
# Calculate max normalized distance per cluster
cluster_radius_df = distance_df_to_write.group_by("clusterId").agg(
    pl.max("distanceToCentroid").alias("clusterRadius")
)

# Write to TSV
cluster_radius_df.write_csv(clusterRadiusTsv, separator="\t")
print(f"Generated {clusterRadiusTsv}")

# --- Generate files for top clusters for bubble plotting ---
cluster_abundances_top_df = cluster_abundances.join(top_cluster_ids_df, on="clusterId", how="inner")
cluster_abundances_top_df.write_csv("abundances-top.tsv", separator="\t")

cluster_to_seq_top_df = cluster_to_seq.join(top_cluster_ids_df, on="clusterId", how="inner")
cluster_to_seq_top_df.write_csv("cluster-to-seq-top.tsv", separator="\t")

cluster_radius_top_df = cluster_radius_df.join(top_cluster_ids_df, on="clusterId", how="inner")
cluster_radius_top_df.write_csv("cluster-radius-top.tsv", separator="\t")
