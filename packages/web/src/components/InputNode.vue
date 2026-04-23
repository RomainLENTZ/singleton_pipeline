<script setup>
import { ref } from 'vue';
import { Handle, Position, useVueFlow } from '@vue-flow/core';
import FilePicker from './FilePicker.vue';

const props = defineProps({ id: String, data: Object });
const { removeNodes, updateNodeData } = useVueFlow();
const pickerOpen = ref(false);

function set(patch) {
  updateNodeData(props.id, patch);
}
</script>

<template>
  <div class="node-input" :class="`node-input--${data.subtype || 'file'}`">
    <header class="node-input__head">
      <div class="node-input__meta">
        <span class="node-input__kind">Input</span>
        <div class="node-input__subtypes">
          <button
            class="node-input__st"
            :class="{ 'node-input__st--active': (data.subtype || 'file') === 'file' }"
            type="button"
            @click="set({ subtype: 'file' })"
          >file</button>
          <button
            class="node-input__st"
            :class="{ 'node-input__st--active': data.subtype === 'text' }"
            type="button"
            @click="set({ subtype: 'text' })"
          >text</button>
        </div>
      </div>
      <button class="node-input__close" type="button" @click="removeNodes([id])">✕</button>
    </header>

    <div class="node-input__body">
      <template v-if="(data.subtype || 'file') === 'file'">
        <input
          class="node-input__field"
          :value="data.label || ''"
          placeholder="Label…"
          @input="set({ label: $event.target.value })"
        />
        <button class="node-input__file-btn" type="button" @click="pickerOpen = true">
          <span v-if="data.value" class="node-input__path">{{ data.value }}</span>
          <span v-else class="node-input__placeholder">— choisir un fichier —</span>
        </button>
        <FilePicker
          :open="pickerOpen"
          ext=""
          title="Input — choisir un fichier"
          @close="pickerOpen = false"
          @pick="v => set({ value: v })"
        />
      </template>

      <template v-else>
        <input
          class="node-input__field"
          :value="data.label || ''"
          placeholder="Question à poser…"
          @input="set({ label: $event.target.value })"
        />
        <input
          class="node-input__field node-input__field--dim"
          :value="data.value || ''"
          placeholder="Valeur par défaut (optionnel)"
          @input="set({ value: $event.target.value })"
        />
      </template>
    </div>

    <div class="node-input__port">
      value
      <Handle id="out-value" type="source" :position="Position.Right" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;
@use '../styles/mixins' as *;

.node-input {
  @include flex-col($gap: 0);
  min-width: $node-min-width;
  border-radius: $radius-lg;
  border: 1px solid $color-border-strong;
  background-color: $color-surface-2;
  box-shadow: $shadow-md;
  color: $color-text;
  border-left: 3px solid $color-accent-soft;

  &__head {
    @include flex-row($gap: $space-sm, $justify: space-between, $align: center);
    padding: $space-sm $space-md;
    border-bottom: 1px solid $color-border-strong;
    background-color: $color-surface;
    border-radius: $radius-lg $radius-lg 0 0;
  }

  &__meta {
    @include flex-row($gap: $space-sm, $align: center);
  }

  &__kind {
    font-family: $font-family-mono;
    font-size: $font-size-xs;
    color: $color-accent-soft;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  &__subtypes {
    @include flex-row($gap: 2px);
  }

  &__st {
    @include button-reset;
    font-size: $font-size-xxs;
    padding: 1px $space-xs;
    border-radius: $radius-sm;
    color: $color-text-dim;
    border: 1px solid transparent;
    transition: color $transition-fast, border-color $transition-fast;

    &:hover { color: $color-text-muted; }

    &--active {
      color: $color-accent-soft;
      border-color: $color-border-strong;
    }
  }

  &__close {
    @include button-reset;
    font-size: $font-size-xs;
    color: $color-text-dim;
    &:hover { color: $color-danger; }
  }

  &__body {
    @include flex-col($gap: 0);
  }

  &__field {
    @include input-reset;
    padding: $space-xs $space-md;
    font-size: $font-size-xs;
    color: $color-text;
    border-bottom: 1px solid $color-border-strong;
    background: transparent;
    transition: background-color $transition-fast;

    &::placeholder { color: $color-text-dim; font-style: italic; }
    &:focus { background-color: $color-surface-3; }

    &--dim { color: $color-text-muted; }
  }

  &__file-btn {
    @include button-reset;
    padding: $space-sm $space-md;
    text-align: left;
    font-family: $font-family-mono;
    font-size: $font-size-xs;
    transition: background-color $transition-fast;
    border-bottom: 1px solid $color-border-strong;

    &:hover { background-color: $color-surface-3; }
  }

  &__path { color: $color-accent-soft; }
  &__placeholder { color: $color-text-dim; font-style: italic; }

  &__port {
    position: relative;
    font-size: $font-size-xs;
    color: $color-text-muted;
    padding: $space-xs $space-md;
    text-align: right;
  }
}
</style>
