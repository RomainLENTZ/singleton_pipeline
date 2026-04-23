<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useFiles } from '../composables/useFiles.js';

const props = defineProps({
  open: Boolean,
  ext: { type: String, default: 'md' },
  title: { type: String, default: 'Choisir un fichier' }
});
const emit = defineEmits(['close', 'pick']);

const { files, loading, error, fetchFiles } = useFiles();
const query = ref('');

watch(() => props.open, (v) => {
  if (v) {
    query.value = '';
    fetchFiles(props.ext);
  }
});

onMounted(() => {
  if (props.open) fetchFiles(props.ext);
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return files.value;
  return files.value.filter((f) => f.toLowerCase().includes(q));
});

function pick(f) {
  emit('pick', f);
  emit('close');
}
</script>

<template>
  <div v-if="open" class="file-picker" @click.self="emit('close')">
    <div class="file-picker__dialog">
      <header class="file-picker__head">
        <h3 class="file-picker__title">{{ title }}</h3>
        <button class="file-picker__close" type="button" @click="emit('close')">✕</button>
      </header>
      <div class="file-picker__body">
        <input
          v-model="query"
          class="file-picker__search"
          type="text"
          :placeholder="`Filtrer… (${files.length} fichier(s) .${ext})`"
          autofocus
        />
        <div v-if="loading" class="file-picker__state">Chargement…</div>
        <div v-else-if="error" class="file-picker__state file-picker__state--error">{{ error }}</div>
        <div v-else-if="filtered.length === 0" class="file-picker__state">Aucun fichier.</div>
        <ul v-else class="file-picker__list">
          <li
            v-for="f in filtered"
            :key="f"
            class="file-picker__item"
            @click="pick(f)"
          >{{ f }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;
@use '../styles/mixins' as *;

.file-picker {
  @include flex-center;
  position: fixed;
  inset: 0;
  z-index: $z-modal;
  background-color: rgba(0, 0, 0, 0.6);

  &__dialog {
    @include flex-col($gap: 0);
    width: $modal-width-md;
    max-width: 95vw;
    max-height: 80vh;
    border-radius: $radius-lg;
    border: 1px solid $color-border-strong;
    background-color: $color-surface;
    box-shadow: $shadow-lg;
  }

  &__head {
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
    &:hover { color: $color-text; }
  }

  &__body {
    @include flex-col($gap: $space-sm);
    padding: $space-md;
    overflow: hidden;
  }

  &__search {
    @include input-reset;
    padding: $space-xs $space-sm;
    font-size: $font-size-sm;
    border-radius: $radius-md;
    border: 1px solid $color-border-strong;
    background-color: $color-surface-2;
    color: $color-text;

    &:focus { border-color: $color-accent; }
  }

  &__state {
    padding: $space-md;
    font-size: $font-size-sm;
    color: $color-text-muted;
    text-align: center;

    &--error { color: $color-danger; }
  }

  &__list {
    @include scrollbar-dark;
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    max-height: 55vh;
    border: 1px solid $color-border;
    border-radius: $radius-md;
  }

  &__item {
    padding: $space-xs $space-sm;
    font-family: $font-family-mono;
    font-size: $font-size-xs;
    color: $color-text;
    cursor: pointer;
    border-bottom: 1px solid $color-border;

    &:last-child { border-bottom: 0; }
    &:hover { background-color: $color-surface-2; color: $color-accent-soft; }
  }
}
</style>
