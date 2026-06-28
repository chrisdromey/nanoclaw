// Probe a detail page to find where priceIndicatorRating appears in SSR HTML.
// Using advertId 202605282783235 from spike #1.
//
// Usage: node probe-detail-page.mjs

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, 'samples');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

const ADVERT_ID = '202605282783235';
const url = `https://www.autotrader.co.uk/car-details/${ADVERT_ID}`;

console.log(`Fetching detail page: ${url}`);
const res = await fetch(url, { headers: HEADERS });
const html = await res.text();
const cfMitigated = res.headers.get('cf-mitigated');

console.log(`Status: ${res.status}, bytes: ${html.length}, cf-mitigated: ${cfMitigated || 'none'}`);

await writeFile(join(SAMPLES, '06-detail-page.html'), html);

// Search for price tier indicators
const patterns = [
  /price.?indicator/gi,
  /Great price/gi,
  /Good price/gi,
  /Lower price/gi,
  /Higher price/gi,
  /priceRating/gi,
  /GREAT/g,
  /priceIndicator/gi,
  /dealRating/gi,
  /"rating"\s*:/gi,
  /data-price/gi,
  /price-badge/gi,
  /price-indicator/gi,
  /price-tier/gi,
  /priceTier/gi,
  /indicatorRating/gi,
];

console.log('\n── Pattern search results ──');
for (const pat of patterns) {
  const matches = [...html.matchAll(pat)];
  if (matches.length > 0) {
    console.log(`\n${pat}: ${matches.length} matches`);
    // Print context around first match
    const idx = html.indexOf(matches[0][0]);
    const ctx = html.slice(Math.max(0, idx - 100), idx + 200);
    console.log(`  Context: ...${ctx.replace(/\n/g, '\\n')}...`);
  }
}

// Look for AT_APOLLO_STATE on detail page
const apolloMatch = html.match(/AT_APOLLO_STATE\s*=\s*(\{.*?\});/s);
if (apolloMatch) {
  const stateStr = apolloMatch[1];
  console.log(`\nAT_APOLLO_STATE found (${stateStr.length} chars)`);
  if (stateStr.length < 100000) {
    try {
      const state = JSON.parse(stateStr);
      const keys = Object.keys(state);
      console.log(`Keys: ${keys.slice(0, 20).join(', ')}`);
      // Check for price indicator in state
      const stateStr2 = JSON.stringify(state);
      if (stateStr2.includes('priceIndicator')) {
        console.log('*** priceIndicator FOUND in AT_APOLLO_STATE!');
        const idx = stateStr2.indexOf('priceIndicator');
        console.log(stateStr2.slice(Math.max(0, idx - 50), idx + 200));
      } else {
        console.log('priceIndicator NOT in AT_APOLLO_STATE');
      }
    } catch (e) {
      console.log('Could not parse AT_APOLLO_STATE:', e.message);
    }
  }
} else {
  console.log('\nAT_APOLLO_STATE: empty or absent');
}

// Look for LD+JSON schema data
const ldJsonMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)];
console.log(`\nLD+JSON blocks: ${ldJsonMatches.length}`);
for (const [, content] of ldJsonMatches.slice(0, 3)) {
  if (content.includes('price') || content.includes('Price')) {
    console.log('  LD+JSON with price:', content.slice(0, 500));
  }
}

// Search for the exact text "Great price" / "Good price" in raw HTML
const tierTexts = ['Great price', 'Good price', 'Lower price', 'Higher price', 'No data'];
for (const t of tierTexts) {
  const idx = html.indexOf(t);
  if (idx !== -1) {
    console.log(`\n"${t}" found at index ${idx}:`);
    console.log('  ' + html.slice(Math.max(0, idx - 150), idx + 200).replace(/\n/g, ' '));
  }
}

console.log('\nDone. Detail page saved to samples/06-detail-page.html');
