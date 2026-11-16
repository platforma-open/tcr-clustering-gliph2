# @platforma-open/milaboratories.tcr-clustering.kind

## 1.1.1

### Patch Changes

- ba30c72: Bump the kind version. A comment in the kind source changed without a version bump. The registry keeps a published kind version immutable by source hash, so republishing 1.1.0 with different content failed and blocked the block release.

## 1.1.0

### Minor Changes

- a8dd9c1: Update the SDK and accept a subset filter (e.g. a Repertoire Labeling label or Lead Selection picks) with the dataset. The dataset list is built with buildDatasetOptions (requireEnrichments: false). Only the subset's clonotypes are clustered, so clusters, their abundance fractions and the pre-run size check cover the subset and differ from a full-data run. Outputs of a subset run carry pl7.app/inputSubset in their domain and a trace rooted in the subset, so their labels name it. Unfiltered runs are unchanged.
