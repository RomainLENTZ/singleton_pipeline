import fs from 'node:fs/promises';
import path from 'node:path';
import { G, S } from '../shell.js';
import type { DebugEvent, FileWrite, PipelineConfig, RunStat } from '../types.js';

export const LATEST_RUN_ID_FILE = 'latest-run-id';

type SummaryRow = {
  step: string;
  agent: string;
  model: string;
  status: string;
  time: string;
  cost: string;
};

type RenderRunSummaryOptions = {
  stats: RunStat[];
  fileWrites: string[];
  dryRun: boolean;
  runDir?: string | null;
  cwd: string;
  runStatus?: string | null;
};

type WriteRunManifestOptions = {
  runDir: string | null;
  runId: string;
  pipeline: PipelineConfig;
  cwd: string;
  stats: RunStat[];
  fileWrites: FileWrite[];
  detectedDeliverables?: FileWrite[];
  status?: string;
  error?: Error | null;
  debugEvents?: DebugEvent[];
};

function visibleLength(value: unknown): number {
  return String(value || '').replace(/\{[^}]+\}/g, '').length;
}

function padVisible(value: unknown, width: number, align: 'left' | 'right' = 'left'): string {
  const str = String(value ?? '');
  const pad = Math.max(0, width - visibleLength(str));
  return align === 'right' ? `${' '.repeat(pad)}${str}` : `${str}${' '.repeat(pad)}`;
}

function formatSeconds(value: unknown): string {
  return `${Number(value || 0).toFixed(1)}s`;
}

function formatCost(value: unknown): string {
  const cost = Number(value || 0);
  return cost > 0 ? `$${cost.toFixed(4)}` : '-';
}

function displayValue(value: unknown): string {
  return !value || value === '—' ? '-' : String(value);
}

// Status -> color. Only the Status cell is coloured; the rest of the row stays white
// so the outcome is scannable without being noisy.
function statusColor(status: string): string {
  if (status === 'done')    return S.success;
  if (status === 'failed')  return S.error;
  if (status === 'dry-run') return S.warning;
  if (status === 'skipped') return S.muted;
  return S.text;
}

// Section header in the debug-loop style: blank lines + `─── title ───` centered, colored accent.
function sectionHeader(title: string): string[] {
  const width = 72;
  const text = ` ${title} `;
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  const right = Math.max(0, width - text.length - left);
  return [
    '',
    '',
    `{${S.subtle}-fg}${G.hline.repeat(left)}{/}{${S.accent}-fg}{bold}${text}{/}{${S.subtle}-fg}${G.hline.repeat(right)}{/}`,
    '',
  ];
}

export function renderRunSummary({
  stats,
  fileWrites,
  dryRun,
  runDir,
  cwd,
  runStatus = null,
}: RenderRunSummaryOptions): string[] {
  const totalSeconds = stats.reduce((sum, stat) => sum + (stat.seconds || 0), 0);
  const totalCost = stats.reduce((sum, stat) => sum + (stat.cost || 0), 0);

  // Compact 6-column table: #, agent, model, status (colored), time, cost.
  // Provider/Policy/Attempts/Turns are dropped - they're available in run-manifest.json.
  const rows: SummaryRow[] = stats.map((stat, index) => ({
    step: String(index + 1),
    agent: stat.agent,
    model: displayValue(stat.model),
    status: stat.status,
    time: stat.status === 'dry-run' || stat.status === 'skipped' ? '-' : formatSeconds(stat.seconds),
    cost: formatCost(stat.cost),
  }));

  const finalStatus = runStatus || (dryRun ? 'dry-run' : 'done');
  const totalRow: SummaryRow = {
    step: '',
    agent: 'TOTAL',
    model: '-',
    status: finalStatus,
    time: formatSeconds(totalSeconds),
    cost: formatCost(totalCost),
  };

  const allRows = [...rows, totalRow];
  const widths = {
    step: Math.max(1, ...allRows.map((row) => visibleLength(row.step))),
    agent: Math.max(5, ...allRows.map((row) => visibleLength(row.agent))),
    model: Math.max(5, ...allRows.map((row) => visibleLength(row.model))),
    status: Math.max(6, ...allRows.map((row) => visibleLength(row.status))),
    time: Math.max(4, ...allRows.map((row) => visibleLength(row.time))),
    cost: Math.max(4, ...allRows.map((row) => visibleLength(row.cost))),
  };

  const hr = [
    G.hline.repeat(widths.step + 2),
    G.hline.repeat(widths.agent + 2),
    G.hline.repeat(widths.model + 2),
    G.hline.repeat(widths.status + 2),
    G.hline.repeat(widths.time + 2),
    G.hline.repeat(widths.cost + 2),
  ].join(`{${S.subtle}-fg}${G.cross}{/}`);

  // Bold each cell individually because `{/}` from the separator would reset a row-level bold.
  function row(rowData: SummaryRow, { bold = false, colorStatus = false }: { bold?: boolean, colorStatus?: boolean } = {}): string {
    const b = bold ? '{bold}' : '';
    const bClose = bold ? '{/}' : '';
    const statusPadded = padVisible(rowData.status, widths.status);
    const statusCell = colorStatus
      ? `{${statusColor(rowData.status)}-fg}${b}${statusPadded}${bClose}{/}`
      : `${b}${statusPadded}${bClose}`;
    return [
      ` ${b}${padVisible(rowData.step, widths.step, 'right')}${bClose} `,
      ` ${b}${padVisible(rowData.agent, widths.agent)}${bClose} `,
      ` ${b}${padVisible(rowData.model, widths.model)}${bClose} `,
      ` ${statusCell} `,
      ` ${b}${padVisible(rowData.time, widths.time, 'right')}${bClose} `,
      ` ${b}${padVisible(rowData.cost, widths.cost, 'right')}${bClose} `,
    ].join(`{${S.subtle}-fg}${G.vline}{/}`);
  }

  const lines = [
    ...sectionHeader('Run summary'),
    row({ step: '#', agent: 'Agent', model: 'Model', status: 'Status', time: 'Time', cost: 'Cost' }, { bold: true }),
    `{${S.subtle}-fg}${hr}{/}`,
    ...rows.map((item) => row(item, { colorStatus: true })),
    `{${S.subtle}-fg}${hr}{/}`,
    row(totalRow, { bold: true, colorStatus: true }),
    '',
  ];

  if (runDir) {
    lines.push(`  {${S.muted}-fg}Run{/}        {${S.keyword}-fg}${path.relative(cwd, runDir)}{/}`);
  }

  if (fileWrites.length) {
    lines.push(`  {${S.muted}-fg}Generated{/}  {${S.keyword}-fg}${fileWrites[0]}{/}`);
    for (const file of fileWrites.slice(1)) {
      lines.push(`             {${S.keyword}-fg}${file}{/}`);
    }
  }
  lines.push('');

  return lines;
}

export async function writeRunManifest({
  runDir,
  runId,
  pipeline,
  cwd,
  stats,
  fileWrites,
  detectedDeliverables = [],
  status = 'done',
  error = null,
  debugEvents = [],
}: WriteRunManifestOptions): Promise<void> {
  if (!runDir) return;

  const uniqueWrites: FileWrite[] = [];
  const seen = new Set<string>();
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
    stats: stats.map((stat) => ({
      agent: stat.agent,
      provider: stat.provider,
      model: stat.model,
      runnerAgent: stat.runnerAgent,
      securityProfile: stat.securityProfile,
      permissionMode: stat.permissionMode,
      status: stat.status,
      seconds: stat.seconds,
      turns: stat.turns,
      cost: stat.cost,
      attempts: stat.attempts || 1,
      outputWarnings: stat.outputWarnings || [],
      parsedOutputs: stat.parsedOutputs || [],
      rawOutputPath: stat.rawOutputPath || null,
    })),
    debugEvents,
  };

  await fs.writeFile(path.join(runDir, 'run-manifest.json'), JSON.stringify(manifest, null, 2));
}

export async function writeLatestRunPointer({ cwd, runId }: { cwd: string, runId: string }): Promise<void> {
  const runsDir = path.join(cwd, '.singleton', 'runs');
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, LATEST_RUN_ID_FILE), `${runId}\n`);

  const latest = path.join(runsDir, 'latest');
  try {
    const stat = await fs.lstat(latest);
    if (stat.isSymbolicLink() || stat.isFile()) await fs.unlink(latest);
  } catch {
    // Missing or non-removable legacy pointer is non-critical.
  }
  try { await fs.symlink(runId, latest, 'dir'); } catch { /* non-critical on Windows */ }
}

export async function resolveLatestRunDir(root: string): Promise<string> {
  const runsDir = path.join(root, '.singleton', 'runs');
  const pointer = path.join(runsDir, LATEST_RUN_ID_FILE);

  try {
    const runId = (await fs.readFile(pointer, 'utf8')).trim();
    if (runId && !runId.includes('/') && !runId.includes('\\')) {
      const runDir = path.join(runsDir, runId);
      await fs.access(path.join(runDir, 'run-manifest.json'));
      return runDir;
    }
  } catch {
    // Fall back to legacy symlink path below.
  }

  return path.join(runsDir, 'latest');
}
