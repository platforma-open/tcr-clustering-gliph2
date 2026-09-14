import type { PlRef, SUniversalPColumnId } from "@platforma-sdk/model";
import { describe, expect, it } from "vitest";
import { kind } from "@platforma-open/milaboratories.tcr-clustering.kind";
import type { BlockData } from "./index";
import { deriveTemplateParams, initBlockData } from "./index";

/**
 * Export a block's data as a template would, then create a block from it.
 *
 * The `JSON` hop is deliberate: a template is a file, so anything that survives only in memory
 * is not actually carried. What comes back is a fresh block's data, which is what a scientist
 * applying the template gets.
 */
const roundTrip = (data: BlockData): BlockData =>
  initBlockData(
    kind.parseInitializationParams(JSON.parse(JSON.stringify(deriveTemplateParams(data)))),
  );

const DATASET_REF: PlRef = { __isRef: true, blockId: "b1", name: "dataset" };
const SEQ_ID =
  '{"axes":[{"anchor":"main","idx":1}],"domain":{"pl7.app/vdj/feature":"CDR3","pl7.app/alphabet":"aminoacid"},"name":"pl7.app/vdj/sequence"}' as SUniversalPColumnId;
const VGENE_ID =
  '{"axes":[{"anchor":"main","idx":1}],"domain":{"pl7.app/vdj/reference":"VGene"},"name":"pl7.app/vdj/geneHit"}' as SUniversalPColumnId;

/** A fully configured block: every field the contract carries, none of them at its default. */
const configured: BlockData = {
  ...initBlockData(),
  customBlockLabel: "GLIPH2, beta + V",
  datasetRef: DATASET_REF,
  inputSelection: { sequenceRef: SEQ_ID, vGeneRef: VGENE_ID, resolvedVGeneRef: VGENE_ID },
  resolution: 12.5,
  consensusThreshold: 0.85,
  weightByAbundance: true,
};

describe("the template round trip", () => {
  it("carries every field the contract names", () => {
    const restored = roundTrip(configured);
    expect(restored.customBlockLabel).toBe("GLIPH2, beta + V");
    expect(restored.datasetRef).toEqual(DATASET_REF);
    expect(restored.inputSelection).toEqual(configured.inputSelection);
    expect(restored.resolution).toBe(12.5);
    expect(restored.consensusThreshold).toBe(0.85);
    expect(restored.weightByAbundance).toBe(true);
  });

  it("is idempotent — a second pass changes nothing", () => {
    expect(roundTrip(roundTrip(configured))).toEqual(roundTrip(configured));
  });

  it("carries the values a `??` default would swallow", () => {
    const falsy: BlockData = {
      ...configured,
      customBlockLabel: "",
      consensusThreshold: 0,
      weightByAbundance: false,
    };
    const restored = roundTrip(falsy);
    expect(restored.customBlockLabel).toBe("");
    expect(restored.consensusThreshold).toBe(0);
    expect(restored.weightByAbundance).toBe(false);
  });

  it("carries a half-configured block — a dataset chosen but nothing clustered yet", () => {
    const restored = roundTrip({ ...initBlockData(), datasetRef: DATASET_REF });
    expect(restored.datasetRef).toEqual(DATASET_REF);
    expect(restored.inputSelection).toBeUndefined();
    expect(restored.resolution).toBe(1.0);
  });

  it("gives an untouched block back unchanged", () => {
    expect(roundTrip(initBlockData())).toEqual(initBlockData());
  });

  it("does not carry derived, mirrored or view-only fields", () => {
    const restored = roundTrip({
      ...configured,
      lastInputSeqCount: 480_000,
      mem: 64,
      cpu: 16,
    });
    expect(restored.lastInputSeqCount).toBeUndefined();
    expect(restored.mem).toBeUndefined();
    expect(restored.cpu).toBeUndefined();
    // The default label is re-derived from the chosen option's label on mount, so a template
    // carrying it would only ship a value the UI overwrites.
    expect(restored.defaultBlockLabel).toBe("resolution:12.5");
    expect(restored.alignmentModel).toEqual({});
  });
});
