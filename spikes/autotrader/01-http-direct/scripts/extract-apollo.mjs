// Extract the AT_APOLLO_STATE JSON blob from a saved AutoTrader HTML page.
// Writes <input>.apollo.json next to the HTML file and prints a summary.
//
// Usage: node extract-apollo.mjs <path-to.html>

import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node extract-apollo.mjs <html-file>');
  process.exit(1);
}

const html = await readFile(file, 'utf8');

// The bundle assigns: window['AT_APOLLO_STATE'] = {...};
// The object can be huge; we find the start brace and balance-match.
const marker = "window['AT_APOLLO_STATE'] = ";
const start = html.indexOf(marker);
if (start === -1) {
  console.error('No AT_APOLLO_STATE found in', file);
  process.exit(2);
}
const jsonStart = start + marker.length;
let depth = 0;
let inString = false;
let escape = false;
let end = -1;
for (let i = jsonStart; i < html.length; i++) {
  const ch = html[i];
  if (escape) {
    escape = false;
    continue;
  }
  if (ch === '\\') {
    escape = true;
    continue;
  }
  if (ch === '"') {
    inString = !inString;
    continue;
  }
  if (inString) continue;
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
if (end === -1) {
  console.error('Could not balance braces');
  process.exit(3);
}
const raw = html.slice(jsonStart, end);
let obj;
try {
  obj = JSON.parse(raw);
} catch (e) {
  console.error('JSON parse failed:', e.message);
  console.error('Snippet:', raw.slice(0, 200));
  process.exit(4);
}

const out = file.replace(/\.html$/, '.apollo.json');
await writeFile(out, JSON.stringify(obj, null, 2));
console.log('Wrote', out, '— top-level keys:', Object.keys(obj).length);

// Summarise listing-like entries
const listingKeys = Object.keys(obj).filter(
  (k) => k.startsWith('SearchListing:') || k.startsWith('Advert:') ||
    k.startsWith('SearchAdvert:'),
);
console.log('Listing-shaped keys:', listingKeys.length);
if (listingKeys.length > 0) {
  const sample = obj[listingKeys[0]];
  console.log('Sample listing keys:', Object.keys(sample));
  console.log('Sample listing:', JSON.stringify(sample, null, 2).slice(0, 1200));
}

// Look at ROOT_QUERY for searchResults
const root = obj.ROOT_QUERY || {};
const searchResultsKeys = Object.keys(root).filter((k) =>
  k.startsWith('searchResults') || k.includes('seoPageData'),
);
console.log('\nROOT_QUERY search-shaped keys:', searchResultsKeys.length);
for (const k of searchResultsKeys.slice(0, 4)) {
  console.log('-', k.slice(0, 200));
}
