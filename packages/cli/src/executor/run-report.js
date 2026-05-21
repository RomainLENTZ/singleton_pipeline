import fs from 'node:fs/promises';
import path from 'node:path';
import { S } from '../shell.js';

function visibleLength(s) {
  return String(s || '').replace(/\{[^}]+\}/g, '').length;
}

function padVisible(s, width, align = 'left') {
  const str = String(s ?? '');
  const pad = Math.max(0, width - visibleLength(str));
  return align === 'right' ? `${' '.repeat(pad)}${str}` : `${str}${' '.repeat(pad)}`;
}

function formatSeconds(value) {
  return `${Number(value || 0).toFixed(1)}s`;
}

function formatCost(value) {
  return value > 0 ? `$${value.toFixed(4)}` : '—';
}

function formatTurns(value) {
  return value > 0 ? String(value) : '—';
}

// Status → color. Used to color the Status column in the summary table.
function statusColor(status) {
  if (status === 'done')    return S.success;
  if (status === 'failed')  return S.error;
  if (status === 'dry-run') return S.warning;
  if (status === 'skipped') return S.muted;
  return S.text;
}

// Section header in the debug-loop style: blank lines + `─── title ───` centered, colored accent.
function sectionHeader(title) {
  const width = 72;
  const text = ` ${title} `;
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  const right = Math.max(0, width - text.length - left);
  return [
    '',
    '',
    `{${S.subtle}-fg}${'─'.repeat(left)}{/}{${S.accent}-fg}{bold}${text}{/}{${S.subtle}-fg}${'─'.repeat(right)}{/}`,
    '',
  ];
}

export function renderRunSummary({ stats, fileWrites, dryRun, runDir, cwd, runStatus = null }) {
  const totalSeconds = stats.reduce((sum, s) => sum + (s.seconds || 0), 0);
  const totalCost = stats.reduce((sum, s) => sum + (s.cost || 0), 0);

  // Compact 6-column table: #, agent, model, status (colored), time, cost.
  // Provider/Policy/Attempts/Turns are dropped — they're available in run-manifest.json.
  const rows = stats.map((s, i) => ({
    step: String(i + 1),
    agent: s.agent,
    model: s.model || '—',
    status: s.status,
    time: s.status === 'dry-run' || s.status === 'skipped' ? '—' : formatSeconds(s.seconds),
    cost: formatCost(s.cost),
  }));

  const finalStatus = runStatus || (dryRun ? 'dry-run' : 'done');
  const totalRow = {
    step: '',
    agent: 'TOTAL',
    model: '—',
    status: finalStatus,
    time: formatSeconds(totalSeconds),
    cost: formatCost(totalCost),
  };

  const allRows = [...rows, totalRow];
  const widths = {
    step: Math.max(1, ...allRows.map((r) => visibleLength(r.step))),
    agent: Math.max(5, ...allRows.map((r) => visibleLength(r.agent))),
    model: Math.max(5, ...allRows.map((r) => visibleLength(r.model))),
    status: Math.max(6, ...allRows.map((r) => visibleLength(r.status))),
    time: Math.max(4, ...allRows.map((r) => visibleLength(r.time))),
    cost: Math.max(4, ...allRows.map((r) => visibleLength(r.cost))),
  };

  const hr = [
    '─'.repeat(widths.step + 2),
    '─'.repeat(widths.agent + 2),
    '─'.repeat(widths.model + 2),
    '─'.repeat(widths.status + 2),
    '─'.repeat(widths.time + 2),
    '─'.repeat(widths.cost + 2),
  ].join(`{${S.subtle}-fg}┼{/}`);

  function row(r, { color = false } = {}) {
    const statusCell = color
      ? `{${statusColor(r.status)}-fg}${padVisible(r.status, widths.status)}{/}`
      : padVisible(r.status, widths.status);
    return [
      ` ${padVisible(r.step, widths.step, 'right')} `,
      ` ${padVisible(r.agent, widths.agent)} `,
      ` ${padVisible(r.model, widths.model)} `,
      ` ${statusCell} `,
      ` ${padVisible(r.time, widths.time, 'right')} `,
      ` ${padVisible(r.cost, widths.cost, 'right')} `,
    ].join(`{${S.subtle}-fg}│{/}`);
  }

  const lines = [
    ...sectionHeader('Run summary'),
    `{${S.muted}-fg}${row({ step: '#', agent: 'Agent', model: 'Model', status: 'Status', time: 'Time', cost: 'Cost' })}{/}`,
    `{${S.subtle}-fg}${hr}{/}`,
    ...rows.map((r) => row(r, { color: true })),
    `{${S.subtle}-fg}${hr}{/}`,
    `{bold}${row(totalRow, { color: true })}{/}`,
    '',
  ];

  if (runDir) {
    lines.push(`  {${S.muted}-fg}Run{/}        {${S.string}-fg}${path.relative(cwd, runDir)}{/}`);
  }

  if (fileWrites.length) {
    lines.push(`  {${S.muted}-fg}Generated{/}  {${S.string}-fg}${fileWrites[0]}{/}`);
    for (const f of fileWrites.slice(1)) {
      lines.push(`             {${S.string}-fg}${f}{/}`);
    }
  }
  lines.push('');

  return lines;
}

export async function writeRunManifest({ runDir, runId, pipeline, cwd, stats, fileWrites, detectedDeliverables = [], status = 'done', error = null, debugEvents = [] }) {
  if (!runDir) return;

  const uniqueWrites = [];
  const seen = new Set();
  for (const entry of [...fileWrites, ...detectedDeliverables]) {
    if (seen.has(entry.absPath)) continue;
    seen.add(entry.absPath);
    uniqueWrites.push(entry);
  }

  const deliverables = uniqueWrites.filter((entry) => entry.kind === 'deliverable');
  const intermediates = uniqueWrites.filter((entry) => entry.kind === 'intermediate');

  const manifest = {
    runId,
    pipeline: pipeline.name,
    projectRoot: cwd,
    createdAt: new Date().toISOString(),
    status,
    error: error ? {
      message: error.message,
    } : null,
    deliverables: deliverables.map((entry) => ({
      path: entry.relPath,
      absPath: entry.absPath,
    })),
    intermediates: intermediates.map((entry) => ({
      path: entry.relPath,
      absPath: entry.absPath,
    })),
    stats: stats.map((s) => ({
      agent: s.agent,
      provider: s.provider,
      model: s.model,
      runnerAgent: s.runnerAgent,
      securityProfile: s.securityProfile,
      permissionMode: s.permissionMode,
      status: s.status,
      seconds: s.seconds,
      turns: s.turns,
      cost: s.cost,
      attempts: s.attempts || 1,
      outputWarnings: s.outputWarnings || [],
      parsedOutputs: s.parsedOutputs || [],
      rawOutputPath: s.rawOutputPath || null,
    })),
    debugEvents,
  };

  await fs.writeFile(path.join(runDir, 'run-manifest.json'), JSON.stringify(manifest, null, 2));
}
