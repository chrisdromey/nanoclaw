/**
 * Notifier tests.
 * Verifies source-aware labels and vertical evaluator_skill in prompts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./config.js', () => ({
  IPC_DIR: '/tmp/test-ipc-notifier',
  CHAT_JID: 'tg:123',
}));

// Reset verticals cache between tests
import { _resetCache } from './verticals.js';

// Spy on fs methods to intercept writes
let mkdirSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;
const capturedWrites: Array<{ path: string; content: string }> = [];

function captureLastPrompt(): string {
  if (capturedWrites.length === 0) throw new Error('No IPC task written');
  const last = capturedWrites[capturedWrites.length - 1];
  const payload = JSON.parse(last.content) as { prompt: string };
  return payload.prompt;
}

// Import notifier AFTER setting up spies (below in beforeEach)
import { sendUrgentNotification, sendNewOffersNotification, sendPriceChangeNotification } from './notifier.js';
import type { Change } from './change-detector.js';

function setupFsSpies() {
  mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
    capturedWrites.push({ path: args[0] as string, content: args[1] as string });
  });
}

const makeChange = (overrides: Partial<Change> = {}): Change => ({
  type: 'auction_ending',
  offerId: 1,
  source: 'ebay',
  sourceId: 'v1|123|0',
  title: 'Test GPU',
  urgent: true,
  details: {
    hoursLeft: 5.5,
    threshold: 6,
    currentBid: '250.00',
    bidCount: 3,
  },
  ...overrides,
});

describe('sendUrgentNotification', () => {
  beforeEach(() => {
    capturedWrites.length = 0;
    _resetCache();
    setupFsSpies();
  });

  afterEach(() => {
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('includes source id label in prompt (not hardcoded "eBay ID")', () => {
    sendUrgentNotification(1, 'My Hunt', [makeChange({ source: 'ebay', sourceId: 'v1|abc|0' })], 'computers');
    const prompt = captureLastPrompt();

    expect(prompt).toContain('ebay ID: v1|abc|0');
    expect(prompt).not.toContain('eBay ID:');
  });

  it('uses autotrader as source label when source is autotrader', () => {
    sendUrgentNotification(1, 'Car Hunt', [makeChange({
      source: 'autotrader',
      sourceId: 'advert-999',
      type: 'watch_condition_met',
      details: { condition: 'price_below_threshold', threshold: 10000, currentPrice: 9500 },
    })], 'cars');
    const prompt = captureLastPrompt();

    expect(prompt).toContain('autotrader ID: advert-999');
  });

  it('references listing-evaluation skill for computers vertical', () => {
    sendUrgentNotification(1, 'PC Hunt', [makeChange()], 'computers');
    const prompt = captureLastPrompt();

    expect(prompt).toContain('listing-evaluation skill');
  });

  it('falls back to listing-evaluation for unknown vertical', () => {
    sendUrgentNotification(1, 'Mystery Hunt', [makeChange()], 'nonexistent-vertical');
    const prompt = captureLastPrompt();

    expect(prompt).toContain('listing-evaluation skill');
  });
});

describe('sendNewOffersNotification', () => {
  beforeEach(() => {
    capturedWrites.length = 0;
    _resetCache();
    setupFsSpies();
  });

  afterEach(() => {
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('references evaluator skill for computers vertical', () => {
    sendNewOffersNotification([
      { huntId: 1, huntName: 'PC Hunt', newCount: 5, hasBaseline: true, vertical: 'computers' },
    ]);
    const prompt = captureLastPrompt();

    expect(prompt).toContain('listing-evaluation skill');
  });

  it('uses generic message for mixed verticals', () => {
    sendNewOffersNotification([
      { huntId: 1, huntName: 'PC Hunt', newCount: 2, hasBaseline: true, vertical: 'computers' },
      { huntId: 2, huntName: 'Car Hunt', newCount: 1, hasBaseline: false, vertical: 'cars' },
    ]);
    const prompt = captureLastPrompt();

    expect(prompt).toContain('appropriate evaluator skill');
  });

  it('shows baseline warning when hasBaseline is false', () => {
    sendNewOffersNotification([
      { huntId: 1, huntName: 'Unbaselined', newCount: 3, hasBaseline: false, vertical: 'computers' },
    ]);
    const prompt = captureLastPrompt();

    expect(prompt).toContain('BASELINE MISSING');
  });
});

describe('sendPriceChangeNotification', () => {
  beforeEach(() => {
    capturedWrites.length = 0;
    _resetCache();
    setupFsSpies();
  });

  afterEach(() => {
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('includes source id and references evaluator skill', () => {
    sendPriceChangeNotification(1, 'PC Hunt', [
      {
        type: 'price_drop',
        offerId: 1,
        source: 'ebay',
        sourceId: 'v1|789|0',
        title: 'RTX 3080',
        urgent: false,
        details: { previousPrice: 400, currentPrice: 350 },
      },
    ], 'computers');
    const prompt = captureLastPrompt();

    expect(prompt).toContain('ebay ID: v1|789|0');
    expect(prompt).toContain('listing-evaluation skill');
    expect(prompt).not.toContain('eBay ID:');
  });
});
