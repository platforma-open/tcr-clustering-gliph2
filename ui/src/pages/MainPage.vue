<script setup lang="ts">
import { PlMultiSequenceAlignment } from "@milaboratories/multi-sequence-alignment";
import strings from "@milaboratories/strings";
import {
  VGENE_FASTPATH_THRESHOLD,
  VGENE_PARTITION_WARN_THRESHOLD,
} from "@platforma-open/milaboratories.tcr-clustering.model";
import type {
  AxisId,
  PColumnPredicate,
  PlRef,
  PlSelectionModel,
  PTableKey,
} from "@platforma-sdk/model";
import {
  PlAccordionSection,
  PlAgDataTableV2,
  PlAlert,
  PlBlockPage,
  PlBtnGhost,
  PlBtnGroup,
  PlDropdown,
  PlDropdownRef,
  PlLogView,
  PlMaskIcon24,
  PlNumberField,
  PlSectionSeparator,
  PlSlideModal,
  PlTabs,
  usePlDataTableSettingsV2,
} from "@platforma-sdk/ui-vue";
import { computed, reactive, ref, watch } from "vue";
import { useApp } from "../app";

const app = useApp();

const multipleSequenceAlignmentOpen = ref(false);
const clusteringLogOpen = ref(false);
// Clustering Log tabs: GLIPH2 network build (cached) vs the Leiden partition (re-runs per resolution).
const clusteringLogTab = ref<"gliph" | "leiden">("gliph");
const clusteringLogTabOptions = [
  { label: "GLIPH2", value: "gliph" as const },
  { label: "Leiden", value: "leiden" as const },
];
// α-warning visibility — PlAlert's close button is controlled, so it needs a v-model ref to hide.
const alphaWarningOpen = ref(true);
// Large-input warning visibility — same controlled-close pattern as the α-warning.
const largeInputWarningOpen = ref(true);
// Large-V-gene-partition warning visibility — same controlled-close pattern.
const vGeneWarningOpen = ref(true);
const settingsOpen = ref(
  app.model.data.datasetRef === undefined || app.model.data.inputSelection === undefined,
);

// Close settings once the run starts.
watch(
  () => app.model.outputs.isRunning,
  (isRunning) => {
    if (isRunning) settingsOpen.value = false;
  },
);

// MSA selection — the clusterId axis of a clicked row.
const selection = ref<PlSelectionModel>({ axesSpec: [], selectedKeys: [] });
const onRowClicked = reactive((key?: PTableKey) => {
  if (key) {
    const clusterSpec = app.model.outputs.clusterAbundanceSpec;
    if (clusterSpec === undefined) return;
    selection.value = { axesSpec: [clusterSpec.axesSpec[1]], selectedKeys: [key] };
  }
  multipleSequenceAlignmentOpen.value = true;
});

function setInput(inputRef?: PlRef) {
  app.model.data.datasetRef = inputRef;
  // The "Cluster by" choice is scoped to a dataset — clear it when the dataset changes so the
  // user re-picks against the new options (and we never carry an unresolvable ref into the run).
  app.model.data.inputSelection = undefined;
}

// "Cluster by" dropdown <-> data.inputSelection (snapshot pattern). The option value is the
// JSON-encoded InputSelection; on change we parse it back into data.inputSelection.
const clusterBy = computed(() =>
  app.model.data.inputSelection ? JSON.stringify(app.model.data.inputSelection) : undefined,
);
function onClusterByChange(value?: string) {
  app.model.data.inputSelection = value ? JSON.parse(value) : undefined;
}

// Chain of the current selection ("alpha"/"beta"), for the α-clustering warning. Computed
// CLIENT-SIDE from already-loaded option labels so the warning appears instantly — a model output
// would wait a backend round-trip (noticeably slow on a remote server). Single-cell: the "Cluster
// by" option label names the chain ("Alpha CDR3 aa"). Bulk: that label is generic ("CDR3 aa"), so
// the chain comes from the chain-specific dataset label ("TCR Alpha" vs single-cell "TCR Alpha/Beta").
const selectedChain = computed<"alpha" | "beta" | undefined>(() => {
  if (!app.model.data.inputSelection) return undefined;
  const cbLabel =
    app.model.outputs.clusterByOptions?.find((o) => o.value === clusterBy.value)?.label ?? "";
  if (/^\s*alpha\b/i.test(cbLabel)) return "alpha";
  if (/^\s*beta\b/i.test(cbLabel)) return "beta";
  const dsRef = app.model.data.datasetRef;
  const dsLabel = dsRef
    ? (app.model.outputs.datasetOptions?.find(
        (o) => o.ref.blockId === dsRef.blockId && o.ref.name === dsRef.name,
      )?.label ?? "")
    : "";
  if (dsLabel.includes("/")) return undefined; // e.g. single-cell "TCR Alpha/Beta" (chain set above)
  if (/\balpha\b/i.test(dsLabel)) return "alpha";
  if (/\bbeta\b/i.test(dsLabel)) return "beta";
  return undefined;
});

// Warn when a CDR3-only selection (no "+ V gene") is large enough that GLIPH2's global step is
// intractable. The count comes from the staging prerun (outputs.inputSeqCount), so it appears before
// Run. Only CDR3-only selections are flagged — the "+ V gene" options engage the fast path.
const largeCdr3OnlyInput = computed(() => {
  const sel = app.model.data.inputSelection;
  if (!sel || sel.vGeneRef !== undefined) return false;
  return (app.model.outputs.inputSeqCount ?? 0) > VGENE_FASTPATH_THRESHOLD;
});

// Warn when a single V-gene partition is so large that even the per-V-gene fast path is intractable —
// GLIPH2 clusters each V gene on its own (per-partition global step ~O(n^1.8-2.8) in that group's
// unique CDR3 count). The prerun sizes the largest V-gene partition for ANY selection (the V-gene
// column is resolved from the CDR3 chain), so this fires in both CDR3-only and "+ V gene" mode.
const largeVGenePartition = computed(() => {
  if (app.model.data.inputSelection === undefined) return false;
  return (app.model.outputs.maxVGeneSeqCount ?? 0) > VGENE_PARTITION_WARN_THRESHOLD;
});

// Staging size check in flight: inputs are picked but the prerun count hasn't landed yet. Run is
// blocked meanwhile (model `.args()` throws), so surface a visible message explaining the wait —
// the args-error itself isn't shown in this block's layout.
const checkingSize = computed(
  () =>
    app.model.data.inputSelection !== undefined && app.model.outputs.inputSeqCount === undefined,
);

// Self-heal a stale selection: if the options reload and the stored selection is no longer offered
// (dataset/upstream changed), clear it. Watch the OUTPUT (not data) — the SDK swaps the whole data
// object on server patches, which would make a data watcher clobber concurrent writes.
watch(
  () => app.model.outputs.clusterByOptions,
  (options) => {
    if (!options || options.length === 0) return;
    const cur = clusterBy.value;
    if (cur && !options.some((o) => o.value === cur)) {
      app.model.data.inputSelection = undefined;
    }
  },
  { immediate: true },
);

const tableSettings = usePlDataTableSettingsV2({
  model: () => app.model.outputs.clustersTable,
});

const centroidWeightingOptions = [
  { label: "Equal weight", value: false },
  { label: "By abundance", value: true },
];

// MSA "Sequence Columns": offer every clustering-candidate sequence, and pre-select only the
// chain(s) actually chosen for clustering. Hide what can't be a clustering input — cluster
// centroids (they live on the clusterId axis), nucleotide columns, and non-primary single-cell
// chains — so the dropdown matches the "Cluster by" options.
const isSequenceColumn: PColumnPredicate = (column) => {
  const spec = column.spec;
  if (!spec) return false;
  if (
    spec.name === "pl7.app/vdj/sequenceLength" ||
    spec.name === "pl7.app/sequenceLength" ||
    spec.name === "pl7.app/vdj/sequence/annotation"
  )
    return false;
  const axis0 = spec.axesSpec?.[0]?.name;
  if (axis0 === "pl7.app/clusterId") return false; // theoretical / reference centroids
  if (spec.domain?.["pl7.app/alphabet"] !== "aminoacid") return false; // amino-acid only (drops nt)
  if (axis0 === "pl7.app/vdj/scClonotypeKey") {
    const idx = spec.domain?.["pl7.app/vdj/scClonotypeChain/index"];
    if (idx !== undefined && idx !== "primary") return false; // primary chains only
  }
  // Available; default-select only the chain(s) chosen for clustering.
  const sel = app.model.data.inputSelection;
  const selected = sel ? [sel.sequenceRef] : [];
  return { default: selected.some((r) => r === column.columnId) };
};

// Cluster axis for the table's per-row cell button (opens the MSA).
const clusterAxis = computed<AxisId>(() => ({
  type: "String",
  name: "pl7.app/clusterId",
  domain: app.model.outputs.clusterAbundanceSpec?.axesSpec[1].domain ?? {},
}));
</script>

<template>
  <PlBlockPage
    v-model:subtitle="app.model.data.customBlockLabel"
    :subtitle-placeholder="app.model.data.defaultBlockLabel"
    title="GLIPH2 Clustering"
  >
    <template #append>
      <PlBtnGhost @click.stop="() => (clusteringLogOpen = true)">
        {{ strings.titles.logs }}
        <template #append><PlMaskIcon24 name="file-logs" /></template>
      </PlBtnGhost>
      <PlBtnGhost @click.stop="() => (settingsOpen = true)">
        {{ strings.titles.settings }}
        <template #append><PlMaskIcon24 name="settings" /></template>
      </PlBtnGhost>
    </template>

    <PlAgDataTableV2
      v-model="app.model.data.tableState"
      :settings="tableSettings"
      :not-ready-text="strings.callToActions.configureSettingsAndRun"
      :no-rows-text="strings.states.noDataAvailable"
      :show-cell-button-for-axis-id="clusterAxis"
      @cell-button-clicked="onRowClicked"
    />

    <PlSlideModal v-model="settingsOpen" close-on-outside-click shadow>
      <template #title>{{ strings.titles.settings }}</template>

      <PlDropdownRef
        v-model="app.model.data.datasetRef"
        :options="app.model.outputs.datasetOptions"
        :label="strings.titles.dataset"
        clearable
        required
        @update:model-value="setInput"
      />

      <PlDropdown
        :model-value="clusterBy"
        :options="app.model.outputs.clusterByOptions ?? []"
        label="Cluster by"
        required
        :disabled="app.model.data.datasetRef === undefined"
        @update:model-value="onClusterByChange"
      >
        <template #tooltip>
          What to cluster on.<br />
          <b>CDR3</b> clusters on the CDR3 amino-acid sequence (GLIPH2 similarity network).<br />
          <b>+ V gene</b> additionally requires a shared V gene to link CDR3s by similarity.
        </template>
      </PlDropdown>

      <PlAlert v-if="checkingSize" type="info" style="margin-top: 0.5rem">
        Checking dataset size before you run. This can take a moment, please wait...
      </PlAlert>

      <PlAlert
        v-if="selectedChain === 'alpha'"
        v-model="alphaWarningOpen"
        type="warn"
        style="margin-top: 0.5rem"
        closeable
      >
        <b>TCR α is less reliable for specificity clustering.</b> GLIPH2 is built for the β chain —
        its motif reference is β-derived (so α motif grouping isn't calibrated), and α carries a
        weaker antigen-specificity signal. Prefer β where possible and interpret α clusters with
        caution.
      </PlAlert>

      <PlAlert
        v-if="largeCdr3OnlyInput && !largeVGenePartition"
        v-model="largeInputWarningOpen"
        type="warn"
        :closeable="true"
      >
        <b>Large input.</b> This dataset has
        {{ app.model.outputs.inputSeqCount?.toLocaleString() }} unique sequences. GLIPH2's CDR3-only
        clustering at this scale can take from hours to days (and may run out of memory). Choose a
        <b>+ V gene</b> option above — it runs a faster per-V-gene path that stays tractable at this
        size.
      </PlAlert>

      <PlAlert v-if="largeVGenePartition" v-model="vGeneWarningOpen" type="warn" :closeable="true">
        <b>Very large V gene.</b> Do not cluster by CDR3 alone. A single V gene in this dataset has
        {{ app.model.outputs.maxVGeneSeqCount?.toLocaleString() }} sequences. Even with the
        per-V-gene fast path this one group can make the whole run take a very long time —
        potentially days.
      </PlAlert>

      <PlSectionSeparator>Centroid</PlSectionSeparator>
      <PlBtnGroup
        :model-value="app.model.data.weightByAbundance ?? false"
        label="Residue Weighting"
        :options="centroidWeightingOptions"
        compact
        @update:model-value="app.model.data.weightByAbundance = $event"
      >
        <template #tooltip>
          How each clonotype votes for the consensus residue at every alignment column (and in the
          distance / reference centroid measured against it). <b>Equal weight</b> — every clonotype
          counts once; ties break deterministically. <b>By abundance</b> — weighted by summed
          abundance, so expanded clones dominate.
        </template>
      </PlBtnGroup>
      <PlNumberField
        v-model="app.model.data.consensusThreshold"
        label="Consensus Threshold"
        :minValue="0"
        :step="0.05"
        :maxValue="1.0"
      >
        <template #tooltip>
          Minimum fraction of an alignment column's vote the winning residue must reach for the
          theoretical centroid to emit it; below the threshold the position emits <b>X</b>. The
          reference centroid (closest real member) is always reported alongside it.
        </template>
      </PlNumberField>

      <PlAlert v-if="app.model.outputs.inputState" type="warn" style="margin-top: 1rem">
        {{ "Error: the selected dataset is empty. Please choose a different dataset." }}
      </PlAlert>

      <PlAccordionSection :label="strings.titles.advancedSettings">
        <PlNumberField
          v-model="app.model.data.resolution"
          label="Leiden resolution"
          :minValue="0.1"
          :step="0.5"
          :maxValue="100"
        >
          <template #tooltip>
            Clustering granularity. Higher = finer (more, smaller clusters), splitting over-merged
            groups; lower = coarser. Recommended 1–20; default 1.
          </template>
        </PlNumberField>

        <PlSectionSeparator>Resource Allocation</PlSectionSeparator>
        <PlNumberField
          v-model="app.model.data.mem"
          label="Memory (GiB)"
          :minValue="1"
          :step="1"
          :maxValue="1012"
        >
          <template #tooltip>Memory to allocate for the clustering step.</template>
        </PlNumberField>
        <PlNumberField
          v-model="app.model.data.cpu"
          label="CPU (cores)"
          :minValue="1"
          :step="1"
          :maxValue="128"
        >
          <template #tooltip>
            CPU cores for the GLIPH2 network-build step — the compute-heavy stage. Other steps run
            at fixed CPU allocations.
          </template>
        </PlNumberField>
      </PlAccordionSection>
    </PlSlideModal>
  </PlBlockPage>

  <!-- MSA viewer -->
  <PlSlideModal
    v-model="multipleSequenceAlignmentOpen"
    width="100%"
    :close-on-outside-click="false"
  >
    <template #title>{{ strings.titles.multipleSequenceAlignment }}</template>
    <PlMultiSequenceAlignment
      v-if="app.model.outputs.inputState === false"
      v-model="app.model.data.alignmentModel"
      :sequence-column-predicate="isSequenceColumn"
      :p-frame="app.model.outputs.msaPf"
      :selection="selection"
    />
  </PlSlideModal>

  <!-- Clustering log: GLIPH2 network build + Leiden partition, one tab each -->
  <PlSlideModal v-model="clusteringLogOpen" width="80%">
    <template #title>Clustering Log</template>
    <PlTabs v-model="clusteringLogTab" :options="clusteringLogTabOptions" />
    <PlLogView v-if="clusteringLogTab === 'gliph'" :log-handle="app.model.outputs.gliphOutput" />
    <PlLogView v-else :log-handle="app.model.outputs.leidenOutput" />
  </PlSlideModal>
</template>
