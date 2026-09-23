# Changelog

## 1.1.1

### Patch Changes

- d771f61: Move to workflow-tengo 6.11.1

## 1.1.0

### Minor Changes

- 97a00b0: Adopt the block-kind contract and the current SDK. The block now declares its
  init params, so a project template can create it pre-configured with the
  dataset, the "Cluster by" selection, the Leiden resolution and the consensus
  settings.

## 1.0.4

### Patch Changes

- 380cfb5: Fix all-null cluster abundance columns. `process_results.py` cast `abundance` to Float64 after reading the clone table as text, so the abundance TSVs were written as `24.0`. Those files are re-imported as PColumns whose valueType comes from the input abundance spec (`pl7.app/vdj/readCount` is `Long`) and the import casts non-strictly, so every value silently became null: "Total Number of Reads in Cluster" was empty, and downstream blocks reading the cluster abundance (e.g. Clonotype Distribution) failed on an empty table. Abundance now stays Int64.

## 1.0.3

### Patch Changes

- 693df67: Rename the block to "GLIPH2 Clustering" (catalog title, in-pipeline title and UI page title) so it names its clustering engine, leaving room for other TCR clustering blocks built on different tools. Adds a `tcr-clustering` tag so the TCR clustering blocks can be filtered as a family in the block catalog, and leads the description with "TCR clustering" so the catalog's substring search still finds the block by that phrase.

## 1.0.2

### Patch Changes

- 05839c8: Release software

## 1.0.1

### Patch Changes

- b36e4fd: SDK Update

## 1.0.0

### Major Changes

- faf3e96: First version

Initial version.
