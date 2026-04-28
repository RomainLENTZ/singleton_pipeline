import { spawn } from 'node:child_process';

export const claudeRunner = {
  id: 'claude',
  command: 'claude',

  async run({ cwd, systemPrompt, userPrompt, model }) {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'bypassPermissions',
      '--system-prompt',
      systemPrompt,
    ];

    if (model) args.push('--model', model);

    const raw = await new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`failed to parse claude output: ${err.message}\n${stdout.slice(0, 500)}`));
        }
      });

      child.stdin.write(userPrompt);
      child.stdin.end();
    });

    return {
      text: typeof raw.result === 'string' ? raw.result : JSON.stringify(raw),
      metadata: {
        provider: 'claude',
        model: raw.model ?? model ?? null,
        turns: Number(raw.num_turns || 0) || null,
        costUsd: Number(raw.total_cost_usd || 0) || null,
        tokens: {
          input: raw.usage?.input_tokens ?? null,
          output: raw.usage?.output_tokens ?? null,
        },
        raw,
      },
    };
  },
};
