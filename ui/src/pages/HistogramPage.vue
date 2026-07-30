<script setup lang="ts">
import type { PredefinedGraphOption } from "@milaboratories/graph-maker";
import { GraphMaker } from "@milaboratories/graph-maker";
import strings from "@milaboratories/strings";
import type { PColumnIdAndSpec } from "@platforma-sdk/model";
import { PlBlockPage } from "@platforma-sdk/ui-vue";
import { computed } from "vue";
import { useApp } from "../app";

const app = useApp();

// if there is no output or abundance spec, return undefined
const defaultOptions = computed((): PredefinedGraphOption<"histogram">[] | undefined => {
  if (!app.model.outputs.clustersPfPcols) return undefined;

  const histPcols = app.model.outputs.clustersPfPcols;
  function getIndex(name: string, pcols: PColumnIdAndSpec[]): number {
    return pcols.findIndex((p) => p.spec.name === name);
  }
  const defaults: PredefinedGraphOption<"histogram">[] = [
    {
      inputName: "value",
      selectedSource: histPcols[getIndex("pl7.app/clustering/clusterSize", histPcols)].spec,
    },
  ];
  return defaults;
});
</script>

<template>
  <PlBlockPage no-body-gutters>
    <GraphMaker
      v-model="app.model.data.graphStateHistogram"
      chartType="histogram"
      :data-state-key="app.model.outputs.clustersPf"
      :p-frame="app.model.outputs.clustersPf"
      :default-options="defaultOptions"
      :status-text="{ noPframe: { title: strings.callToActions.configureSettingsAndRun } }"
    />
  </PlBlockPage>
</template>
