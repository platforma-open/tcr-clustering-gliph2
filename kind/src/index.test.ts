import type { PlRef, SUniversalPColumnId } from "@platforma-sdk/model";
import { describe, expect, it } from "vitest";
import { kind } from "./index";

const parse = (v: unknown) => kind.parseInitializationParams(v);

/**
 * A "Cluster by" option's value, as the model writes it: `getCanonicalOptions` is anchored on the
 * dataset, so its ids are the *anchored* form — the one `isColumnUniversalId` does not recognize.
 * A kind that refused this would refuse every id this block itself produces, and applying a
 * template exported from the block would fail. Anything that stops this test passing has broken
 * the export/apply round trip.
 */
const ANCHORED_ID =
  '{"axes":[{"anchor":"main","idx":1}],"domain":{"pl7.app/vdj/feature":"CDR3","pl7.app/alphabet":"aminoacid"},"name":"pl7.app/vdj/sequence"}' as SUniversalPColumnId;

/** A global reference key — the other form a column id serializes to. */
const GLOBAL_ID =
  '{"__isRef":true,"blockId":"b1","name":"pl7.app/vdj/sequence"}' as SUniversalPColumnId;

const DATASET_REF: PlRef = { __isRef: true, blockId: "b1", name: "dataset" };

describe("the envelope", () => {
  it("accepts an empty object — a block may be created with nothing pinned", () => {
    expect(parse({})).toEqual({});
  });

  it.each([undefined, null, 42, "params", [], true])("refuses %o as a params object", (v) => {
    expect(() => parse(v)).toThrow();
  });

  it("drops keys the contract does not name", () => {
    expect(parse({ resolution: 2, mem: 64, tableState: {} })).toEqual({ resolution: 2 });
  });
});

describe("datasetRef", () => {
  it("accepts a reference", () => {
    expect(parse({ datasetRef: DATASET_REF })).toEqual({ datasetRef: DATASET_REF });
  });

  it.each([{ blockId: "b1", name: "dataset" }, "b1/dataset", 7, {}])("refuses %o", (v) => {
    expect(() => parse({ datasetRef: v })).toThrow("'datasetRef' must be");
  });
});

describe("inputSelection", () => {
  it("accepts an anchored sequence id on its own", () => {
    const selection = { sequenceRef: ANCHORED_ID };
    expect(parse({ inputSelection: selection })).toEqual({ inputSelection: selection });
  });

  it("accepts a global reference key", () => {
    const selection = { sequenceRef: GLOBAL_ID };
    expect(parse({ inputSelection: selection })).toEqual({ inputSelection: selection });
  });

  it("accepts a full '+ V gene' selection", () => {
    const selection = {
      sequenceRef: ANCHORED_ID,
      vGeneRef: ANCHORED_ID,
      resolvedVGeneRef: ANCHORED_ID,
    };
    expect(parse({ inputSelection: selection })).toEqual({ inputSelection: selection });
  });

  it("refuses a selection with no sequence column — nothing to cluster", () => {
    expect(() => parse({ inputSelection: { vGeneRef: ANCHORED_ID } })).toThrow(
      "'inputSelection' must be",
    );
  });

  it.each([
    ["a non-JSON sequence id", { sequenceRef: "beta-cdr3" }],
    ["a JSON sequence id of no known form", { sequenceRef: '{"foo":1}' }],
    ["a non-string sequence id", { sequenceRef: 7 }],
    ["a bad V-gene id", { sequenceRef: ANCHORED_ID, vGeneRef: "vgene" }],
    ["a bad resolved V-gene id", { sequenceRef: ANCHORED_ID, resolvedVGeneRef: "vgene" }],
  ])("refuses %s", (_label, selection) => {
    expect(() => parse({ inputSelection: selection })).toThrow("'inputSelection' must be");
  });

  it.each([null, "selection", 7, []])("refuses %o as a selection", (v) => {
    expect(() => parse({ inputSelection: v })).toThrow("'inputSelection' must be");
  });
});

describe("resolution", () => {
  it.each([0.1, 1, 1.5, 20, 100])("accepts %o, which the settings panel offers", (v) => {
    expect(parse({ resolution: v })).toEqual({ resolution: v });
  });

  it.each([0, 0.09, 100.1, 1000, -1, Number.NaN, "1.0", null])("refuses %o", (v) => {
    expect(() => parse({ resolution: v })).toThrow("'resolution' must be");
  });
});

describe("consensusThreshold", () => {
  it.each([0, 0.6, 1])("accepts %o", (v) => {
    expect(parse({ consensusThreshold: v })).toEqual({ consensusThreshold: v });
  });

  it.each([-0.01, 1.01, Number.NaN, "0.6"])("refuses %o", (v) => {
    expect(() => parse({ consensusThreshold: v })).toThrow("'consensusThreshold' must be");
  });
});

describe("the remaining knobs", () => {
  it("accepts weightByAbundance either way", () => {
    expect(parse({ weightByAbundance: true })).toEqual({ weightByAbundance: true });
    expect(parse({ weightByAbundance: false })).toEqual({ weightByAbundance: false });
  });

  it.each(["true", 1, null])("refuses %o as weightByAbundance", (v) => {
    expect(() => parse({ weightByAbundance: v })).toThrow("'weightByAbundance' must be");
  });

  it("accepts a custom label, empty string included", () => {
    expect(parse({ customBlockLabel: "" })).toEqual({ customBlockLabel: "" });
    expect(parse({ customBlockLabel: "run 4" })).toEqual({ customBlockLabel: "run 4" });
  });

  it.each([7, null, {}])("refuses %o as a custom label", (v) => {
    expect(() => parse({ customBlockLabel: v })).toThrow("'customBlockLabel' must be");
  });
});

describe("identity", () => {
  it("names this package and its published version", () => {
    expect(kind.name).toBe("@platforma-open/milaboratories.tcr-clustering.kind");
    expect(kind.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
