import {
  findClusterByOption,
  getDefaultBlockLabel,
  platforma,
} from "@platforma-open/milaboratories.tcr-clustering.model";
import { defineAppV3 } from "@platforma-sdk/ui-vue";
import { watch, watchEffect } from "vue";
import BubblePlotPage from "./pages/BubblePlotPage.vue";
import MainPage from "./pages/MainPage.vue";
import HistogramPage from "./pages/HistogramPage.vue";

export const sdkPlugin = defineAppV3(platforma, (app) => {
  app.model.data.customBlockLabel ??= "";

  syncDefaultBlockLabel(app.model);
  syncPrerunSizeCount(app.model);

  return {
    progress: () => {
      return app.model.outputs.isRunning;
    },
    routes: {
      "/": () => MainPage,
      "/bubble": () => BubblePlotPage,
      "/histogram": () => HistogramPage,
    },
  };
});

export const useApp = sdkPlugin.useApp;

type AppModel = ReturnType<typeof useApp>["model"];

function syncDefaultBlockLabel(model: AppModel) {
  // Tolerated block-label hairpin (see harness hairpin.md): derive the default label from the
  // chosen "Cluster by" option label + the Leiden resolution, unless the user set a custom label.
  watchEffect(() => {
    const inputLabel =
      findClusterByOption(model.outputs.clusterByOptions, model.data.inputSelection)?.label ?? "";
    model.data.defaultBlockLabel = getDefaultBlockLabel({
      inputLabel,
      resolution: model.data.resolution,
    });
  });
}

function syncPrerunSizeCount(model: AppModel) {
  // Mirror the staging prerun's sequence count (outputs.inputSeqCount) into data so the model's
  // `.args()` — which sees only `data`, not outputs — can block Run until the pre-flight size check
  // completes (it throws "Checking dataset size…" while `lastInputSeqCount` is undefined).
  watchEffect(() => {
    const c = model.outputs.inputSeqCount;
    if (c !== model.data.lastInputSeqCount) model.data.lastInputSeqCount = c;
  });
  // Stale guard: on any input change, clear the cached count so a previous value can't briefly
  // unblock Run before the new prerun refills it. Watch primitives (not the ref objects) so a data
  // object-swap on a server patch doesn't spuriously clear it.
  watch(
    () => [
      model.data.datasetRef?.name,
      model.data.datasetRef?.blockId,
      model.data.inputSelection?.sequenceRef,
    ],
    () => {
      model.data.lastInputSeqCount = undefined;
    },
  );
}
