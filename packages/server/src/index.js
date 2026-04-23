import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, '../../web/dist');
import { agentsRouter } from './routes/agents.js';
import { pipelinesRouter } from './routes/pipelines.js';
import { filesRouter } from './routes/files.js';

export async function startServer({ port = 4317, root = process.cwd() } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const ctx = {
    root,
    pipelinesDir: path.join(root, '.singleton', 'pipelines'),
    agentsCacheFile: path.join(root, '.singleton', 'agents.json')
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true, root }));
  app.use('/api/agents', agentsRouter(ctx));
  app.use('/api/pipelines', pipelinesRouter(ctx));
  app.use('/api/files', filesRouter(ctx));

  app.use(express.static(WEB_DIST));
  app.get('*', (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Singleton server listening on http://localhost:${port}`);
      console.log(`Project root: ${root}`);
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer({ port: Number(process.env.PORT) || 4317, root: process.cwd() });
}
