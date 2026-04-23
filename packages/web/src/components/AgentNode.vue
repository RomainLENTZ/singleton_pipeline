<script setup>
import { computed, inject } from 'vue';
import { Handle, Position, useVueFlow } from '@vue-flow/core';

const props = defineProps({
  id: String,
  data: Object
});

const agents = inject('agents');
const { removeNodes } = useVueFlow();

const agent = computed(() => agents.value.find((a) => a.id === props.data.agentId));
const stale = computed(() => !agent.value);
</script>

<template>
  <div class="node-agent" :class="{ 'node-agent--stale': stale }">
    <header class="node-agent__head">
      <span class="node-agent__id">
        {{ data.agentId }}
        <span v-if="stale" class="node-agent__badge">stale</span>
      </span>
      <button
        class="node-agent__close"
        type="button"
        @click="removeNodes([id])"
        title="Remove node"
      >✕</button>
    </header>

    <p v-if="stale" class="node-agent__warn">
      Agent introuvable dans le repo. Supprime le node ou restaure le fichier.
    </p>

    <template v-else>
      <p class="node-agent__desc">{{ agent.description }}</p>

      <div class="node-agent__ports">
        <div class="node-agent__col node-agent__col--in">
          <div class="node-agent__col-title">Inputs</div>
          <div
            v-for="inp in agent.inputs"
            :key="inp"
            class="node-agent__port node-agent__port--in"
          >
            <Handle
              :id="`in-${inp}`"
              type="target"
              :position="Position.Left"
              :style="{ top: '50%' }"
            />
            {{ inp }}
          </div>
        </div>
        <div class="node-agent__col node-agent__col--out">
          <div class="node-agent__col-title">Outputs</div>
          <div
            v-for="out in agent.outputs"
            :key="out"
            class="node-agent__port node-agent__port--out"
          >
            {{ out }}
            <Handle
              :id="`out-${out}`"
              type="source"
              :position="Position.Right"
              :style="{ top: '50%' }"
            />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;
@use '../styles/mixins' as *;

.node-agent {
  @include flex-col($gap: 0);
  min-width: $node-min-width;
  border-radius: $radius-lg;
  border: 1px solid $color-border-strong;
  background-color: $color-surface-2;
  box-shadow: $shadow-md;
  color: $color-text;

  &--stale {
    border-color: $color-danger-border;
    background-color: $color-danger-bg;

    .node-agent__head {
      background-color: $color-danger-hover;
      border-bottom-color: $color-danger-border;
    }

    .node-agent__id { color: $color-error-text; }
  }

  &__head {
    @include flex-row($gap: $space-sm, $justify: space-between);
    padding: $space-sm $space-md;
    border-bottom: 1px solid $color-border-strong;
    background-color: $color-surface;
    border-radius: $radius-lg $radius-lg 0 0;
  }

  &__id {
    font-family: $font-family-mono;
    font-size: $font-size-sm;
    color: $color-accent-soft;
  }

  &__badge {
    margin-left: $space-xs;
    font-family: $font-family-sans;
    font-size: $font-size-xxs;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: $color-error-text;
  }

  &__close {
    @include button-reset;
    font-size: $font-size-xs;
    color: $color-text-dim;
    transition: color $transition-fast;

    &:hover { color: $color-danger; }
  }

  &__desc {
    margin: 0;
    padding: $space-sm $space-md;
    font-size: $font-size-xs;
    color: $color-text-muted;
    @include line-clamp(2);
  }

  &__warn {
    margin: 0;
    padding: $space-sm $space-md;
    font-size: $font-size-xs;
    color: $color-error-text;
  }

  &__ports {
    @include flex-row($gap: $space-sm, $align: stretch);
    padding: $space-sm $space-md;
    border-top: 1px solid $color-border-strong;
  }

  &__col {
    @include flex-col($gap: $space-xs);
    flex: 1;

    &--out { text-align: right; }
  }

  &__col-title {
    font-size: $font-size-xxs;
    text-transform: uppercase;
    color: $color-text-dim;
    margin-bottom: $space-xs;
  }

  &__port {
    position: relative;
    font-size: $font-size-xs;
    color: $color-text-muted;
    padding: $space-xs 0;

    &--in  { padding-left: $space-sm; }
    &--out { padding-right: $space-sm; }
  }
}
</style>
