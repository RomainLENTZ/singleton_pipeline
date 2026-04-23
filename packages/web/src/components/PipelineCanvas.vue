<script setup>
import { VueFlow, useVueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import AgentNode from './AgentNode.vue';
import InputNode from './InputNode.vue';

const props = defineProps({
  agents: Array,
  pipeline: Object
});

const {
  onConnect,
  addEdges,
  screenToFlowCoordinate,
  onNodesChange,
  onEdgesChange,
  applyNodeChanges,
  applyEdgeChanges
} = useVueFlow();

onConnect((params) => {
  addEdges([{
    ...params,
    id: `e-${params.source}-${params.sourceHandle}->${params.target}-${params.targetHandle}`
  }]);
});

onNodesChange((changes) => {
  props.pipeline.nodes.value = applyNodeChanges(changes, props.pipeline.nodes.value);
});
onEdgesChange((changes) => {
  props.pipeline.edges.value = applyEdgeChanges(changes, props.pipeline.edges.value);
});

function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function onDrop(event) {
  event.preventDefault();
  const position = screenToFlowCoordinate({ x: event.clientX, y: event.clientY });

  const agentRaw = event.dataTransfer.getData('application/singleton-agent');
  if (agentRaw) {
    props.pipeline.addAgentNode(JSON.parse(agentRaw), position);
    return;
  }

  const nodeRaw = event.dataTransfer.getData('application/singleton-node');
  if (nodeRaw) {
    const { kind, subtype } = JSON.parse(nodeRaw);
    if (kind === 'input') props.pipeline.addInputNode(position, { subtype: subtype || 'file' });
  }
}

const nodeTypes = { agent: AgentNode, input: InputNode };
</script>

<template>
  <div class="canvas" @dragover="onDragOver" @drop="onDrop">
    <VueFlow
      :nodes="pipeline.nodes.value"
      :edges="pipeline.edges.value"
      :node-types="nodeTypes"
      :fit-view-on-init="true"
    >
      <Background pattern-color="#1c2027" :gap="20" />
      <Controls />
      <MiniMap pannable zoomable class="canvas__minimap" />
    </VueFlow>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;

.canvas {
  width: 100%;
  height: 100%;

  :deep(.canvas__minimap) {
    background-color: $color-surface !important;
  }
}
</style>
