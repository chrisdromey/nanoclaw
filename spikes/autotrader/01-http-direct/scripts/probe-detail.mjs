// Fetch a fresh detail page and assess what fields are SSR'd.
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
};

// Pick a real advert id from the prior GraphQL response.
// 202605282783235 -> the £10,989 2015 Audi A4 in Leicester (3 miles).
const id = process.argv[2] || '202605282783235';
const url = `https://www.autotrader.co.uk/car-details/${id}`;

console.log(`Fetching ${url}`);
const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
const body = await res.text();
console.log(`Status: ${res.status}  Bytes: ${body.length}`);
await writeFile(join(SAMPLES, `detail-${id}.html`), body);
await writeFile(
  join(SAMPLES, `detail-${id}.headers.txt`),
  `Status: ${res.status}\nFinal URL: ${res.url}\n\n` +
    [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'),
);

// Quick field summary
const title = body.match(/<title[^>]*>([^<]+)<\/title>/)?.[1] || '';
const ogTitle =
  body.match(/<meta[^>]*name="og:title"[^>]*content="([^"]+)"/)?.[1] || '';
const description =
  body.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/)?.[1] || '';
const ogImage =
  body.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/)?.[1] || '';
const priceMatches = [...body.matchAll(/£[\d,]{3,}/g)].map((m) => m[0]);
const mileageMatches = [...body.matchAll(/([\d,]+)\s+miles/g)].map((m) => m[0]);
const yearMatches = [...body.matchAll(/\b(20\d{2}|19\d{2})\s*\(\d{2}\s*reg\)/g)]
  .map((m) => m[0]);
const fuel = body.match(/>(Petrol|Diesel|Hybrid|Electric)</)?.[1] || '';
const trans = body.match(/>(Manual|Automatic)</)?.[1] || '';
const bodyType =
  body.match(/>(Saloon|Hatchback|Estate|SUV|Coupe|Convertible|MPV)</)?.[1] ||
  '';
const apolloMatch = body.match(/window\['AT_APOLLO_STATE'\] = (.{0,40})/);
const apolloPreview = apolloMatch ? apolloMatch[1] : '(none)';

console.log('\nField summary:');
console.log({
  title,
  ogTitle,
  ogImage,
  description: description.slice(0, 120),
  prices: priceMatches.slice(0, 5),
  mileages: mileageMatches.slice(0, 5),
  years: yearMatches.slice(0, 3),
  fuel,
  trans,
  bodyType,
  apolloPreview,
});
