/**
 * AutoTrader scrape spike - puppeteer-extra + stealth plugin.
 *
 * Low-volume probe: 1 search page, 1 detail page, 1 pagination check.
 * Captures screenshots + JSON samples + raw HTML for offline inspection.
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

puppeteer.use(StealthPlugin());

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ||
  '/root/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';

const HERE = new URL('.', import.meta.url).pathname;
const SCREENSHOTS = `${HERE}screenshots`;
const SAMPLES = `${HERE}samples`;

const SEARCH_URL =
  'https://www.autotrader.co.uk/car-search?postcode=LE11AB&make=AUDI&model=A4&price-to=15000';

// "5 second pause" helper used between page loads to keep volume gentle
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const timings = {};

async function ts(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - t0);
  timings[label] = ms;
  console.log(`[timing] ${label}: ${ms}ms`);
  return result;
}

async function dismissCookies(page) {
  // AutoTrader uses Sourcepoint CMP — it lives in a <iframe>.
  // We try multiple strategies: button text, iframe selector, then JS click.
  try {
    // Wait a moment for CMP to inject
    await sleep(1500);

    // Look for known sourcepoint iframe
    const frames = page.frames();
    let consentFrame = null;
    for (const f of frames) {
      const url = f.url() || '';
      const name = f.name() || '';
      if (/sp-message|sourcepoint|consent|privacy-mgmt|cmp/i.test(url + name)) {
        consentFrame = f;
        console.log(`[cookies] found consent frame: ${url || name}`);
        break;
      }
    }

    const target = consentFrame || page;

    // Try common button labels (Sourcepoint, OneTrust, custom)
    const buttonTexts = [
      'Accept all',
      'Accept All',
      'Accept all cookies',
      'I Accept',
      'I accept',
      'AGREE',
      'Agree',
      'OK',
      'Got it',
      'Allow all',
    ];

    const clicked = await target.evaluate((labels) => {
      const all = Array.from(document.querySelectorAll('button, a'));
      for (const el of all) {
        const txt = (el.textContent || '').trim();
        if (labels.some((l) => txt === l || txt.toLowerCase() === l.toLowerCase())) {
          el.click();
          return txt;
        }
      }
      // Fallback by attribute
      const byTitle = document.querySelector(
        'button[title*="Accept" i], button[aria-label*="Accept" i]'
      );
      if (byTitle) {
        byTitle.click();
        return byTitle.textContent || byTitle.getAttribute('title') || 'attr-match';
      }
      return null;
    }, buttonTexts);

    if (clicked) {
      console.log(`[cookies] clicked: "${clicked}"`);
      await sleep(1500);
      return true;
    }

    console.log('[cookies] no consent button matched');
    return false;
  } catch (err) {
    console.log(`[cookies] error: ${err.message}`);
    return false;
  }
}

async function detectChallenge(page) {
  // Look for known WAF/CAPTCHA fingerprints
  const html = await page.content();
  const lower = html.slice(0, 5000).toLowerCase();
  const signals = [];
  if (lower.includes('pardon our interruption')) signals.push('imperva-pardon');
  if (lower.includes('incapsula')) signals.push('incapsula');
  if (lower.includes('px-captcha') || lower.includes('perimeterx')) signals.push('perimeterx');
  if (lower.includes('cloudflare') && lower.includes('challenge')) signals.push('cloudflare');
  if (lower.includes('are you a human')) signals.push('human-check');
  if (lower.includes('access denied')) signals.push('access-denied');
  // Page title check
  const title = await page.title();
  return { title, signals, htmlSnippet: html.slice(0, 800) };
}

async function extractSearchResults(page) {
  // We try DOM selectors first (the visible card list), then fall back to
  // looking for __NEXT_DATA__ which is common on Next.js apps.
  const domResults = await page.evaluate(() => {
    // Search result cards: look for links to /car-details/
    const seenIds = new Set();
    const out = [];
    const anchors = Array.from(document.querySelectorAll('a[href*="/car-details/"]'));

    // Words that are overlays/badges, not the listing title
    const SKIP_TITLES = new Set([
      'ad',
      'reserve online',
      'loading...',
      'lower price',
      'fair price',
      'higher price',
      'great price',
      'low price',
    ]);

    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/car-details\/(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      // Walk up to the card container (heuristic: nearest ancestor section/article/li)
      let card = a;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        if (/^(article|section|li)$/i.test(card.tagName)) break;
      }
      const text = (card.innerText || '').trim();
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

      // Title: first line that isn't a known overlay/badge and isn't a slide counter (e.g. "1/44")
      const title = lines.find(
        (l) =>
          !SKIP_TITLES.has(l.toLowerCase()) &&
          !/^\d+\/\d+$/.test(l) &&
          !/^£/.test(l) &&
          l.length > 2,
      );

      // Heuristic field extraction from text lines
      const priceLine = lines.find((l) => /£\s?\d/.test(l));
      // The pure price (just "£14,500") usually appears separately too
      const pureMatch = lines.find((l) => /^£[\d,]+$/.test(l));
      const mileageLine = lines.find((l) => /\bmiles\b/i.test(l));
      const yearLine = lines.find((l) => /^(19|20)\d{2}\b/.test(l));
      const fuelLine = lines.find((l) =>
        /^(petrol|diesel|hybrid|electric|plug-in hybrid)$/i.test(l),
      );
      const transLine = lines.find((l) => /^(automatic|manual)$/i.test(l));
      // Location often appears as a line containing distance ("· 27 miles away")
      const distLine = lines.find((l) => /miles? away/i.test(l));

      out.push({
        id,
        url: href.startsWith('http') ? href : `https://www.autotrader.co.uk${href}`,
        title: title || a.textContent?.trim() || null,
        price: pureMatch || null,
        price_text: priceLine || null,
        mileage_text: mileageLine || null,
        year_text: yearLine || null,
        fuel: fuelLine || null,
        transmission: transLine || null,
        distance: distLine || null,
        raw_text_excerpt: lines.slice(0, 10),
      });
    }
    return out;
  });

  // Also grab __NEXT_DATA__ if available
  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || 'null');
    } catch {
      return { _parseError: true, raw: el.textContent?.slice(0, 500) };
    }
  });

  return { dom: domResults, nextData };
}

async function extractDetailPage(page) {
  const data = await page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || '').trim() : null;
    };

    // Title — h1 is reliable
    const titleEl = document.querySelector('h1');
    const title = titleEl ? titleEl.textContent.trim() : null;

    // Price — find smallest element whose text is just "£12,345"
    let price = null;
    const priceCandidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = (el.textContent || '').trim();
      return /^£[\d,]+$/.test(t) && el.children.length === 0;
    });
    if (priceCandidates.length) price = priceCandidates[0].textContent.trim();

    // Key specs — find paired <p> elements where the value <p> is the immediate
    // sibling of the label <p>. This is how AutoTrader's "key specs" block renders.
    const spec = {};
    const specKeyMap = {
      registration: 'registration',
      'fuel type': 'fuel',
      'body type': 'body',
      engine: 'engine',
      gearbox: 'transmission',
      doors: 'doors',
      seats: 'seats',
      'body colour': 'colour',
      mileage: 'mileage',
      year: 'year',
      'ulez compliant': 'ulez',
      owners: 'owners',
      'previous owners': 'owners',
      'service history': 'service_history',
    };

    // Pattern 1: sibling <p> pairs (the main "Key specs" panel)
    Array.from(document.querySelectorAll('p')).forEach((p) => {
      const label = (p.textContent || '').trim().toLowerCase();
      const mapped = specKeyMap[label];
      if (!mapped) return;
      const sib = p.nextElementSibling;
      if (sib && sib.tagName === 'P') {
        const val = (sib.textContent || '').trim();
        if (val && !spec[mapped]) spec[mapped] = val;
      }
    });

    // Pattern 2: scan leaf text for free-floating tokens (mileage button, etc.)
    const allLeafText = Array.from(document.querySelectorAll('li, span, div, dt, dd, button, p'))
      .filter((el) => el.children.length === 0)
      .map((el) => (el.textContent || '').trim())
      .filter((t) => t && t.length < 60);
    for (const t of allLeafText) {
      if (!spec.year && /^(19|20)\d{2}\s*\(\d+ reg\)$/.test(t)) spec.year = t;
      else if (!spec.mileage && /^[\d,]+\s+miles$/i.test(t)) spec.mileage = t;
      else if (!spec.reg_plate && /^[A-Z]{2}\d{2}\s?[A-Z]{3}$/.test(t)) spec.reg_plate = t;
    }

    // Seller block — try several patterns. AutoTrader renders "From <Dealer Name>"
    // on the listing page.
    let sellerName = null;
    const fromPattern = Array.from(document.querySelectorAll('p, span, a')).find((el) => {
      const t = (el.textContent || '').trim();
      return /^From\s+.+/.test(t) && t.length < 80 && el.children.length <= 1;
    });
    if (fromPattern) {
      sellerName = fromPattern.textContent.trim().replace(/^From\s+/i, '');
    }

    // Fallback: link to a /dealers/ URL
    if (!sellerName) {
      const dealerLink = document.querySelector('a[href*="/dealers/"]');
      if (dealerLink) sellerName = dealerLink.textContent.trim();
    }

    // Seller type: trade vs private
    const bodyText = document.body.innerText || '';
    let sellerType = null;
    if (/private seller/i.test(bodyText)) sellerType = 'private';
    else if (/trade seller|trade ad|\/dealers\//i.test(bodyText) || document.querySelector('a[href*="/dealers/"]')) {
      sellerType = 'trade';
    }

    // Dealer rating (number near sellerName)
    let dealerRating = null;
    const ratingMatch = bodyText.match(/\b([1-5]\.\d)\b/);
    if (ratingMatch) dealerRating = ratingMatch[1];

    // Location: scan for postcode pattern
    const postcodeMatch = bodyText.match(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/);
    const postcode = postcodeMatch ? postcodeMatch[0] : null;

    // City/town + distance: AutoTrader shows "<City> · <N miles away>" near seller block
    let cityText = null;
    let distanceText = null;
    const distanceEl = Array.from(document.querySelectorAll('span, p')).find((el) => {
      const t = (el.textContent || '').trim();
      return /^\d+\s+miles?\s+away$/i.test(t);
    });
    if (distanceEl) {
      distanceText = distanceEl.textContent.trim();
      const prev = distanceEl.previousElementSibling;
      if (prev) cityText = prev.textContent.trim();
    }

    // Description
    const descriptionEl =
      document.querySelector('[data-testid="description"]') ||
      document.querySelector('[class*="description"]');
    const description = descriptionEl ? descriptionEl.textContent.trim().slice(0, 2000) : null;

    // Images
    const imgs = Array.from(document.querySelectorAll('img'))
      .map((i) => i.src)
      .filter((s) => s && /autotrader|m\.atcdn/i.test(s));

    // Try to find embedded JSON
    let embedded = null;
    const nextEl = document.getElementById('__NEXT_DATA__');
    if (nextEl) {
      try {
        embedded = JSON.parse(nextEl.textContent || 'null');
      } catch {}
    }

    // JSON-LD
    const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => {
        try {
          return JSON.parse(s.textContent || 'null');
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return {
      url: location.href,
      title,
      price,
      spec,
      sellerName,
      sellerType,
      dealerRating,
      postcode,
      cityText,
      distanceText,
      description,
      imageCount: imgs.length,
      imageSample: imgs.slice(0, 5),
      hasNextData: !!embedded,
      jsonLd: ld,
    };
  });

  return data;
}

async function main() {
  await mkdir(SCREENSHOTS, { recursive: true });
  await mkdir(SAMPLES, { recursive: true });

  const launchT0 = performance.now();
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,900',
    ],
  });
  timings.browser_launch = Math.round(performance.now() - launchT0);
  console.log(`[timing] browser_launch: ${timings.browser_launch}ms`);

  const result = {
    started_at: new Date().toISOString(),
    chrome_version: null,
    search_url: SEARCH_URL,
    challenge_detected: null,
    cookie_consent: null,
    search: null,
    detail: null,
    pagination: null,
    timings,
    errors: [],
  };

  try {
    result.chrome_version = await browser.version();
    console.log(`[info] chrome: ${result.chrome_version}`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    // --- 1. SEARCH PAGE ---
    console.log(`[step] navigate -> ${SEARCH_URL}`);
    await ts('search_goto', () =>
      page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    );

    // Let JS settle a moment
    await sleep(3000);

    result.challenge_detected = await detectChallenge(page);
    console.log(`[step] title="${result.challenge_detected.title}" signals=${JSON.stringify(result.challenge_detected.signals)}`);

    // Cookie consent
    result.cookie_consent = await dismissCookies(page);

    // Allow lazy results to render — scroll halfway down to trigger lazy-loaded card content
    await page.evaluate(() => window.scrollTo(0, 800));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(2500);

    await page.screenshot({ path: `${SCREENSHOTS}/01-search.png`, fullPage: false });
    await writeFile(`${SAMPLES}/01-search.html`, await page.content());

    const search = await ts('search_extract', () => extractSearchResults(page));
    result.search = {
      dom_count: search.dom.length,
      has_next_data: !!search.nextData,
      next_data_keys: search.nextData ? Object.keys(search.nextData) : null,
      sample: search.dom.slice(0, 5),
    };
    await writeFile(`${SAMPLES}/01-search-results.json`, JSON.stringify(search.dom, null, 2));
    if (search.nextData) {
      await writeFile(`${SAMPLES}/01-search-nextdata.json`, JSON.stringify(search.nextData, null, 2));
    }
    console.log(`[step] dom_results=${search.dom.length} next_data=${!!search.nextData}`);

    // --- 2. DETAIL PAGE ---
    if (search.dom.length > 0) {
      const targetUrl = search.dom[0].url;
      console.log(`[step] navigate -> ${targetUrl}`);
      await sleep(4000); // be polite

      // Track XHR responses so we can spot the data endpoint(s)
      const xhrLog = [];
      const xhrListener = (resp) => {
        const url = resp.url();
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json') && (url.includes('autotrader') || url.includes('atcdn'))) {
          xhrLog.push({ url, status: resp.status(), ct });
        }
      };
      page.on('response', xhrListener);

      await ts('detail_goto', () =>
        page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45_000 })
      );
      // Try to wait for the price to render — main signal that hydration ran
      try {
        await page.waitForFunction(
          () => /£[\d,]+/.test(document.body.innerText),
          { timeout: 15_000 }
        );
      } catch {
        console.log('[detail] price text never appeared');
      }
      await sleep(2000);

      // Cookie banner may re-appear on detail page in some flows
      await dismissCookies(page);
      await sleep(1000);

      page.off('response', xhrListener);

      await page.screenshot({ path: `${SCREENSHOTS}/02-detail.png`, fullPage: false });
      await writeFile(`${SAMPLES}/02-detail.html`, await page.content());
      await writeFile(`${SAMPLES}/02-detail-xhr.json`, JSON.stringify(xhrLog, null, 2));

      const detail = await ts('detail_extract', () => extractDetailPage(page));
      detail.xhr_endpoints = xhrLog.slice(0, 30);
      result.detail = detail;
      await writeFile(`${SAMPLES}/02-detail.json`, JSON.stringify(detail, null, 2));
      console.log(`[step] detail title="${detail.title}" price="${detail.price}" imgs=${detail.imageCount} xhrs=${xhrLog.length}`);
    } else {
      result.errors.push('no_search_results_for_detail');
    }

    // --- 3. PAGINATION ---
    const pageTwoUrl = SEARCH_URL + '&page=2';
    console.log(`[step] navigate -> ${pageTwoUrl}`);
    await sleep(4000);
    await ts('page2_goto', () =>
      page.goto(pageTwoUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    );
    await sleep(3000);
    await page.screenshot({ path: `${SCREENSHOTS}/03-search-page2.png`, fullPage: false });
    const p2 = await extractSearchResults(page);
    const page1Ids = new Set((result.search.sample || []).map((r) => r.id));
    const p2Ids = p2.dom.map((r) => r.id);
    result.pagination = {
      dom_count: p2.dom.length,
      sample_ids: p2Ids.slice(0, 5),
      ids_differ_from_page1: p2Ids.length > 0 && !p2Ids.every((id) => page1Ids.has(id)),
    };
    await writeFile(`${SAMPLES}/03-page2-results.json`, JSON.stringify(p2.dom, null, 2));
    console.log(`[step] page2_count=${p2.dom.length} differs=${result.pagination.ids_differ_from_page1}`);
  } catch (err) {
    result.errors.push(`fatal: ${err.message}`);
    console.error('[fatal]', err);
  } finally {
    await browser.close();
  }

  result.finished_at = new Date().toISOString();
  result.timings = timings;
  await writeFile(`${SAMPLES}/00-run-summary.json`, JSON.stringify(result, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    challenge: result.challenge_detected?.signals,
    title: result.challenge_detected?.title,
    cookie_consent: result.cookie_consent,
    search_count: result.search?.dom_count,
    detail_title: result.detail?.title,
    pagination_count: result.pagination?.dom_count,
    timings: result.timings,
    errors: result.errors,
  }, null, 2));
}

main().catch((e) => {
  console.error('top-level error:', e);
  process.exit(1);
});
