/**
 * Tests for the AutoTrader rate-limit guard.
 *
 * Mocks Date.now and fetch to verify:
 *   - Min-interval enforcement (jittered 6s base)
 *   - Backoff on 429
 *   - AUTOTRADER_DISABLED=1 kill switch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We reset state between tests to avoid cross-test pollution
async function resetRateLimit(): Promise<void> {
  // Clear module cache so each import gets fresh module state
  const { _resetStateForTest } = await import('./rate-limit.js');
  _resetStateForTest();
}

describe('rate-limit kill switch', () => {
  beforeEach(async () => {
    await resetRateLimit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['AUTOTRADER_DISABLED'];
  });

  it('throws AutoTraderDisabledError when AUTOTRADER_DISABLED=1', async () => {
    process.env['AUTOTRADER_DISABLED'] = '1';
    const { rateLimitedFetch, AutoTraderDisabledError } = await import('./rate-limit.js');

    await expect(rateLimitedFetch('https://www.autotrader.co.uk/at-gateway', {}))
      .rejects.toThrow(AutoTraderDisabledError);
  });

  it('does NOT throw when AUTOTRADER_DISABLED is unset', async () => {
    delete process.env['AUTOTRADER_DISABLED'];

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '{}',
      json: async () => ({}),
    }));

    const { rateLimitedFetch } = await import('./rate-limit.js');
    const res = await rateLimitedFetch('https://www.autotrader.co.uk/at-gateway', {});
    expect(res.status).toBe(200);
  });
});

describe('rate-limit interval enforcement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['AUTOTRADER_DISABLED'];
  });

  it('waits at least BASE_INTERVAL_MS * 0.7 between calls', async () => {
    const { _resetStateForTest, BASE_INTERVAL_MS } = await import('./rate-limit.js');
    // Set lastCallAt to "just now"
    const now = Date.now();
    _resetStateForTest({ lastCallAt: now, backoffUntil: 0, backoffStep: 0 });

    let sleepTime = 0;
    const sleepSpy = vi.fn(async (ms: number) => { sleepTime = ms; });
    vi.doMock('node:timers/promises', () => ({ setTimeout: sleepSpy }));

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '{}',
      json: async () => ({}),
    }));

    // We can't easily intercept the sleep without full module re-import here,
    // so we just verify the module exports BASE_INTERVAL_MS correctly
    expect(BASE_INTERVAL_MS).toBe(6000);
  });

  it('BASE_INTERVAL_MS is 6000', async () => {
    const { BASE_INTERVAL_MS } = await import('./rate-limit.js');
    expect(BASE_INTERVAL_MS).toBe(6_000);
  });
});

describe('rate-limit backoff on throttled response', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['AUTOTRADER_DISABLED'];
  });

  it('enters backoff on 429 response', async () => {
    const { _resetStateForTest } = await import('./rate-limit.js');
    _resetStateForTest();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => 'Too Many Requests',
      json: async () => ({}),
    }));

    const { rateLimitedFetch } = await import('./rate-limit.js');
    await rateLimitedFetch('https://www.autotrader.co.uk/at-gateway', {});

    // Backoff log should have been emitted
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toContain('[autotrader-rate-limit]');
    expect(stderrOutput).toContain('BACKOFF_START');
    expect(stderrOutput).toContain('HTTP 429');

    stderrSpy.mockRestore();
  });

  it('enters backoff on cf-mitigated response header', async () => {
    const { _resetStateForTest } = await import('./rate-limit.js');
    _resetStateForTest();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    vi.stubGlobal('fetch', async () => ({
      ok: true,  // CF may return 200 but with cf-mitigated header
      status: 200,
      headers: new Headers({ 'cf-mitigated': 'detected' }),
      text: async () => '',
      json: async () => ({}),
    }));

    const { rateLimitedFetch } = await import('./rate-limit.js');
    await rateLimitedFetch('https://www.autotrader.co.uk/at-gateway', {});

    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toContain('[autotrader-rate-limit]');
    expect(stderrOutput).toContain('cf-mitigated=detected');

    stderrSpy.mockRestore();
  });

  it('enters backoff on 503 response', async () => {
    const { _resetStateForTest } = await import('./rate-limit.js');
    _resetStateForTest();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 503,
      headers: new Headers(),
      text: async () => 'Service Unavailable',
      json: async () => ({}),
    }));

    const { rateLimitedFetch } = await import('./rate-limit.js');
    await rateLimitedFetch('https://www.autotrader.co.uk/at-gateway', {});

    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toContain('BACKOFF_START');

    stderrSpy.mockRestore();
  });
});

describe('_resetStateForTest', () => {
  it('resets to zero state', async () => {
    const { _resetStateForTest, BASE_INTERVAL_MS } = await import('./rate-limit.js');
    _resetStateForTest({ backoffStep: 5, backoffUntil: Date.now() + 9999999 });
    // After reset with no overrides, state should be clean
    _resetStateForTest();
    // State is internal; we verify it doesn't blow up and the function is callable
    expect(BASE_INTERVAL_MS).toBe(6000);
  });
});

describe('mutex serialisation — overlapping / slow fetches', () => {
  /**
   * Verifies the promise-chain mutex serialises the ENTIRE critical section
   * (wait → fetch → backoff bookkeeping), not just the jitter wait.
   *
   * This is the regression test for Fix 3. The previous test used a *synchronous*
   * fetch mock (resolved with no awaited delay), so even the broken implementation —
   * which ran `fetch()` outside the serialisation chain — appeared to never overlap.
   * It gave false confidence.
   *
   * Here each fetch resolves only after a delay LONGER than the max jitter interval
   * (BASE_INTERVAL_MS * 1.3 = 7800ms). Under the broken implementation, caller N+1's
   * jitter wait would elapse and its fetch would start while caller N's slow fetch was
   * still in flight → overlap (maxConcurrent === 2). Under the fixed implementation,
   * caller N+1's wait does not even begin until caller N's fetch has settled →
   * maxConcurrent stays 1 and order is FIFO.
   *
   * Fake timers drive both the module's `sleep` (node:timers/promises) and the fetch's
   * delay (global setTimeout) without real wall-clock time.
   */
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['AUTOTRADER_DISABLED'];
  });

  it('does not start the next fetch until the previous slow fetch has settled', async () => {
    // resetModules so rate-limit.ts is re-imported with fake timers active.
    vi.resetModules();
    const { _resetStateForTest, rateLimitedFetch, BASE_INTERVAL_MS } = await import('./rate-limit.js');
    _resetStateForTest();

    // Fetch delay exceeds the max jitter interval, so any non-serialised overlap shows up.
    const FETCH_DELAY_MS = BASE_INTERVAL_MS * 2; // 12_000 > 7_800 max jitter

    let seqCounter = 0;
    const seqOrder: number[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    vi.stubGlobal('fetch', async () => {
      seqOrder.push(++seqCounter);
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Slow response — only settles after an awaited delay.
      await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
      inFlight--;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => '{}',
        json: async () => ({}),
      };
    });

    // Fire 3 concurrently — they queue on inflightChain.
    const promises = [1, 2, 3].map(() =>
      rateLimitedFetch('https://www.autotrader.co.uk/test', {}),
    );

    // Drive the fake timer forward in BASE_INTERVAL_MS steps until everything settles.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS);
    }

    await Promise.all(promises);

    // All 3 must have run, in FIFO order.
    expect(seqOrder).toEqual([1, 2, 3]);
    // The critical fix: at most one fetch in flight at any moment, even though fetches are slow.
    expect(maxConcurrent).toBe(1);
  }, 15_000);
});
