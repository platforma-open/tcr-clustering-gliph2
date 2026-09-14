import { assertParamsObject, defineBlockKind } from "@platforma-sdk/block-kind";
import type { PlRef, SUniversalPColumnId } from "@platforma-sdk/model";
import {
  isAnchoredPColumnId,
  isColumnUniversalId,
  isPlRef,
  parseJsonSafely,
} from "@platforma-sdk/model";
import { isBoolean, isPlainObject, isString, isUndefined } from "es-toolkit";
import { isNumber } from "es-toolkit/compat";
import { name, version } from "../package.json" with { type: "json" };

/**
 * The "Cluster by" selection, snapshotted from the chosen dropdown option (the model.md
 * snapshot pattern: `.args` is data-only, but the option refs come from the result pool, so
 * the UI writes the resolved selection into `data` on the user's dropdown gesture).
 * Single-chain only — β or α, whichever column `sequenceRef` points at.
 *
 * Declared here rather than in the model because the params contract carries it, and a
 * contract cannot reference a type the kind does not own; the model re-exports it.
 */
export type InputSelection = {
  sequenceRef: SUniversalPColumnId;
  /** The V-gene column clustering keys on — set only for a "+ V gene" option. */
  vGeneRef?: SUniversalPColumnId;
  /** The chain's single V-gene column, resolved for every selection; used by the prerun only. */
  resolvedVGeneRef?: SUniversalPColumnId;
};

/**
 * This block's init-params contract — what a creator or a project template supplies to seed a
 * new instance: the input it points at, the analysis recipe, and the user's own label.
 *
 * Excluded on purpose:
 *   * `defaultBlockLabel` — derived from the chosen option's label and the resolution, and
 *     rewritten by a `watchEffect` the moment the UI mounts. A template value for it would be
 *     overwritten before anyone could read it. Only the scientist's own `customBlockLabel` is
 *     worth restoring.
 *   * `lastInputSeqCount` — the prerun's sequence count, mirrored into `data` so the args
 *     lambda (which sees no outputs) can hold Run until the size check lands. It describes the
 *     input, not a choice, and a carried value would briefly unblock Run on stale numbers.
 *   * `mem` / `cpu` — resource allocation belongs to the machine a block runs on, not to
 *     configuration a template carries between machines.
 *   * `tableState`, `alignmentModel`, `graphStateBubble`, `graphStateHistogram` — view state.
 *
 * Every field is optional: a block may be created without a template, and a template need not
 * set all of them.
 */
export type BlockParams = {
  customBlockLabel?: string;
  /** The clustered dataset. `inputSelection`'s ids are anchored to it, so the two travel together. */
  datasetRef?: PlRef;
  inputSelection?: InputSelection;
  resolution?: number;
  consensusThreshold?: number;
  weightByAbundance?: boolean;
};

/**
 * The contract at runtime, for params arriving from a template file rather than typed code. An
 * absent field is always allowed — every param is optional and the block's own default takes
 * over — so each guard runs only on what is present. Keys the contract does not name are dropped
 * by never being read.
 */
function parseInitializationParams(value: unknown): BlockParams {
  assertParamsObject(value);

  const params: Record<string, unknown> = {};
  for (const [field, { is, must }] of Object.entries(CONTRACT)) {
    const v = value[field];
    if (v === undefined) continue;
    if (!is(v)) throw new Error(`'${field}' must be ${must}.`);
    params[field] = v;
  }
  return params as BlockParams;
}

// Identity (`name`/`version`) comes from this package's own `package.json`, so the on-wire
// `{name}@{version}` reference can never drift from what npm publishes; the bundler inlines the
// JSON import.
export const kind = defineBlockKind<BlockParams>({
  name,
  version,
  parseInitializationParams,
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Guard<T> = (v: unknown) => v is T;

/** A guard plus how to finish the sentence "'field' must be …". */
type Check<T> = { is: Guard<T>; must: string };

function check<T>(is: Guard<T>, must: string): Check<T> {
  return { is, must };
}

/**
 * A number within the inclusive bounds both the settings panel and the args lambda enforce, so
 * the kind refuses exactly what the block refuses and nothing more.
 */
function isNumberWithin(min: number, max: number): Guard<number> {
  return (v): v is number => isNumber(v) && v >= min && v <= max;
}

/**
 * A column identifier in either form the SDK types `SUniversalPColumnId`. `isColumnUniversalId`
 * covers the key forms the id encoding uses, but the "Cluster by" options come from
 * `getCanonicalOptions` anchored on the dataset, whose values are *anchored* ids — a shape it
 * does not recognize. Both are accepted, or the kind would refuse the very ids this block writes
 * into a template.
 */
const isColumnId: Guard<SUniversalPColumnId> = (v): v is SUniversalPColumnId =>
  isString(v) && (isColumnUniversalId(v) || isAnchoredPColumnId(parseJsonSafely(v)));

/**
 * The UI writes the whole selection in one gesture — the option's `value` is the JSON-encoded
 * selection — so a half-filled one is not a state the block can reach, and a selection without
 * `sequenceRef` would land as a block that cannot resolve what to cluster.
 */
const isInputSelection: Guard<InputSelection> = (v): v is InputSelection =>
  isPlainObject(v) &&
  isColumnId(v.sequenceRef) &&
  (isUndefined(v.vGeneRef) || isColumnId(v.vGeneRef)) &&
  (isUndefined(v.resolvedVGeneRef) || isColumnId(v.resolvedVGeneRef));

/**
 * The runtime half of the contract. The `satisfies` clause is what stops it drifting: every
 * field `BlockParams` declares must appear here, and each guard must narrow to that field's own
 * type — so adding a param without a check stops compiling.
 */
const CONTRACT = {
  customBlockLabel: check(isString, "a string"),
  datasetRef: check(isPlRef, "a reference to an input dataset"),
  inputSelection: check(
    isInputSelection,
    "an object with a sequence column identifier, optionally with V-gene column identifiers",
  ),
  resolution: check(isNumberWithin(0.1, 100), "a number between 0.1 and 100"),
  consensusThreshold: check(isNumberWithin(0, 1), "a number between 0 and 1"),
  weightByAbundance: check(isBoolean, "a boolean"),
} satisfies { [K in keyof Required<BlockParams>]: Check<NonNullable<BlockParams[K]>> };
