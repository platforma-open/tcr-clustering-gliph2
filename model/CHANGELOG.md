# Changelog

## 1.2.0

### Minor Changes

- a8dd9c1: Update the SDK and accept a subset filter (e.g. a Repertoire Labeling label or Lead Selection picks) with the dataset. The dataset list is built with buildDatasetOptions (requireEnrichments: false). Only the subset's clonotypes are clustered, so clusters, their abundance fractions and the pre-run size check cover the subset and differ from a full-data run. Outputs of a subset run carry pl7.app/inputSubset in their domain and a trace rooted in the subset, so their labels name it. Unfiltered runs are unchanged.

### Patch Changes

- Updated dependencies [a8dd9c1]
  - @platforma-open/milaboratories.tcr-clustering.kind@1.1.0

## 1.0.3

### Patch Changes

- 86e784b: Release every package through npm trusted publishing (OIDC) so each package's trusted publisher is used before it expires.

## 1.0.2

### Patch Changes

- 693df67: Rename the block to "GLIPH2 Clustering" (catalog title, in-pipeline title and UI page title) so it names its clustering engine, leaving room for other TCR clustering blocks built on different tools. Adds a `tcr-clustering` tag so the TCR clustering blocks can be filtered as a family in the block catalog, and leads the description with "TCR clustering" so the catalog's substring search still finds the block by that phrase.

## 1.0.1

### Patch Changes

- b36e4fd: SDK Update

## 1.0.0

### Major Changes

- faf3e96: First version

Initial version.
