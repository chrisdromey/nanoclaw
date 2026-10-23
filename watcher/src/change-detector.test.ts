/**
 * Price-change materiality gate and watch-condition crossing (handoff #1A).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase, type Offer } from './db.js';
import { detectWatchChanges } from './change-detector.js';
import type { ItemDetail } from './sources/ebay/types.js';

let db: Database.Database;
let t = 0;
const ts = () => `2026-09-${String(1 + Math.floor(t / 86400)).padStart(2, '0')} ${new Date((t++) * 1000).toISOString().slice(11, 19)}`;

function price(offerId: number, p: number): void {
  db.prepare('INSERT INTO prices (offer_id, price, observed_at) VALUES (?, ?, ?)').run(offerId, p, ts());
}
function evaluate(offerId: number): void {
  db.prepare("INSERT INTO evaluations (offer_id, hunt_id, decision, evaluated_at) VALUES (?, 1, 'watch', ?)").run(offerId, ts());
}
function offer(watchConditions?: Record<string, number>): Offer {
  return db.prepare('SELECT * FROM offers WHERE id = 1').get() as Offer;
}
function item(p: number): ItemDetail {
  return { itemId: 'x', title: 'Car', price: { value: String(p), currency: 'GBP' } } as ItemDetail;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  db.prepare("INSERT INTO hunts (id, name, vertical) VALUES (1, 'h', 'cars')").run();
  db.prepare("INSERT INTO offers (id, source, source_id, title, vertical, watching) VALUES (1, 'autotrader', 'a1', 'Car', 'cars', 1)").run();
});
afterEach(() => db.close());

describe('price-change materiality gate', () => {
  it('suppresses a small move', () => {
    price(1, 20000);
    evaluate(1);
    expect(detectWatchChanges(db, offer(), item(19900), false)).toEqual([]);
  });

  it('fires on a 3% drop with previousPrice = last-evaluated price', () => {
    price(1, 20000);
    evaluate(1);
    const changes = detectWatchChanges(db, offer(), item(19400), false);
    expect(changes.map((c) => c.type)).toEqual(['price_drop']);
    expect(changes[0].details).toMatchObject({ previousPrice: 20000, currentPrice: 19400 });
  });

  it('accumulates drift against the last-evaluated price', () => {
    price(1, 20000);
    evaluate(1);
    price(1, 19900);
    expect(detectWatchChanges(db, offer(), item(19800), false)).toEqual([]);
    price(1, 19800);
    const changes = detectWatchChanges(db, offer(), item(19700), false);
    expect(changes.map((c) => c.type)).toEqual(['price_drop']);
    expect(changes[0].details).toMatchObject({ previousPrice: 20000, currentPrice: 19700 });
  });

  it('does not re-fire when the price is unchanged since the last observation', () => {
    price(1, 20000);
    evaluate(1);
    price(1, 19000);
    expect(detectWatchChanges(db, offer(), item(19000), false)).toEqual([]);
  });

  it('falls back to the last observation when never evaluated', () => {
    price(1, 20000);
    expect(detectWatchChanges(db, offer(), item(19000), false).map((c) => c.type)).toEqual(['price_drop']);
    expect(detectWatchChanges(db, offer(), item(19900), false)).toEqual([]);
  });
});

describe('watch condition crossing', () => {
  beforeEach(() => {
    db.prepare("UPDATE offers SET watch_conditions = '{\"alert_if_price_below_gbp\": 17500}' WHERE id = 1").run();
  });

  it('fires once when the threshold is crossed', () => {
    price(1, 18000);
    const changes = detectWatchChanges(db, offer(), item(17300), false);
    expect(changes.map((c) => c.type)).toEqual(['price_drop', 'watch_condition_met']);
  });

  it('does not fire again while still below the threshold', () => {
    price(1, 17300);
    expect(detectWatchChanges(db, offer(), item(17300), false)).toEqual([]);
    expect(detectWatchChanges(db, offer(), item(17250), false)).toEqual([]);
  });
});
