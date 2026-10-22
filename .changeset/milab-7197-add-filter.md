---
"@platforma-open/milaboratories.tcr-clustering": minor
"@platforma-open/milaboratories.tcr-clustering.kind": minor
"@platforma-open/milaboratories.tcr-clustering.model": minor
"@platforma-open/milaboratories.tcr-clustering.ui": minor
"@platforma-open/milaboratories.tcr-clustering.workflow": minor
---

Update the SDK and accept a subset filter (e.g. a Repertoire Labeling label or Lead Selection picks) with the dataset. The dataset list is built with buildDatasetOptions (requireEnrichments: false). Only the subset's clonotypes are clustered, so clusters, their abundance fractions and the pre-run size check cover the subset and differ from a full-data run. Outputs of a subset run carry pl7.app/inputSubset in their domain and a trace rooted in the subset, so their labels name it. Unfiltered runs are unchanged.
