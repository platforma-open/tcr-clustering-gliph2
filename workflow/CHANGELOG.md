# Changelog

## 1.2.0

### Minor Changes

- a8dd9c1: Update the SDK and accept a subset filter (e.g. a Repertoire Labeling label or Lead Selection picks) with the dataset. The dataset list is built with buildDatasetOptions (requireEnrichments: false). Only the subset's clonotypes are clustered, so clusters, their abundance fractions and the pre-run size check cover the subset and differ from a full-data run. Outputs of a subset run carry pl7.app/inputSubset in their domain and a trace rooted in the subset, so their labels name it. Unfiltered runs are unchanged.

### Patch Changes

- Updated dependencies [f98e098]
  - @platforma-open/milaboratories.tcr-clustering.gliph-runner@1.0.3

## 1.0.4

### Patch Changes

- 86e784b: Release every package through npm trusted publishing (OIDC) so each package's trusted publisher is used before it expires.
- Updated dependencies [86e784b]
  - @platforma-open/milaboratories.tcr-clustering.gliph-runner@1.0.2
  - @platforma-open/milaboratories.tcr-clustering.software@1.0.3

## 1.0.3

### Patch Changes

- Updated dependencies [380cfb5]
  - @platforma-open/milaboratories.tcr-clustering.software@1.0.2

## 1.0.2

### Patch Changes

- 05839c8: Release software
- Updated dependencies [05839c8]
  - @platforma-open/milaboratories.tcr-clustering.gliph-runner@1.0.1
  - @platforma-open/milaboratories.tcr-clustering.software@1.0.1

## 1.0.1

### Patch Changes

- b36e4fd: SDK Update

## 1.0.0

### Major Changes

- faf3e96: First version

### Patch Changes

- Updated dependencies [faf3e96]
  - @platforma-open/milaboratories.tcr-clustering.gliph-runner@1.0.0
  - @platforma-open/milaboratories.tcr-clustering.software@1.0.0

Initial version.
