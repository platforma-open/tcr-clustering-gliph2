import type { BlockParams } from "@platforma-open/milaboratories.tcr-clustering.kind";
import type { BlockData } from "./index";

/**
 * What a project template carries out of a configured block — the mirror image of
 * `initBlockData`, and the reason the two must be read together: a field added to the contract
 * but not to this function is silently dropped from every template exported afterwards.
 *
 * The fields `BlockParams` leaves out are left out here for the reasons the contract records:
 * the derived label, the mirrored prerun count, the machine's resource allocation, and view
 * state.
 */
export function deriveTemplateParams(data: BlockData): BlockParams {
  return {
    customBlockLabel: data.customBlockLabel,
    datasetRef: data.datasetRef,
    inputSelection: data.inputSelection,
    resolution: data.resolution,
    consensusThreshold: data.consensusThreshold,
    weightByAbundance: data.weightByAbundance,
  };
}
