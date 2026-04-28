#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import { style, line } from './theme.js';
import { scanAgents } from './scanner.js';
import { runPipeline } from './executor.js';
import { newAgentCommand } from './commands/new.js';
import { replCommand } from './commands/repl.js';

const program = new Command();

program
  .name('singleton')
  .description('Singleton Pipeline Builder — scan agents and build pipelines')
  .version('0.1.0');

program
  .command('scan')
  .description('Scan a repo for agent .md files')
  .argument('<path>', 'Path to repo to scan')
  .option('-o, --output <file>', 'Output JSON file', '.singleton/agents.json')
  .action(async (repoPath, opts) => {
    const absPath = path.resolve(repoPath);
    console.log(style.info(`Scanning ${absPath}...`));

    const agents = await scanAgents(absPath);

    if (agents.length === 0) {
      console.log(style.warn('No agents found (no .md files with ## Config section).'));
      return;
    }

    console.log(style.success(`\nFound ${agents.length} agent(s):\n`));
    for (const a of agents) {
      console.log(style.id(`  ${a.id}`) + style.muted(` — ${a.description || '(no description)'}`));
      console.log(style.muted(`    file:    ${path.relative(absPath, a.file)}`));
      console.log(style.info(`    source:`) + style.muted(`  ${a.source || 'repo'}`));
      if (a.provider) console.log(style.warn(`    provider:`) + style.muted(` ${a.provider}`));
      console.log(style.success(`    in:`) + style.muted(`      ${a.inputs.join(', ') || '(none)'}`));
      console.log(style.id(`    out:`) + style.muted(`     ${a.outputs.join(', ') || '(none)'}`));
      if (a.tags?.length) console.log(style.muted(`    tags:    ${a.tags.join(', ')}`));
      console.log();
    }

    const outPath = path.resolve(absPath, opts.output);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify({ scannedAt: new Date().toISOString(), root: absPath, agents }, null, 2));
    console.log(line.success(`Saved to ${path.relative(process.cwd(), outPath)}`));
  });

program
  .command('serve')
  .description('Start the pipeline builder server + web UI')
  .option('-p, --port <port>', 'Server port', '4317')
  .option('-r, --root <path>', 'Project root to scan', process.cwd())
  .action(async (opts) => {
    const { startServer } = await import('../../server/src/index.js');
    await startServer({ port: Number(opts.port), root: path.resolve(opts.root) });
  });

program
  .command('new')
  .description('Créer un nouvel agent .md en interactif')
  .option('-r, --root <path>', 'Racine du repo à scanner', process.cwd())
  .action(async (opts) => {
    await newAgentCommand(opts);
  });

program
  .command('run')
  .description('Run (dry-run) a pipeline JSON')
  .requiredOption('--pipeline <file>', 'Pipeline JSON file')
  .option('--dry-run', 'Skip API calls, just show resolved plan')
  .option('--verbose', 'Show prompts and outputs in the right panel')
  .action(async (opts) => {
    await runPipeline(opts.pipeline, { dryRun: opts.dryRun, verbose: opts.verbose });
  });

program
  .command('repl', { isDefault: true })
  .description('Shell interactif Singleton (défaut)')
  .option('-r, --root <path>', 'Racine du projet', process.cwd())
  .action(async (opts) => {
    await replCommand(opts);
  });

program.parseAsync(process.argv);
