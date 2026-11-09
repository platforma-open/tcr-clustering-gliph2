---
"@platforma-open/milaboratories.tcr-clustering.model": patch
"@platforma-open/milaboratories.tcr-clustering.ui": patch
"@platforma-open/milaboratories.tcr-clustering.workflow": patch
---

Compute the block label without the UI

The trace label is now built by the workflow from the block name, the native label of the
chosen CDR3 column ("+ V gene" when clustering keys on the V gene) and the Leiden resolution,
so opening the block no longer changes its arguments and a block that was never opened still
gets a meaningful label. The subtitle shows the result-pool label of the chosen "Cluster by"
option, refreshed when the user picks it. Existing blocks show stale once after the update.
