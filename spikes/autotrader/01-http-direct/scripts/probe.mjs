// AutoTrader HTTP-direct probe.
// Runs a small set of GET requests with realistic browser headers and saves raw output.
// Usage: node probe.mjs
//
// Designed to be respectful: 4–5s pauses between requests, single run.

import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');

const REALISTIC_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Ch-Ua':
    '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

async function fetchAndSave(label, url, opts = {}) {
  const started = Date.now();
  console.log(`\n[${label}] GET ${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { ...REALISTIC_HEADERS, ...(opts.headers || {}) },
    ...opts,
  });
  const elapsedMs = Date.now() - started;
  const body = await res.text();
  const headerLines = [];
  for (const [k, v] of res.headers.entries()) headerLines.push(`${k}: ${v}`);
  const summary = [
    `URL: ${url}`,
    `Status: ${res.status} ${res.statusText}`,
    `Final URL: ${res.url}`,
    `Bytes: ${body.length}`,
    `Elapsed: ${elapsedMs}ms`,
    '',
    'Response headers:',
    ...headerLines,
  ].join('\n');
  await writeFile(join(SAMPLES, `${label}.headers.txt`), summary);
  await writeFile(join(SAMPLES, `${label}.html`), body);
  console.log(
    `  -> ${res.status} (${body.length} bytes) saved to samples/${label}.html`,
  );
  return { status: res.status, body, headers: res.headers, url: res.url };
}

async function main() {
  // 1. SEO search URL with realistic filters (price, postcode, radius)
  await fetchAndSave(
    'seo-search-audi-a4-filtered',
    'https://www.autotrader.co.uk/cars/used/audi/a4' +
      '?postcode=LE11AB&price-to=15000&radius=50&maximum-mileage=80000&fuel-type=Diesel',
  );
  await sleep(5000);

  // 2. The query-string `/car-search` form with no SEO segment
  await fetchAndSave(
    'qs-car-search-audi-a4',
    'https://www.autotrader.co.uk/car-search' +
      '?postcode=LE11AB&make=AUDI&model=A4&price-to=15000&radius=50' +
      '&maximum-mileage=80000&fuel-type=Diesel',
  );
  await sleep(5000);

  // 3. Bare /car-search with NO headers (cheap baseline — what does the
  //    site do if we pretend to be a script)
  console.log('\n[bare-no-ua] GET /car-search with empty Accept + Node UA');
  const bareRes = await fetch(
    'https://www.autotrader.co.uk/car-search?make=AUDI&model=A4',
    { redirect: 'follow' },
  );
  const bareBody = await bareRes.text();
  await writeFile(
    join(SAMPLES, 'bare-no-ua.html'),
    bareBody,
  );
  await writeFile(
    join(SAMPLES, 'bare-no-ua.headers.txt'),
    `Status: ${bareRes.status}\nBytes: ${bareBody.length}\n` +
      [...bareRes.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'),
  );
  console.log(`  -> ${bareRes.status} (${bareBody.length} bytes)`);
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
