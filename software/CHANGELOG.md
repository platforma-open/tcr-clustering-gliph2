# Changelog

## 1.0.2

### Patch Changes

- 380cfb5: Fix all-null cluster abundance columns. `process_results.py` cast `abundance` to Float64 after reading the clone table as text, so the abundance TSVs were written as `24.0`. Those files are re-imported as PColumns whose valueType comes from the input abundance spec (`pl7.app/vdj/readCount` is `Long`) and the import casts non-strictly, so every value silently became null: "Total Number of Reads in Cluster" was empty, and downstream blocks reading the cluster abundance (e.g. Clonotype Distribution) failed on an empty table. Abundance now stays Int64.

## 1.0.1

### Patch Changes

- 05839c8: Release software

## 1.0.0

### Major Changes

- faf3e96: First version

Initial version.
