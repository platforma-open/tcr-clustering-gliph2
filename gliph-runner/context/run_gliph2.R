#!/usr/bin/env Rscript
# GLIPH2 (turboGliph) runner for the tcr-clustering GLIPH2 + Leiden engine.
#
# Builds the GLIPH2 CDR3 similarity network from unique CDR3b (+ optional gene-level TRBV). The
# downstream Leiden partition (python) turns that network into one cluster per sequence. library()
# only — the deps come from the image, never install here.
#
# Input CSV (built by the workflow's prep step) — column names are the stable contract, kept
# INSIDE this script:
#   * `CDR3b` — the CDR3 amino-acid sequence (one row per unique clustering key). Always present.
#   * `TRBV`  — gene-level V gene (e.g. TRBV7-2). Present ONLY for the "+ V gene" option; when it is
#               present GLIPH2 requires the same V gene for global edges (global_vgene = TRUE,
#               gene-level, per the MILAB-6495 GLIPH2+Leiden engine decision). Absent = CDR3-only.
#
# TWO EXECUTION PATHS:
#   * standard — one gliph2() run on the whole input; writes ALL connection edges (global + local).
#     This is the original behaviour and stays exact.
#   * fast (per-V partition, GLOBAL-only) — used ONLY when TRBV is present AND the unique count
#     exceeds FAST_THRESHOLD. GLIPH2's global step is ~O(n^2.8) in the unique count, so it becomes
#     intractable at ~>600k (a full run can take hours / OOM). With global_vgene = TRUE a global
#     edge can only join two SAME-V-gene CDR3s, so splitting the input by full TRBV and running
#     GLIPH2 per partition yields the IDENTICAL global edge set (verified loss-free: ARI 1.0 vs a
#     full run through Leiden at 200k/500k) while collapsing the cost (each partition is ~n/k, and
#     the total work is Sum (n/k)^2.8 << n^2.8). We keep GLOBAL edges only — the per-partition local
#     (motif) enrichment sees a smaller background and is NOT comparable across partitions; global
#     edges dominate the clustering anyway (ARI ~0.95 vs the full global+local run). This path does
#     NOT apply to CDR3-only mode: there global edges cross V genes, so partitioning by V would change
#     the clustering entirely.
#
# Args:  <input.csv> <out_dir> [n_cores] [fast_threshold]
suppressMessages(library(turboGliph))

# --- patched gliph2 (empty-reference crash fix) --------------------------------------------------
# turboGliph's global step crashes on narrow partitions whose CDR3 structs don't overlap the naive
# reference DB: ref_stats is built as an empty double-typed frame, so dplyr's strict join on `tag`
# aborts ("y$tag is a <double>"). The fast path can produce such partitions, and a crash would
# silently drop that partition's edges. gliph2_patched.R is turboGliph 0.99.2's gliph2() with four
# minimal edits (type the empty ref_stats + coerce the two sample-vs-reference join keys to
# character + keep the D-gene search matrix 2-D when one sequence is left). Loaded into an env parented on turboGliph's namespace so every internal call resolves
# exactly as the installed function would. Falls back to the stock gliph2() if the patch is absent.
.load_gliph2 <- function() {
  patch <- "/app/gliph2_patched.R"
  if (file.exists(patch)) {
    ns <- base::asNamespace("turboGliph")
    penv <- base::new.env(parent = ns)
    base::sys.source(patch, envir = penv)
    g <- base::get("gliph2", envir = penv)
    base::environment(g) <- ns
    return(g)
  }
  cat("[gliph] WARN: /app/gliph2_patched.R not found — using stock gliph2 (narrow partitions may crash)\n")
  turboGliph::gliph2
}
gliph2p <- .load_gliph2()

a <- commandArgs(trailingOnly = TRUE)
IN <- a[1]
OUTDIR <- a[2]
NCORES <- if (length(a) >= 3) as.integer(a[3]) else 1L
# Unique-count above which the +V-gene fast path kicks in.
FAST_THRESHOLD <- if (length(a) >= 4) as.numeric(a[4]) else 600000
# TRBV genes with fewer unique seqs than this are merged into one combined partition (still correct:
# global_vgene = TRUE keeps cross-gene pairs out of it), to avoid a long tail of tiny gliph2 runs.
MIN_PART <- 500L

# Wall-clock timer for the runner's own log lines (turboGliph prints its own per-part cpu times;
# this is the total runner wall time, including the CSV read and the edge-dedup write).
t0 <- Sys.time()
el <- function() as.numeric(difftime(Sys.time(), t0, units = "secs"))

# Peak memory, logged to help calibrate the block's gliph-step mem limit against real datasets.
# Two measures (the runner always runs in a Linux container; both return NA elsewhere):
#   * process peak RSS  — VmHWM in /proc/self/status (kB): this R process's high-water RSS, incl.
#     turboGliph's C/C++ allocations. Misses any forked worker processes.
#   * cgroup peak        — peak memory of the WHOLE container (all processes). This is the number a
#     container mem limit must exceed, so it is the one to size the limit from. cgroup v2 then v1.
peak_rss_gb <- function() {
  st <- tryCatch(readLines("/proc/self/status", warn = FALSE), error = function(e) character(0))
  hwm <- grep("^VmHWM:", st, value = TRUE)
  if (length(hwm) == 0) return(NA_real_)
  as.numeric(gsub("[^0-9]", "", hwm)) / 1024 / 1024
}
cgroup_peak_gb <- function() {
  read_bytes <- function(p) tryCatch(as.numeric(readLines(p, warn = FALSE)[1]),
                                     error = function(e) NA_real_, warning = function(e) NA_real_)
  b <- read_bytes("/sys/fs/cgroup/memory.peak")                                  # cgroup v2 (>=5.19)
  if (is.na(b)) b <- read_bytes("/sys/fs/cgroup/memory/memory.max_usage_in_bytes")  # cgroup v1
  if (is.na(b)) NA_real_ else b / 1024^3
}

# Extract the two CDR3b endpoints of the GLOBAL connections from gliph2()'s in-memory network.
# res$connections is turboGliph's clone_network with columns hardcoded to c("V1","V2","type",
# "cluster_tag") (gliph2_patched.R L1161/L1198); `type` is "global"|"local"|"singleton". We require
# `type` and error if it is absent (e.g. a future turboGliph re-vendor renamed it) rather than
# guessing a column — a wrong guess would match no rows and SILENTLY drop every global edge.
# Returns a 2-col (V1,V2) frame or NULL when there are no global edges.
global_edges_of <- function(conn) {
  if (is.null(conn) || nrow(conn) == 0) return(NULL)
  if (!("type" %in% names(conn))) {
    stop(sprintf("gliph2 connections lack a 'type' column (got: %s) — cannot isolate global edges; turboGliph's contract may have changed",
                 paste(names(conn), collapse = ", ")))
  }
  g <- conn[conn$type == "global", c("V1", "V2"), drop = FALSE]
  if (nrow(g) == 0) NULL else g
}

write_edges <- function(edges) {
  if (is.null(edges) || nrow(edges) == 0) {
    # No similar pairs found: an empty edge list. Leiden then mints a singleton cluster per sequence.
    file.create("clone_edges.txt")
  } else {
    edges <- unique(edges[, c("V1", "V2")])
    write.table(edges, "clone_edges.txt", sep = "\t", quote = FALSE, row.names = FALSE, col.names = FALSE)
  }
}

cat(sprintf("[gliph] started %s\n", format(t0, "%Y-%m-%d %H:%M:%S")))

df <- read.csv(IN, check.names = FALSE, stringsAsFactors = FALSE)
useVGene <- "TRBV" %in% names(df)

cols <- list(CDR3b = as.character(df[["CDR3b"]]))
if (useVGene) {
  cols$TRBV <- as.character(df[["TRBV"]])
}
cdr3 <- as.data.frame(cols, stringsAsFactors = FALSE)
cdr3 <- cdr3[cdr3$CDR3b != "" & !is.na(cdr3$CDR3b), , drop = FALSE]

useFast <- useVGene && nrow(cdr3) > FAST_THRESHOLD
cat(sprintf("[%.1fs] %d unique CDR3b seqs | global_vgene = %s | n_cores = %d | mode = %s\n",
            el(), nrow(cdr3), useVGene, NCORES,
            if (useFast) sprintf("FAST per-V partition, GLOBAL-only (threshold %.0f)", FAST_THRESHOLD)
            else "standard (single run, all edges)"))

if (!useFast) {
  # -------- standard path (original behaviour): one run, ALL connection edges --------
  res <- gliph2p(
    cdr3_sequences = cdr3,
    result_folder = OUTDIR,
    n_cores = NCORES,
    global_vgene = useVGene
  )
  conn <- res[["connections"]]
  if (is.null(conn) || nrow(conn) == 0) {
    file.create("clone_edges.txt")
  } else {
    write_edges(conn)
  }
} else {
  # -------- fast path: partition by full TRBV, GLOBAL-only edges, union --------
  # Partitions run SEQUENTIALLY, each gliph2 using all n_cores. One at a
  # time keeps the code simple and peak memory bounded to a single partition's run.
  cat(sprintf("[per-v-gene] input above %.0f unique sequences — clustering each V gene separately instead of a single GLIPH2 run (global-similarity network only; per-partition local motifs are dropped)\n", FAST_THRESHOLD))
  tab <- table(cdr3$TRBV)
  big <- names(tab)[tab >= MIN_PART]
  cdr3$.part <- ifelse(cdr3$TRBV %in% big, cdr3$TRBV, "__RARE_COMBINED__")
  parts <- split(cdr3, cdr3$.part)
  nparts <- length(parts)
  cat(sprintf("[per-v-gene] %d unique seqs | %d distinct TRBV | %d partitions (>= %d own; rest combined) | largest %d\n",
              nrow(cdr3), length(tab), nparts, MIN_PART, max(vapply(parts, nrow, integer(1)))))

  # Run one partition's gliph2, muffling ONLY turboGliph's benign "Reference database must have more
  # sequences…" warning: it flags that the reference-based significance scoring is unreliable when a
  # partition is larger than the naive reference DB, but that scoring underpins the LOCAL/motif
  # enrichment we discard (we keep GLOBAL edges only). Any other warning still surfaces.
  run_partition <- function(p, od) {
    withCallingHandlers(
      gliph2p(cdr3_sequences = p, result_folder = od, n_cores = NCORES, global_vgene = TRUE),
      warning = function(w) {
        if (grepl("Reference database must have more sequences", conditionMessage(w), fixed = TRUE))
          invokeRestart("muffleWarning")
      }
    )
  }

  acc <- vector("list", nparts)
  i <- 0L
  for (nm in names(parts)) {
    i <- i + 1L
    p <- parts[[nm]][, c("CDR3b", "TRBV"), drop = FALSE]
    od <- file.path(OUTDIR, sprintf("part_%03d", i))
    dir.create(od, recursive = TRUE, showWarnings = FALSE)
    # Suppress turboGliph's verbose per-partition console output (Part 1-4 timings + notifications)
    # for every partition — the per-partition summary line below is enough. capture.output swallows stdout,
    # suppressMessages the notifications; res is assigned in this (global) frame so it survives the
    # capture (edges preserved).
    res <- NULL
    invisible(capture.output(suppressMessages(res <- run_partition(p, od)), type = "output"))
    ge <- global_edges_of(res[["connections"]])
    acc[[i]] <- ge
    cat(sprintf("    part %d/%d %-18s n=%-7d global edges=%d | %.1fs\n",
                i, nparts, nm, nrow(p), if (is.null(ge)) 0L else nrow(ge), el()))
  }
  write_edges(do.call(rbind, acc))
}

cat(sprintf("[gliph] ended %s | %.1fs | peak RSS %.2f GB | cgroup peak %.2f GB | results -> %s | wrote clone_edges.txt (%s edges)\n",
            format(Sys.time(), "%Y-%m-%d %H:%M:%S"), el(), peak_rss_gb(), cgroup_peak_gb(), OUTDIR,
            if (file.exists("clone_edges.txt")) format(length(readLines("clone_edges.txt")), big.mark = ",") else "0"))
