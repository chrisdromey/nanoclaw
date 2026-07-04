import path from 'path';

const PROJECT_ROOT = process.cwd();
const NANOCLAW_ROOT = path.resolve(PROJECT_ROOT, '..');

export const PORT = parseInt(process.env.PORT || '3456', 10);

export const DEAL_HUNTER_DB = path.resolve(
  process.env.DEAL_HUNTER_DB ||
    path.join(NANOCLAW_ROOT, 'groups/telegram_main/deal-hunter.db'),
);

// The group directory the deal-hunter DB lives in. Relative file paths stored
// in the DB (e.g. knowledge_base.kb_path) resolve against this, and served
// files must stay inside it (traversal guard in routes/targets.ts).
export const GROUP_DIR = path.dirname(DEAL_HUNTER_DB);

export const NANOCLAW_DB = path.resolve(
  process.env.NANOCLAW_DB ||
    path.join(NANOCLAW_ROOT, 'store/messages.db'),
);

export const LOGS_DIR = path.resolve(
  process.env.LOGS_DIR ||
    path.join(NANOCLAW_ROOT, 'groups/telegram_main/logs'),
);

export const DAILY_API_BUDGET = 4500;

export { NANOCLAW_ROOT };
