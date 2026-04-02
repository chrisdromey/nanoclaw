import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { getNanoclawDb } from '../db.js';
import { LOGS_DIR } from '../config.js';

export const agentRoutes = new Hono();

interface LogMeta {
  filename: string;
  timestamp: string;
  group: string;
  duration_ms: number;
  exit_code: number;
  session_id: string | null;
  is_main: boolean;
}

function parseLogHeader(content: string): Partial<LogMeta> {
  const meta: Partial<LogMeta> = {};
  const lines = content.split('\n').slice(0, 20);
  for (const line of lines) {
    const [key, ...valueParts] = line.split(':');
    const value = valueParts.join(':').trim();
    switch (key.trim()) {
      case 'Timestamp':
        meta.timestamp = value;
        break;
      case 'Group':
        meta.group = value;
        break;
      case 'Duration':
        meta.duration_ms = parseInt(value);
        break;
      case 'Exit Code':
        meta.exit_code = parseInt(value);
        break;
      case 'Session ID':
        meta.session_id = value || null;
        break;
      case 'IsMain':
        meta.is_main = value === 'true';
        break;
    }
  }
  return meta;
}

function getContainerLogs(limit = 25, offset = 0): { logs: LogMeta[]; total: number } {
  try {
    const files = fs
      .readdirSync(LOGS_DIR)
      .filter((f) => f.startsWith('container-') && f.endsWith('.log'))
      .sort()
      .reverse();

    const total = files.length;
    const paged = files.slice(offset, offset + limit);

    const logs: LogMeta[] = paged.map((filename) => {
      const filePath = path.join(LOGS_DIR, filename);
      try {
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 1000);
        const meta = parseLogHeader(content);
        return {
          filename: filename.replace('.log', ''),
          timestamp: meta.timestamp || '',
          group: meta.group || 'unknown',
          duration_ms: meta.duration_ms || 0,
          exit_code: meta.exit_code ?? -1,
          session_id: meta.session_id || null,
          is_main: meta.is_main ?? false,
        };
      } catch {
        return {
          filename: filename.replace('.log', ''),
          timestamp: '',
          group: 'unknown',
          duration_ms: 0,
          exit_code: -1,
          session_id: null,
          is_main: false,
        };
      }
    });

    return { logs, total };
  } catch {
    return { logs: [], total: 0 };
  }
}

agentRoutes.get('/agent/activity', (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = Math.min(parseInt(c.req.query('limit') || '25'), 100);
  const offset = (page - 1) * limit;

  // Merge task_run_logs and container logs
  let taskLogs: Array<Record<string, unknown>> = [];
  try {
    const db = getNanoclawDb();
    taskLogs = db
      .prepare(
        `SELECT trl.*, st.prompt, st.schedule_type
        FROM task_run_logs trl
        LEFT JOIN scheduled_tasks st ON st.id = trl.task_id
        ORDER BY trl.run_at DESC
        LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>;
  } catch {}

  const containerLogs = getContainerLogs(limit, offset);

  return c.json({
    task_logs: taskLogs,
    container_logs: containerLogs.logs,
    total_container_logs: containerLogs.total,
    page,
    limit,
  });
});

agentRoutes.get('/agent/logs/:id', (c) => {
  const id = c.req.param('id');
  const filename = `${id}.log`;
  const filePath = path.join(LOGS_DIR, filename);

  try {
    if (!fs.existsSync(filePath)) {
      return c.json({ error: 'Log not found' }, 404);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return c.json({ filename: id, content });
  } catch {
    return c.json({ error: 'Failed to read log' }, 500);
  }
});
