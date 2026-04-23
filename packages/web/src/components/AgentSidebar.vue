<script setup>
defineProps({
  agents: { type: Array, required: true },
  loading: Boolean,
  error: String
});

function onDragStart(event, agent) {
  event.dataTransfer.setData('application/singleton-agent', JSON.stringify(agent));
  event.dataTransfer.effectAllowed = 'move';
}

function onDragStartInputNode(event, subtype) {
  event.dataTransfer.setData('application/singleton-node', JSON.stringify({ kind: 'input', subtype }));
  event.dataTransfer.effectAllowed = 'move';
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__header">
      <h2 class="sidebar__title">Agents</h2>
      <p class="sidebar__hint">Drag vers le canvas →</p>
    </div>

    <div class="sidebar__nodes">
      <div class="sidebar__subtitle">Nœuds Input</div>
      <div class="sidebar__io-row">
        <div
          class="io-card"
          draggable="true"
          @dragstart="onDragStartInputNode($event, 'file')"
          title="Fichier — chemin fixe ou demandé au runtime"
        >
          <span class="io-card__label">file</span>
          <span class="io-card__hint">Input</span>
        </div>
        <div
          class="io-card"
          draggable="true"
          @dragstart="onDragStartInputNode($event, 'text')"
          title="Texte — question posée à chaque run"
        >
          <span class="io-card__label">text</span>
          <span class="io-card__hint">Input</span>
        </div>
      </div>
    </div>

    <div class="sidebar__list">
      <div v-if="loading" class="sidebar__state">Chargement…</div>
      <div v-else-if="error" class="sidebar__state sidebar__state--error">Erreur : {{ error }}</div>
      <div v-else-if="agents.length === 0" class="sidebar__state">
        Aucun agent détecté. Lance <code>singleton scan</code> à la racine.
      </div>

      <article
        v-for="agent in agents"
        :key="agent.id"
        class="agent-card"
        draggable="true"
        @dragstart="onDragStart($event, agent)"
      >
        <header class="agent-card__head">
          <span class="agent-card__id">{{ agent.id }}</span>
          <span v-if="agent.model" class="agent-card__model">{{ agent.model }}</span>
        </header>
        <p class="agent-card__desc">{{ agent.description }}</p>
        <div v-if="agent.tags?.length" class="agent-card__tags">
          <span v-for="t in agent.tags" :key="t" class="agent-card__tag">{{ t }}</span>
        </div>
        <footer class="agent-card__ports">
          <span>in: {{ agent.inputs.join(', ') || '—' }}</span>
          <span>out: {{ agent.outputs.join(', ') || '—' }}</span>
        </footer>
      </article>
    </div>
  </aside>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;
@use '../styles/mixins' as *;

.sidebar {
  @include flex-col($gap: 0);
  width: $sidebar-width;
  border-right: 1px solid $color-border;
  background-color: $color-surface;
  flex-shrink: 0;

  &__header {
    padding: $space-md;
    border-bottom: 1px solid $color-border;
  }

  &__title {
    margin: 0;
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: $color-text-muted;
  }

  &__hint {
    margin: $space-xs 0 0;
    font-size: $font-size-xs;
    color: $color-text-dim;
  }

  &__list {
    @include flex-col($gap: $space-sm);
    @include scrollbar-dark;
    flex: 1;
    overflow-y: auto;
    padding: $space-md;
  }

  &__state {
    font-size: $font-size-sm;
    color: $color-text-muted;

    &--error { color: $color-danger; }

    code {
      font-size: $font-size-xs;
      background: $color-surface-2;
      padding: $space-xxs $space-xs;
      border-radius: $radius-sm;
    }
  }
}

.sidebar__nodes {
  padding: $space-md;
  border-bottom: 1px solid $color-border;
}

.sidebar__subtitle {
  font-size: $font-size-xxs;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: $color-text-dim;
  margin-bottom: $space-xs;
}

.sidebar__io-row {
  @include flex-row($gap: $space-sm);
}

.io-card {
  @include flex-col($gap: 2px, $align: center);
  flex: 1;
  padding: $space-sm;
  border-radius: $radius-md;
  border: 1px solid $color-border-strong;
  border-left: 3px solid $color-accent-soft;
  background-color: $color-surface-2;
  cursor: grab;
  transition: background-color $transition-fast, border-color $transition-fast;

  &:hover {
    background-color: $color-surface-3;
    border-color: $color-accent;
  }

  &:active { cursor: grabbing; }

  &__label {
    font-family: $font-family-mono;
    font-size: $font-size-xs;
    color: $color-accent-soft;
  }

  &__hint {
    font-size: $font-size-xxs;
    color: $color-text-dim;
  }
}

.agent-card {
  @include flex-col($gap: $space-xs);
  padding: $space-md;
  border-radius: $radius-lg;
  border: 1px solid $color-border-strong;
  background-color: $color-surface-2;
  cursor: grab;
  transition: background-color $transition-fast, border-color $transition-fast;

  &:hover {
    background-color: $color-surface-3;
    border-color: $color-accent;
  }

  &:active { cursor: grabbing; }

  &__head {
    @include flex-row($gap: $space-sm, $justify: space-between);
  }

  &__id {
    font-family: $font-family-mono;
    font-size: $font-size-sm;
    color: $color-accent-soft;
  }

  &__model {
    font-size: $font-size-xxs;
    color: $color-text-dim;
  }

  &__desc {
    margin: 0;
    font-size: $font-size-xs;
    color: $color-text-muted;
    @include line-clamp(2);
  }

  &__tags {
    @include flex-row($gap: $space-xs);
    flex-wrap: wrap;
  }

  &__tag {
    font-size: $font-size-xxs;
    padding: $space-xxs $space-xs + 2px;
    border-radius: $radius-sm;
    background: $color-border-strong;
    color: $color-text-muted;
  }

  &__ports {
    @include flex-row($gap: $space-md);
    font-size: $font-size-xxs;
    color: $color-text-dim;
  }
}
</style>
