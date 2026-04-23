import { Router } from 'express';
import fs from 'node:fs/promises';
import { scanAgents } from '../../../cli/src/scanner.js';

export function agentsRouter(ctx) {
  const r = Router();

  r.get('/', async (_req, res) => {
    try {
      try {
        const raw = await fs.readFile(ctx.agentsCacheFile, 'utf8');
        return res.json(JSON.parse(raw));
      } catch {
        const agents = await scanAgents(ctx.root);
        return res.json({ scannedAt: new Date().toISOString(), root: ctx.root, agents });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/rescan', async (_req, res) => {
    try {
      const agents = await scanAgents(ctx.root);
      res.json({ scannedAt: new Date().toISOString(), root: ctx.root, agents });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}
