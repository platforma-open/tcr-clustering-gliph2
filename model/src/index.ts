import type { GraphMakerState } from "@milaboratories/graph-maker";
import strings from "@milaboratories/strings";
import type {
  PColumnIdAndSpec,
  PColumnSpec,
  PFrameHandle,
  PlDataTableStateV2,
  PlMultiSequenceAlignmentModel,
  PlRef,
  SUniversalPColumnId,
} from "@platforma-sdk/model";
import {
  BlockModelV3,
  DataModelBuilder,
  createPFrameForGraphs,
  createPlDataTableStateV2,
  createPlDataTableV2,
} from "@platforma-sdk/model";
import type {
  BlockParams,
  InputSelection,
} from "@platforma-open/milaboratories.tcr-clustering.kind";
import { kind } from "@platforma-open/milaboratories.tcr-clustering.kind";
export type * from "@milaboratories/helpers";
export type {
  BlockParams,
  InputSelection,
} from "@platforma-open/milaboratories.tcr-clustering.kind";
import { deriveTemplateParams } from "./templateParams";
export { deriveTemplateParams };

/**
 * Unique-count above which GLIPH2's global step (~O(n^2.8)) becomes intractable. Above this, the
 * "+ V gene" option engages the per-V-partition fast path in the runner (run_gliph2.R); CDR3-only
 * mode has no fast path, so the UI warns when a CDR3-only input exceeds this.
 *
 * Single source of truth: this constant both drives the UI warning AND is passed through the
 * workflow to run_gliph2.R as its fast-path threshold (the exec's 4th arg), so the two cannot drift.
 * run_gliph2.R keeps a matching literal only as a standalone/manual-run fallback.
 */
export const VGENE_FASTPATH_THRESHOLD = 600_000;

/**
 * Per-V-gene partition size (distinct CDR3 in a single V gene) above which even the "+ V gene" fast
 * path is very slow.
 */
export const VGENE_PARTITION_WARN_THRESHOLD = 800_000;

export type BlockData = {
  // Block label (custom overrides default).
  defaultBlockLabel: string;
  customBlockLabel: string;

  // Input selection.
  datasetRef?: PlRef; // anchor: bulk or single-cell TCR dataset
  inputSelection?: InputSelection; // the chosen "Cluster by" option (sequence ref [+ resolved V-gene ref])

  // Engine parameter (advanced). Leiden resolution — clustering granularity: higher = more, smaller
  // clusters (splits GLIPH2's over-merged communities without changing retention). Default 1.0;
  // hard range 0.1–100 (recommended 1–20).
  resolution: number;

  // Centroid (kalign consensus, reused from clonotype-clustering).
  consensusThreshold: number; // 0–1, default 0.6: residue committed only above this column-weight fraction, else "X"
  weightByAbundance: boolean; // false = equal weight (default); true = abundance-weighted consensus/medoid

  // Resources (advanced). CPU-only in v1 — no GPU.
  mem?: number;
  cpu?: number;

  // Mirrored from the prerun output `inputSeqCount`. Blocks Run while this is undefined so the run can't start before the staging
  // size check completes. Cleared on input change (stale guard). Never projected to args.
  lastInputSeqCount?: number;

  // UI-only view state — stays in data, never projected to args.
  tableState: PlDataTableStateV2;
  alignmentModel: PlMultiSequenceAlignmentModel;
  graphStateHistogram: GraphMakerState;
  graphStateBubble: GraphMakerState;
};

/**
 * Find the "Cluster by" option that corresponds to a stored selection, and return its `value`
 * string (the form `PlDropdown` and the option list compare against).
 */
export function findClusterByOption(
  options: { label: string; value: string }[] | undefined,
  selection: InputSelection | undefined,
): { label: string; value: string } | undefined {
  if (options === undefined || selection === undefined) return undefined;
  return options.find((o) => {
    let parsed: InputSelection;
    try {
      parsed = JSON.parse(o.value) as InputSelection;
    } catch {
      return false;
    }
    return parsed.sequenceRef === selection.sequenceRef && parsed.vGeneRef === selection.vGeneRef;
  });
}

export function getDefaultBlockLabel(data: { inputLabel: string; resolution: number }): string {
  const parts: string[] = [];
  if (data.inputLabel) parts.push(data.inputLabel);
  parts.push(`resolution:${data.resolution}`);
  return parts.filter(Boolean).join(", ");
}

/**
 * A fresh block's data, seeded by whatever the creator or template supplied. Every param the
 * contract carries is honoured here, and every field it does not carry falls back to the
 * block's own default — so a block created without params is exactly the block this returns.
 */
export const initBlockData = (params?: BlockParams): BlockData => ({
  defaultBlockLabel: getDefaultBlockLabel({
    inputLabel: "",
    resolution: params?.resolution ?? 1.0,
  }),
  customBlockLabel: params?.customBlockLabel ?? "",
  datasetRef: params?.datasetRef,
  inputSelection: params?.inputSelection,
  resolution: params?.resolution ?? 1.0,
  consensusThreshold: params?.consensusThreshold ?? 0.6,
  weightByAbundance: params?.weightByAbundance ?? false,
  tableState: createPlDataTableStateV2(),
  alignmentModel: {},
  graphStateBubble: {
    title: "Most abundant clusters",
    template: "bubble",
    currentTab: null,
    layersSettings: {
      bubble: {
        normalizationDirection: null,
      },
    },
  },
  graphStateHistogram: {
    title: strings.titles.histogram,
    template: "bins",
    currentTab: null,
    layersSettings: {
      bins: { fillColor: "#99e099" },
    },
    axesSettings: {
      axisY: {
        axisLabelsAngle: 90,
        scale: "log",
      },
      other: { binsCount: 30 },
    },
  },
});

const dataModel = new DataModelBuilder({ kind })
  .from<BlockData>("v1")
  .init(({ params }) => initBlockData(params));

/** Strip the trailing " Primary" token from a MiXCR single-cell label ("Beta CDR3 aa Primary" -> "Beta CDR3 aa"). */
function trimPrimary(label: string): string {
  return label.replace(/\s+Primary$/i, "");
}

export const platforma = BlockModelV3.create({ dataModel, kind })

  .args((data) => {
    if (!data.datasetRef) throw new Error("Dataset is required");
    const sel = data.inputSelection;
    if (!sel) throw new Error("Choose what to cluster by");
    if (!sel.sequenceRef) throw new Error("A CDR3 column is required");

    // Gate Run on the numeric params: throwing makes the block not-runnable (Run disabled, message
    // surfaced) rather than silently coercing. The `!(… >= … && … <= …)` form also catches a
    // cleared/blank field (undefined) or NaN — a plain `< || >` would let those through as false.
    if (!(data.resolution >= 0.1 && data.resolution <= 100))
      throw new Error("Leiden resolution must be between 0.1 and 100");
    if (!(data.consensusThreshold >= 0 && data.consensusThreshold <= 1))
      throw new Error("Consensus threshold must be between 0 and 1");
    // Block Run until the staging pre-flight size check lands (mirrored from the prerun into
    // `data.lastInputSeqCount` by app.ts). Prevents launching the (potentially very long) run before
    // the input size — and thus the CDR3-only fast-path warning — is known. Last gate, so param
    // errors above surface first and this only shows once everything else is valid.
    if (data.lastInputSeqCount === undefined) throw new Error("Checking dataset size…");
    // Empty input: the pre-flight count came back with zero distinct sequences, so there is nothing
    // to cluster. Fail here rather than launching a run that can only produce empty outputs.
    if (data.lastInputSeqCount === 0)
      throw new Error("No sequences in the selected column — nothing to cluster");

    return {
      defaultBlockLabel: data.defaultBlockLabel,
      customBlockLabel: data.customBlockLabel,
      datasetRef: data.datasetRef,
      // Strip resolvedVGeneRef (prerun-only) — clustering keys on vGeneRef, set only for "+ V gene".
      inputSelection: { sequenceRef: sel.sequenceRef, vGeneRef: sel.vGeneRef },
      resolution: data.resolution,
      consensusThreshold: data.consensusThreshold,
      weightByAbundance: data.weightByAbundance,
      mem: data.mem,
      cpu: data.cpu,
      fastThreshold: VGENE_FASTPATH_THRESHOLD,
    };
  })

  // Prerun (staging) args — count the input sequences before Run so the UI can warn about CDR3-only
  // clustering at scale. Only needs the dataset + chosen sequence column; returning `undefined`
  // defers the prerun until both are picked so it doesn't fire on every keystroke.
  .prerunArgs((data) => {
    if (data.datasetRef === undefined) return undefined;
    const sel = data.inputSelection;
    if (sel?.sequenceRef === undefined) return undefined;
    return {
      datasetRef: data.datasetRef,
      sequenceRef: sel.sequenceRef,
      vGeneRef: sel.resolvedVGeneRef,
    };
  })

  // Unique input sequence count from the prerun (distinct CDR3 values). prerun.tpl.tengo saves a single-value
  // TSV (`count\n<n>\n`) via `df.saveContent`; parse the integer. Not-ready-safe (allowPermanentAbsence).
  // The UI gates a "clustering without + V gene is slow at this scale" warning on it.
  .output("inputSeqCount", (ctx): number | undefined => {
    const raw = ctx.prerun
      ?.resolve({ field: "seqCount", assertFieldType: "Input", allowPermanentAbsence: true })
      ?.getDataAsString();
    if (raw === undefined) return undefined;
    const lines = raw.trim().split("\n");
    if (lines.length < 2) return undefined;
    const n = Number(lines[1].trim());
    return Number.isFinite(n) ? n : undefined;
  })

  // Distinct CDR3s in the LARGEST single V-gene partition
  .output("maxVGeneSeqCount", (ctx): number | undefined => {
    const raw = ctx.prerun
      ?.resolve({ field: "maxVGeneCount", assertFieldType: "Input", allowPermanentAbsence: true })
      ?.getDataAsString();
    if (raw === undefined) return undefined;
    const lines = raw.trim().split("\n");
    if (lines.length < 2) return undefined;
    const n = Number(lines[1].trim());
    return Number.isFinite(n) ? n : undefined;
  })

  // Dataset picker: TCR α/β clonotype datasets (bulk + single-cell). No peptide (variantKey).
  // Only TCR α/β is offered — IG (BCR) and TCR γ/δ are dropped (this is a TCR-β/α specificity-
  // clustering block, and GLIPH2 is built for αβ). Bulk anchors are per-chain (clonotypeKey domain
  // `pl7.app/vdj/chain` = TCRAlpha/TCRBeta); single-cell anchors are per-receptor (scClonotypeKey
  // domain `pl7.app/vdj/receptor` = TCRAB).
  .output("datasetOptions", (ctx) => {
    const options = ctx.resultPool.getOptions(
      [
        {
          axes: [{ name: "pl7.app/sampleId" }, { name: "pl7.app/vdj/clonotypeKey" }],
          annotations: { "pl7.app/isAnchor": "true" },
        },
        {
          axes: [{ name: "pl7.app/sampleId" }, { name: "pl7.app/vdj/scClonotypeKey" }],
          annotations: { "pl7.app/isAnchor": "true" },
        },
      ],
      {
        // suppress the column's native label (e.g. "Number of Reads") to show only the dataset label
        label: { includeNativeLabel: false },
      },
    );

    // Bulk anchors carry the chain per clonotypeKey; keep only the TCR α/β chains.
    const TCR_AB_CHAINS = new Set(["TCRAlpha", "TCRBeta"]);

    return options.filter((opt) => {
      const keyAxis = ctx.resultPool.getPColumnSpecByRef(opt.ref)?.axesSpec[1];
      if (keyAxis === undefined) return false;
      // Exclude this block's OWN exported cluster axis from the input picker.
      if (keyAxis.domain?.["pl7.app/clustering/algorithm"] !== undefined) return false;
      // Bulk: per-chain anchor → keep only TCR α/β (drop IG, TCR γ/δ).
      if (keyAxis.name === "pl7.app/vdj/clonotypeKey") {
        return TCR_AB_CHAINS.has(keyAxis.domain?.["pl7.app/vdj/chain"] ?? "");
      }
      // Single-cell: per-receptor anchor → keep only the TCR α/β receptor (drop IG, TCR γ/δ). The
      // "Cluster by" dropdown then offers the Primary Beta / Alpha CDR3 for single-chain clustering.
      if (keyAxis.name === "pl7.app/vdj/scClonotypeKey") {
        return keyAxis.domain?.["pl7.app/vdj/receptor"] === "TCRAB";
      }
      return false;
    });
  })

  // The single "Cluster by" dropdown. Options are generated from the dataset's Primary CDR3 aa
  // columns (labelled from MiXCR, "Primary" trimmed), each also offered "+ V gene" when the
  // dataset carries V-gene columns. Single-chain only — turboGliph has no native α+β pairing, so
  // there is no "Paired" option. Each option's value is a JSON-encoded InputSelection; the UI parses
  // it into data.inputSelection on the user's gesture (snapshot pattern). The chain name is read
  // from the MiXCR LABEL, never from the scClonotypeChain slot letter (diversity-ordered: A=Beta).
  .output("clusterByOptions", (ctx) => {
    const ref = ctx.data.datasetRef;
    if (ref === undefined) return undefined;
    const dsSpec = ctx.resultPool.getPColumnSpecByRef(ref);
    if (dsSpec === undefined) return undefined;
    const isSingleCell = dsSpec.axesSpec[1].name === "pl7.app/vdj/scClonotypeKey";

    const cdr3Matcher = {
      axes: [{ anchor: "main" as const, idx: 1 }],
      name: "pl7.app/vdj/sequence",
      domain: {
        "pl7.app/vdj/feature": "CDR3",
        "pl7.app/alphabet": "aminoacid",
        // Single-cell: restrict to each chain's Primary CDR3.
        ...(isSingleCell ? { "pl7.app/vdj/scClonotypeChain/index": "primary" } : {}),
      },
    };
    const cdr3Cols = ctx.resultPool.getCanonicalOptions({ main: ref }, [cdr3Matcher], {
      ignoreMissingDomains: true,
      labelOps: { includeNativeLabel: true },
    });
    if (cdr3Cols === undefined) return undefined;

    // Resolve the V-gene column(s) so the "+ V gene" options carry the matching V-gene ref (the
    // workflow consumes it directly — no workflow-side chain matching). Single-cell: one V-gene
    // column per chain (restrict to Primary); bulk: one on the anchor. Match a V gene to a CDR3 by
    // the chain name in the MiXCR label ("Beta CDR3 aa" <-> "Beta Best V gene"; bulk: both have no
    // chain prefix → both map to "").
    const vGeneOpts = ctx.resultPool.getCanonicalOptions(
      { main: ref },
      [
        {
          axes: [{ anchor: "main" as const, idx: 1 }],
          name: "pl7.app/vdj/geneHit",
          domain: {
            "pl7.app/vdj/reference": "VGene",
            ...(isSingleCell ? { "pl7.app/vdj/scClonotypeChain/index": "primary" } : {}),
          },
        },
      ],
      { ignoreMissingDomains: true, labelOps: { includeNativeLabel: true } },
    );
    const chainOf = (label: string) =>
      (label.match(/^(Alpha|Beta|Gamma|Delta|Heavy|Light)\b/i)?.[1] ?? "").toLowerCase();
    const vGeneByChain = new Map<string, SUniversalPColumnId>();
    for (const v of vGeneOpts ?? []) vGeneByChain.set(chainOf(v.label ?? ""), v.value);

    const options: { label: string; value: string }[] = [];
    for (const c of cdr3Cols) {
      const base = trimPrimary(c.label ?? "");
      // The chain's single V-gene column, attached to BOTH options as resolvedVGeneRef so the prerun
      // can size the largest V-gene partition at CDR3 selection (the ">800k" warning) regardless of
      // the CDR3-only vs "+ V gene" choice. Only the "+ V gene" option also sets vGeneRef (clustering).
      const vGeneRef = vGeneByChain.get(chainOf(c.label ?? ""));
      const single: InputSelection = { sequenceRef: c.value, resolvedVGeneRef: vGeneRef };
      options.push({ label: base, value: JSON.stringify(single) });
      if (vGeneRef !== undefined) {
        const withV: InputSelection = {
          sequenceRef: c.value,
          vGeneRef,
          resolvedVGeneRef: vGeneRef,
        };
        options.push({ label: `${base} + V gene`, value: JSON.stringify(withV) });
      }
    }

    return options;
  })

  .output("isSingleCell", (ctx) => {
    if (ctx.data.datasetRef === undefined) return undefined;
    const spec = ctx.resultPool.getPColumnSpecByRef(ctx.data.datasetRef);
    if (spec === undefined) return undefined;
    return spec.axesSpec[1].name === "pl7.app/vdj/scClonotypeKey";
  })

  // Empty-input flag (the workflow emits `isEmpty`). Not-ready-safe read (getDataAsJson throws
  // mid-run on remote backends — MILAB-6318), so use the OrUndefined variant.
  .output("inputState", (ctx): boolean | undefined => {
    const inputState = ctx.outputs?.resolve("isEmpty")?.getDataAsJsonOrUndefined<unknown>();
    return typeof inputState === "boolean" ? inputState : undefined;
  })

  // Main clusters table.
  .outputWithStatus("clustersTable", (ctx) => {
    const pCols = ctx.outputs?.resolve("clustersPf")?.getPColumns();
    if (pCols === undefined) return undefined;
    return createPlDataTableV2(ctx, pCols, ctx.data.tableState);
  })

  // Clustering run logs — GLIPH2 network build (gliph stdout) and the Leiden partition (leiden
  // stdout). Shown as two tabs in the Clustering Log window.
  .output("gliphOutput", (ctx) => ctx.outputs?.resolve("gliphLog")?.getLogHandle())
  .output("leidenOutput", (ctx) => ctx.outputs?.resolve("leidenLog")?.getLogHandle())

  // MSA p-frame for the alignment viewer: the workflow's msaPf (linker + distances + sequences)
  // plus the dataset's ORIGINAL sequence columns chosen for clustering.
  .output("msaPf", (ctx): PFrameHandle | undefined => {
    const msaCols = ctx.outputs?.resolve("msaPf")?.getPColumns();
    if (!msaCols) return undefined;
    const datasetRef = ctx.data.datasetRef;
    const sel = ctx.data.inputSelection;
    if (datasetRef === undefined || sel === undefined) return createPFrameForGraphs(ctx, msaCols);
    const refs = [sel.sequenceRef];
    const seqCols = ctx.resultPool.getAnchoredPColumns(
      { main: datasetRef },
      refs.map((s) => JSON.parse(s) as never),
    );
    if (seqCols === undefined) return createPFrameForGraphs(ctx, msaCols);
    return createPFrameForGraphs(ctx, [...msaCols, ...seqCols]);
  })

  // The cluster-to-clonotype linker column id, used by the MSA viewer.
  .output("linkerColumnId", (ctx) => {
    const pCols = ctx.outputs?.resolve("msaPf")?.getPColumns();
    if (!pCols) return undefined;
    return pCols.find((p) => p.spec.annotations?.["pl7.app/isLinkerColumn"] === "true")?.id;
  })

  // Spec of the per-(sample, cluster) abundance column — drives the MSA cell-button axis.
  .output("clusterAbundanceSpec", (ctx) => {
    return ctx.outputs?.resolve("clusterAbundanceSpec")?.getDataAsJsonOrUndefined<PColumnSpec>();
  })

  // p-frame of all cluster columns, for the plots.
  .outputWithStatus("clustersPf", (ctx): PFrameHandle | undefined => {
    const pCols = ctx.outputs?.resolve("pf")?.getPColumns();
    if (pCols === undefined) return undefined;
    return createPFrameForGraphs(ctx, pCols);
  })

  // Top-clusters p-frame for the bubble plot.
  .outputWithStatus("bubblePlotPf", (ctx): PFrameHandle | undefined => {
    const pCols = ctx.outputs?.resolve("bubblePlotPf")?.getPColumns();
    if (pCols === undefined) return undefined;
    return createPFrameForGraphs(ctx, pCols);
  })

  // Pcol id+spec lists for plot defaults.
  .output("clustersPfPcols", (ctx) => {
    const pCols = ctx.outputs?.resolve("pf")?.getPColumns();
    if (pCols === undefined || pCols.length === 0) return undefined;
    return pCols.map((c) => ({ columnId: c.id, spec: c.spec }) satisfies PColumnIdAndSpec);
  })

  .output("bubblePlotPfPcols", (ctx) => {
    const pCols = ctx.outputs?.resolve("bubblePlotPf")?.getPColumns();
    if (pCols === undefined) return undefined;
    return pCols.map((c) => ({ columnId: c.id, spec: c.spec }) satisfies PColumnIdAndSpec);
  })

  .output("isRunning", (ctx) => ctx.outputs?.getIsReadyOrError() === false)

  .templateParams(deriveTemplateParams)

  .title(() => "GLIPH2 Clustering")

  .subtitle((ctx) => ctx.data.customBlockLabel || ctx.data.defaultBlockLabel)

  .sections((_ctx) => [
    { type: "link" as const, href: "/" as const, label: strings.titles.main },
    { type: "link" as const, href: "/bubble" as const, label: "Most Abundant Clusters" },
    { type: "link" as const, href: "/histogram" as const, label: "Cluster Size Histogram" },
  ])

  .done();
