import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'pipeline';
}

export function pipelinesRouter(ctx) {
  const r = Router();

  r.get('/', async (_req, res) => {
    try {
      await fs.mkdir(ctx.pipelinesDir, { recursive: true });
      const files = (await fs.readdir(ctx.pipelinesDir)).filter((f) => f.endsWith('.json'));
      const items = (await Promise.all(files.map(async (f) => {
        try {
          const raw = await fs.readFile(path.join(ctx.pipelinesDir, f), 'utf8');
          const parsed = JSON.parse(raw);
          if (!parsed.name) return null;
          return { file: f, ...parsed };
        } catch {
          return null;
        }
      }))).filter(Boolean);
      res.json({ pipelines: items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/:name', async (req, res) => {
    try {
      const file = path.join(ctx.pipelinesDir, `${safeName(req.params.name)}.json`);
      const raw = await fs.readFile(file, 'utf8');
      res.json(JSON.parse(raw));
    } catch (err) {
      res.status(404).json({ error: 'not found' });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const { name, steps = [], nodes, edges } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name required' });
      await fs.mkdir(ctx.pipelinesDir, { recursive: true });
      const safe = safeName(name);
      const file = path.join(ctx.pipelinesDir, `${safe}.json`);
      const payload = {
        name: safe,
        created: new Date().toISOString(),
        steps,
        nodes,
        edges
      };
      await fs.writeFile(file, JSON.stringify(payload, null, 2));
      res.json({ ok: true, file: `${safe}.json`, ...payload });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:name', async (req, res) => {
    try {
      const file = path.join(ctx.pipelinesDir, `${safeName(req.params.name)}.json`);
      await fs.unlink(file);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: 'not found' });
    }
  });

  return r;
}
