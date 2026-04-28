import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { usePipeline } from './usePipeline.js';

const AGENTS = [
  { id: 'a', inputs: ['in1'], outputs: ['out1'] },
  { id: 'b', inputs: ['in1'], outputs: ['out1'] },
];

function makePipeline() {
  return usePipeline(ref(AGENTS));
}

describe('toPipelineJson — cycle detection', () => {
  it('throws when the graph contains a cycle', () => {
    const p = makePipeline();
    p.loadPipeline({
      name: 'cycle',
      nodes: [
        { id: 'a-1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'a' } },
        { id: 'b-2', type: 'agent', position: { x: 200, y: 0 }, data: { agentId: 'b' } },
      ],
      edges: [
        { id: 'e1', source: 'a-1', target: 'b-2', sourceHandle: 'out-out1', targetHandle: 'in-in1' },
        { id: 'e2', source: 'b-2', target: 'a-1', sourceHandle: 'out-out1', targetHandle: 'in-in1' },
      ],
    });

    expect(() => p.toPipelineJson()).toThrow(/Cycle/);
  });

  it('produces steps in topological order on a DAG', () => {
    const p = makePipeline();
    p.loadPipeline({
      name: 'dag',
      nodes: [
        { id: 'a-1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'a' } },
        { id: 'b-2', type: 'agent', position: { x: 200, y: 0 }, data: { agentId: 'b' } },
      ],
      edges: [
        { id: 'e1', source: 'a-1', target: 'b-2', sourceHandle: 'out-out1', targetHandle: 'in-in1' },
      ],
    });

    const json = p.toPipelineJson();
    expect(json.steps.map((s) => s.agent)).toEqual(['a', 'b']);
  });
});

describe('loadPipeline — nodeCounter recalc', () => {
  it('takes the max digit sequence from any id, not just trailing', () => {
    const p = makePipeline();
    p.loadPipeline({
      name: 'counter',
      nodes: [
        { id: 'input-foo-10', type: 'input', position: { x: 0, y: 0 }, data: { subtype: 'text' } },
        { id: 'a-42', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'a' } },
      ],
      edges: [],
    });

    p.addAgentNode(AGENTS[1]);
    const last = p.nodes.value[p.nodes.value.length - 1];
    const trailing = Number(last.id.match(/(\d+)$/)?.[1]);
    expect(trailing).toBeGreaterThanOrEqual(43);
  });
});
