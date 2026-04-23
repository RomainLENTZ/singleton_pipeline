import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.singleton', 'dist', 'build', '.next', '.cache']);

async function walk(root, rel = '', out = []) {
  const abs = path.join(root, rel);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.singleton') {
      if (e.isDirectory()) continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(root, path.join(rel, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(rel, e.name));
    }
  }
  return out;
}

export function filesRouter(ctx) {
  const r = Router();

  r.get('/', async (req, res) => {
    try {
      const ext = String(req.query.ext || '').replace(/^\./, '').toLowerCase();
      const all = await walk(ctx.root);
      const filtered = ext
        ? all.filter((f) => f.toLowerCase().endsWith(`.${ext}`))
        : all;
      filtered.sort();
      res.json({ root: ctx.root, files: filtered });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}
