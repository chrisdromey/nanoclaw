import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, updateOfferStatus, getWatchedOffers } from './db.js';

describe('updateOfferStatus', () => {
  it('drops the watch when an offer leaves active, so dead listings stop surfacing as watched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dh-status-'));
    try {
      const db = openDatabase(join(dir, 'deal-hunter.db'));
      const id = Number(db.prepare(
        "INSERT INTO offers (source, source_id, title, watching) VALUES ('autotrader', 'x1', 't', 1)",
      ).run().lastInsertRowid);

      updateOfferStatus(db, id, 'removed');

      const row = db.prepare('SELECT status, watching FROM offers WHERE id = ?').get(id);
      expect(row).toEqual({ status: 'removed', watching: 0 });
      expect(getWatchedOffers(db)).toHaveLength(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
