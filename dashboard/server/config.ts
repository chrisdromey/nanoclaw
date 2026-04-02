import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NANOCLAW_ROOT = path.resolve(PROJECT_ROOT, '..');

export const PORT = parseInt(process.env.PORT || '3456', 10);

export const DEAL_HUNTER_DB = path.resolve(
  process.env.DEAL_HUNTER_DB ||
    path.join(NANOCLAW_ROOT, 'groups/telegram_main/deal-hunter.db'),
);

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
