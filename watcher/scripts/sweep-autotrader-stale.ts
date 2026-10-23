/**
 * One-off staleness sweep for AutoTrader offers — same logic as the scheduler's sweep, but
 * runs immediately (the scheduler defers its first sweep 4h after restart) and also covers
 * watched offers (which the daily cars watch poll would otherwise take a day to reach).
 *
 *   npx tsx scripts/sweep-autotrader-stale.ts [--hours 24] [--limit 2000]
 */
import Database from 'better-sqlite3';
import { DB_PATH } from '../src/config.js';
import { updateOfferStatus, updateOfferWatchFields, type Offer } from '../src/db.js';
import { getListingState } from '../src/sources/autotrader/detail.js';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? parseInt(process.argv[i + 1], 10) : d; };
const hours = arg('--hours', 24);
const limit = arg('--limit', 2000);

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');
const offers = db.prepare(
  `SELECT * FROM offers WHERE source='autotrader' AND status='active'
     AND datetime(last_seen_at) < datetime('now', '-' || ? || ' hours')
   ORDER BY watching DESC, last_seen_at ASC LIMIT ?`,
).all(hours, limit) as Offer[];

console.log(`${new Date().toISOString()} sweeping ${offers.length} offers`);
const tally = { active: 0, removed: 0, sold: 0, error: 0 };
for (const [i, o] of offers.entries()) {
  const r = await getListingState(o.source_id);
  if (r.error) { tally.error++; console.log(`#${o.id} ${o.source_id} ERROR ${r.error}`); continue; }
  if (r.status === 'removed') updateOfferStatus(db, o.id, 'removed');
  else if (r.status === 'sold') updateOfferStatus(db, o.id, 'ended');
  else updateOfferWatchFields(db, o.id, {});
  tally[r.status]++;
  if ((i + 1) % 50 === 0) console.log(`${new Date().toISOString()} ${i + 1}/${offers.length}`, JSON.stringify(tally));
}
console.log(`${new Date().toISOString()} done`, JSON.stringify(tally));
