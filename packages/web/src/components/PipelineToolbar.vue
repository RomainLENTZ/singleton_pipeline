<script setup>
import { ref } from 'vue';
import { useToast } from '../composables/useToast.js';

const props = defineProps({
  pipeline: Object,
  agents: Array
});
const emit = defineEmits(['rescan']);
const { push } = useToast();

const exportOpen = ref(false);
const exportedJson = ref('');
const exportedCli = ref('');

const loadOpen = ref(false);
const savedPipelines = ref([]);

async function save() {
  let json;
  try {
    json = props.pipeline.toPipelineJson();
  } catch (e) {
    push(e.message, 'error');
    return;
  }
  const payload = { ...json, nodes: props.pipeline.nodes.value, edges: props.pipeline.edges.value };
  const res = await fetch('/api/pipelines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (res.ok) push(`Pipeline sauvée → ${data.file}`, 'success');
  else push(`Erreur save: ${data.error}`, 'error');
}

function exportCli() {
  let json;
  try {
    json = props.pipeline.toPipelineJson();
  } catch (e) {
    push(e.message, 'error');
    return;
  }
  exportedJson.value = JSON.stringify(json, null, 2);
  exportedCli.value = `singleton run --pipeline ./pipelines/${json.name}.json`;
  exportOpen.value = true;
}

async function openLoad() {
  try {
    const res = await fetch('/api/pipelines');
    const data = await res.json();
    savedPipelines.value = data.pipelines || [];
    loadOpen.value = true;
  } catch (e) {
    push(`Erreur list: ${e.message}`, 'error');
  }
}

function loadOne(p) {
  props.pipeline.loadPipeline(p);
  const removed = props.pipeline.sanitize();
  loadOpen.value = false;
  if (removed.length) {
    push(`"${p.name}" chargée — ${removed.length} edge(s) obsolète(s) retirée(s)`, 'warn');
  } else {
    push(`"${p.name}" chargée`, 'success');
  }
}

async function deleteOne(p) {
  if (!confirm(`Supprimer "${p.name}" ?`)) return;
  const res = await fetch(`/api/pipelines/${encodeURIComponent(p.name)}`, { method: 'DELETE' });
  if (res.ok) {
    savedPipelines.value = savedPipelines.value.filter((x) => x.name !== p.name);
    push(`"${p.name}" supprimée`, 'info');
  } else {
    push('Suppression échouée', 'error');
  }
}

function copy(text) {
  navigator.clipboard.writeText(text);
  push('Copié', 'info', 1200);
}
</script>

<template>
  <div class="toolbar">
    <input
      v-model="pipeline.name.value"
      class="toolbar__input"
      placeholder="pipeline name"
    />

    <button class="toolbar__btn" type="button" @click="emit('rescan')">Rescan</button>
    <button class="toolbar__btn" type="button" @click="openLoad">Load</button>
    <button class="toolbar__btn" type="button" @click="save">Save</button>
    <button class="toolbar__btn toolbar__btn--primary" type="button" @click="exportCli">Export CLI</button>
    <button class="toolbar__btn toolbar__btn--danger" type="button" @click="pipeline.clear()">Clear</button>

    <!-- Export modal -->
    <div
      v-if="exportOpen"
      class="modal"
      @click.self="exportOpen = false"
    >
      <div class="modal__dialog modal__dialog--md">
        <header class="modal__header">
          <h3 class="modal__title">Export pipeline</h3>
          <button class="modal__close" type="button" @click="exportOpen = false">✕</button>
        </header>
        <div class="modal__body">
          <section class="modal__section">
            <div class="modal__section-head">
              <label class="modal__label">CLI command</label>
              <button class="modal__copy" type="button" @click="copy(exportedCli)">Copy</button>
            </div>
            <pre class="modal__code modal__code--inline">{{ exportedCli }}</pre>
          </section>
          <section class="modal__section">
            <div class="modal__section-head">
              <label class="modal__label">Pipeline JSON</label>
              <button class="modal__copy" type="button" @click="copy(exportedJson)">Copy</button>
            </div>
            <pre class="modal__code modal__code--scroll">{{ exportedJson }}</pre>
          </section>
        </div>
      </div>
    </div>

    <!-- Load modal -->
    <div
      v-if="loadOpen"
      class="modal"
      @click.self="loadOpen = false"
    >
      <div class="modal__dialog modal__dialog--sm">
        <header class="modal__header">
          <h3 class="modal__title">Charger une pipeline</h3>
          <button class="modal__close" type="button" @click="loadOpen = false">✕</button>
        </header>
        <div class="modal__body">
          <p v-if="savedPipelines.length === 0" class="pipeline-list__empty">
            Aucune pipeline sauvée.
          </p>
          <ul v-else class="pipeline-list">
            <li v-for="p in savedPipelines" :key="p.name" class="pipeline-list__item">
              <div class="pipeline-list__info">
                <div class="pipeline-list__name">{{ p.name }}</div>
                <div class="pipeline-list__meta">
                  {{ (p.steps || []).length }} step(s) · {{ p.created?.slice(0, 16).replace('T', ' ') || 'n/a' }}
                </div>
              </div>
              <div class="pipeline-list__actions">
                <button class="toolbar__btn toolbar__btn--primary" type="button" @click="loadOne(p)">Load</button>
                <button class="toolbar__btn toolbar__btn--danger" type="button" @click="deleteOne(p)">✕</button>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;
@use '../styles/mixins' as *;

.toolbar {
  @include flex-row($gap: $space-sm);

  &__input {
    @include input-reset;
    width: 160px;
    padding: $space-xs $space-sm;
    font-size: $font-size-xs;
    border-radius: $radius-md;
    border: 1px solid $color-border-strong;
    background-color: $color-surface-2;
    color: $color-text;
    transition: border-color $transition-fast;

    &:focus { border-color: $color-accent; }
  }

  &__btn {
    @include button-reset;
    padding: $space-xs $space-md;
    font-size: $font-size-xs;
    border-radius: $radius-md;
    border: 1px solid $color-border-strong;
    background-color: $color-surface-2;
    color: $color-text;
    transition: background-color $transition-fast, border-color $transition-fast;

    &:hover { background-color: $color-surface-3; }

    &--primary {
      background-color: $color-accent-hover;
      border-color: $color-accent-hover;
      color: $color-accent-contrast;

      &:hover { background-color: $color-accent; border-color: $color-accent; }
    }

    &--danger:hover {
      background-color: $color-danger-hover;
      border-color: $color-danger-border;
    }
  }
}

.modal {
  @include flex-center;
  position: fixed;
  inset: 0;
  z-index: $z-modal;
  background-color: rgba(0, 0, 0, 0.6);

  &__dialog {
    @include flex-col($gap: 0);
    max-width: 95vw;
    max-height: 85vh;
    border-radius: $radius-lg;
    border: 1px solid $color-border-strong;
    background-color: $color-surface;
    box-shadow: $shadow-lg;

    &--sm { width: $modal-width-sm; }
    &--md { width: $modal-width-md; }
  }

  &__header {
    @include flex-row($gap: $space-md, $justify: space-between);
    padding: $space-md;
    border-bottom: 1px solid $color-border;
  }

  &__title {
    margin: 0;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__close {
    @include button-reset;
    color: $color-text-muted;
    transition: color $transition-fast;
    &:hover { color: $color-text; }
  }

  &__body {
    @include flex-col($gap: $space-lg);
    @include scrollbar-dark;
    padding: $space-lg;
    overflow-y: auto;
  }

  &__section {
    @include flex-col($gap: $space-xs);
  }

  &__section-head {
    @include flex-row($gap: $space-sm, $justify: space-between);
  }

  &__label {
    font-size: $font-size-xs;
    text-transform: uppercase;
    color: $color-text-muted;
  }

  &__copy {
    @include button-reset;
    font-size: $font-size-xs;
    color: $color-accent-soft;
    &:hover { color: $color-accent; }
  }

  &__code {
    margin: 0;
    padding: $space-sm $space-md;
    font-size: $font-size-xs;
    font-family: $font-family-mono;
    color: $color-accent-soft;
    background-color: $color-bg;
    border: 1px solid $color-border;
    border-radius: $radius-md;

    &--inline { white-space: pre-wrap; }
    &--scroll {
      overflow: auto;
      max-height: 50vh;
      color: $color-text;
    }
  }
}

.pipeline-list {
  @include flex-col($gap: 0);
  list-style: none;
  margin: 0;
  padding: 0;

  &__empty {
    margin: 0;
    padding: $space-lg;
    text-align: center;
    font-size: $font-size-sm;
    color: $color-text-dim;
  }

  &__item {
    @include flex-row($gap: $space-sm, $justify: space-between);
    padding: $space-sm 0;
    border-bottom: 1px solid $color-border;

    &:last-child { border-bottom: 0; }
  }

  &__info {
    min-width: 0;
    flex: 1;
  }

  &__name {
    font-family: $font-family-mono;
    font-size: $font-size-sm;
    color: $color-accent-soft;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__meta {
    font-size: $font-size-xxs;
    color: $color-text-dim;
  }

  &__actions {
    @include flex-row($gap: $space-xs);
    flex-shrink: 0;
  }
}
</style>
