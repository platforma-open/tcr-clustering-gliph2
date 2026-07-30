---
'@platforma-open/milaboratories.tcr-clustering': patch
'@platforma-open/milaboratories.tcr-clustering.model': patch
'@platforma-open/milaboratories.tcr-clustering.ui': patch
---

Rename the block to "GLIPH2 Clustering" (catalog title, in-pipeline title and UI page title) so it names its clustering engine, leaving room for other TCR clustering blocks built on different tools. Adds a `tcr-clustering` tag so the TCR clustering blocks can be filtered as a family in the block catalog, and leads the description with "TCR clustering" so the catalog's substring search still finds the block by that phrase.
