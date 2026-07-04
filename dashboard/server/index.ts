import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT } from './config.js';
import { closeAll } from './db.js';
import { systemRoutes } from './routes/system.js';
import { overviewRoutes } from './routes/overview.js';
import { huntRoutes } from './routes/hunts.js';
import { offerRoutes } from './routes/offers.js';
import { searchRoutes } from './routes/searches.js';
import { agentRoutes } from './routes/agent.js';
import { eventRoutes } from './routes/events.js';
import { baselineRoutes } from './routes/baseline.js';
import { targetsRoutes } from './routes/targets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = new Hono();

// CORS for dev (Vite runs on different port)
app.use('/api/*', cors());

// API routes
app.route('/api', systemRoutes);
app.route('/api', overviewRoutes);
app.route('/api', huntRoutes);
app.route('/api', offerRoutes);
app.route('/api', searchRoutes);
app.route('/api', agentRoutes);
app.route('/api', eventRoutes);
app.route('/api', baselineRoutes);
app.route('/api', targetsRoutes);

// Health check
app.get('/api/health', (c) => c.json({ ok: true }));

// In production, serve the built SPA
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: 'dist/client' }));
  // SPA fallback
  app.get('*', serveStatic({ root: 'dist/client', path: '/index.html' }));
}

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Dashboard API running on http://localhost:${info.port}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  closeAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeAll();
  process.exit(0);
});
