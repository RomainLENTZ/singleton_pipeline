<script setup>
import { useToast } from '../composables/useToast.js';
const { messages } = useToast();
</script>

<template>
  <div class="toast-stack">
    <div
      v-for="m in messages"
      :key="m.id"
      class="toast"
      :class="`toast--${m.kind}`"
    >
      {{ m.text }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;
@use '../styles/mixins' as *;

.toast-stack {
  @include flex-col($gap: $space-sm, $align: flex-end);
  position: fixed;
  right: $space-lg;
  bottom: $space-lg;
  z-index: $z-toast;
}

.toast {
  padding: $space-sm $space-md;
  max-width: 360px;
  font-size: $font-size-xs;
  border-radius: $radius-lg;
  border: 1px solid;
  box-shadow: $shadow-md;

  &--info {
    background-color: $color-info-bg;
    border-color: $color-info-border;
    color: $color-text;
  }

  &--warn {
    background-color: $color-warn-bg;
    border-color: $color-warn-border;
    color: $color-warn-text;
  }

  &--error {
    background-color: $color-error-bg;
    border-color: $color-error-border;
    color: $color-error-text;
  }

  &--success {
    background-color: $color-success-bg;
    border-color: $color-success-border;
    color: $color-success-text;
  }
}
</style>
