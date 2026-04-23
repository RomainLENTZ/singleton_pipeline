<script setup>
import { onMounted, provide, watch } from 'vue';
import AgentSidebar from './components/AgentSidebar.vue';
import PipelineCanvas from './components/PipelineCanvas.vue';
import PipelineToolbar from './components/PipelineToolbar.vue';
import ToastStack from './components/ToastStack.vue';
import { useAgents } from './composables/useAgents.js';
import { usePipeline } from './composables/usePipeline.js';
import { useToast } from './composables/useToast.js';

const { agents, loading, error, fetchAgents, rescan } = useAgents();
const pipeline = usePipeline(agents);
const { push } = useToast();

provide('agents', agents);

async function doRescan() {
  await rescan();
  const removed = pipeline.sanitize();
  if (removed.length) {
    push(`${removed.length} connexion(s) nettoyée(s) après rescan`, 'warn');
  } else {
    push('Rescan OK', 'success', 1800);
  }
}

onMounted(fetchAgents);

watch(agents, () => {
  pipeline.sanitize();
}, { deep: true });
</script>

<template>
  <div class="app">
    <header class="app__header">
      <div class="app__brand">
        <span class="app__logo">◉</span>
        <h1 class="app__title">Singleton Pipeline Builder</h1>
        <span class="app__tagline">— drag agents, wire them up, ship a CLI command</span>
      </div>
      <PipelineToolbar :pipeline="pipeline" :agents="agents" @rescan="doRescan" />
    </header>

    <div class="app__body">
      <AgentSidebar :agents="agents" :loading="loading" :error="error" />
      <main class="app__canvas">
        <PipelineCanvas :agents="agents" :pipeline="pipeline" />
      </main>
    </div>

    <ToastStack />
  </div>
</template>

<style lang="scss" scoped>
@use './styles/variables' as *;
@use './styles/mixins' as *;

.app {
  @include flex-col($gap: 0);
  height: 100vh;

  &__header {
    @include flex-row($gap: $space-md, $justify: space-between);
    height: $header-height;
    padding: 0 $space-lg;
    border-bottom: 1px solid $color-border;
    background-color: $color-surface;
    flex-shrink: 0;
  }

  &__brand {
    @include flex-row($gap: $space-sm);
  }

  &__logo {
    color: $color-accent-soft;
    font-weight: $font-weight-bold;
  }

  &__title {
    margin: 0;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__tagline {
    font-size: $font-size-xs;
    color: $color-text-dim;
  }

  &__body {
    @include flex-row($gap: 0, $align: stretch);
    flex: 1;
    overflow: hidden;
  }

  &__canvas {
    flex: 1;
    position: relative;
  }
}
</style>
