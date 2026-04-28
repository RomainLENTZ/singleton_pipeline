import { ref } from 'vue';

export function usePipeline(agentsRef) {
  const nodes = ref([]);
  const edges = ref([]);
  const name = ref('my-pipeline');
  let nodeCounter = 0;

  function findAgent(agentId) {
    return agentsRef.value.find((a) => a.id === agentId);
  }

  function addAgentNode(agent, position = { x: 200, y: 120 }) {
    nodeCounter += 1;
    const id = `${agent.id}-${nodeCounter}`;
    nodes.value = [
      ...nodes.value,
      {
        id,
        type: 'agent',
        position,
        data: { agentId: agent.id }
      }
    ];
    return id;
  }

  function addInputNode(position = { x: 80, y: 120 }, { subtype = 'file', label = '', value = '' } = {}) {
    nodeCounter += 1;
    const id = `input-${nodeCounter}`;
    nodes.value = [
      ...nodes.value,
      { id, type: 'input', position, data: { subtype, label, value } }
    ];
    return id;
  }

  function removeNode(id) {
    nodes.value = nodes.value.filter((n) => n.id !== id);
    edges.value = edges.value.filter((e) => e.source !== id && e.target !== id);
  }

  function clear() {
    nodes.value = [];
    edges.value = [];
    nodeCounter = 0;
    name.value = 'my-pipeline';
  }

  // Remove edges that no longer point to a valid handle. For agent endpoints,
  // verify the handle still matches an input/output of the underlying agent.
  // Input nodes have a fixed handle (out-value), always valid.
  function sanitize() {
    const nodeById = new Map(nodes.value.map((n) => [n.id, n]));
    const kept = [];
    const removed = [];

    for (const e of edges.value) {
      const src = nodeById.get(e.source);
      const tgt = nodeById.get(e.target);
      if (!src || !tgt) {
        removed.push({ edge: e, reason: 'node introuvable' });
        continue;
      }

      let srcOk = true;
      let srcReason = '';
      if (src.type === 'agent') {
        const a = findAgent(src.data.agentId);
        const srcName = e.sourceHandle?.replace(/^out-/, '');
        srcOk = !!(a && a.outputs.includes(srcName));
        if (!srcOk) srcReason = `output "${srcName}" introuvable`;
      } else if (src.type === 'input') {
        srcOk = e.sourceHandle === 'out-value';
      } else {
        srcOk = false;
        srcReason = 'source invalide';
      }

      let tgtOk = true;
      let tgtReason = '';
      if (tgt.type === 'agent') {
        const a = findAgent(tgt.data.agentId);
        const tgtName = e.targetHandle?.replace(/^in-/, '');
        tgtOk = !!(a && a.inputs.includes(tgtName));
        if (!tgtOk) tgtReason = `input "${tgtName}" introuvable`;
      } else {
        tgtOk = false;
        tgtReason = 'target invalide';
      }

      if (srcOk && tgtOk) {
        kept.push(e);
      } else {
        removed.push({ edge: e, reason: srcReason || tgtReason || 'invalide' });
      }
    }

    if (removed.length) edges.value = kept;
    return removed;
  }

  function loadPipeline(data) {
    clear();
    name.value = data.name || 'my-pipeline';
    nodes.value = Array.isArray(data.nodes) ? [...data.nodes] : [];
    edges.value = Array.isArray(data.edges) ? [...data.edges] : [];

    for (const n of nodes.value) {
      // Match any trailing digits in the id, regardless of separator pattern.
      const matches = String(n.id).match(/(\d+)/g);
      if (!matches) continue;
      const max = Math.max(...matches.map(Number));
      if (max > nodeCounter) nodeCounter = max;
    }
  }

  function toPipelineJson() {
    const nodeById = new Map(nodes.value.map((n) => [n.id, n]));
    const incoming = new Map();
    const outgoing = new Map();

    for (const e of edges.value) {
      (incoming.get(e.target) || incoming.set(e.target, []).get(e.target)).push(e);
      (outgoing.get(e.source) || outgoing.set(e.source, []).get(e.source)).push(e);
    }

    const order = [];
    const state = new Map(); // id -> 'visiting' | 'done'
    function visit(id, stack = []) {
      const s = state.get(id);
      if (s === 'done') return;
      if (s === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(id)), id].join(' → ');
        throw new Error(`Cycle détecté dans la pipeline: ${cycle}`);
      }
      state.set(id, 'visiting');
      for (const e of incoming.get(id) || []) visit(e.source, [...stack, id]);
      state.set(id, 'done');
      order.push(id);
    }
    for (const n of nodes.value) visit(n.id);

    const agentOrder = order.filter((id) => nodeById.get(id)?.type === 'agent');

    const steps = agentOrder.map((id) => {
      const node = nodeById.get(id);
      const agent = findAgent(node.data.agentId);
      const nodeIncoming = incoming.get(id) || [];
      const nodeOutgoing = outgoing.get(id) || [];

      const inputs = {};
      for (const inp of agent?.inputs || []) {
        const wired = nodeIncoming.find((e) => e.targetHandle === `in-${inp}`);
        if (!wired) {
          inputs[inp] = `$FILE:<todo-set-path>`;
          continue;
        }
        const srcNode = nodeById.get(wired.source);
        if (srcNode?.type === 'input') {
          inputs[inp] = `$INPUT:${srcNode.id}`;
        } else {
          const srcName = wired.sourceHandle?.replace(/^out-/, '');
          inputs[inp] = `$PIPE:${srcNode?.data.agentId}.${srcName}`;
        }
      }

      const outputs = {};
      for (const out of agent?.outputs || []) {
        outputs[out] = `$FILE:./output/${node.data.agentId}.${out}.md`;
      }

      return {
        agent: node.data.agentId,
        agent_file: agent?.file,
        inputs,
        outputs
      };
    });

    return {
      name: name.value,
      created: new Date().toISOString(),
      steps
    };
  }

  return {
    nodes,
    edges,
    name,
    addAgentNode,
    addInputNode,
    removeNode,
    clear,
    sanitize,
    loadPipeline,
    toPipelineJson
  };
}
