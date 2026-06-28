// Pull listing cards out of a SSR'd /cars/used/... HTML page.
// Demonstrates that price, title, registration, mileage, image and detail-link
// are all extractable from the raw HTML without a browser.
//
// Usage: node extract-listings.mjs <path-to.html>

import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node extract-listings.mjs <html-file>');
  process.exit(1);
}
const html = await readFile(file, 'utf8');

// Card boundary: each card is an <article class="atds-advert-card ..." id="<advertId>" ...>...
// We split on the article tag.
const cardRe = /<article\s+class="atds-advert-card[\s\S]*?<\/article>/g;
const cards = html.match(cardRe) || [];

function pick(re, src, group = 1) {
  const m = src.match(re);
  return m ? m[group].trim() : '';
}

const rows = [];
for (const card of cards) {
  const advertId = pick(/\sid="(\d+)"/, card);
  const detailHref = pick(/href="(\/car-details\/\d+)"/, card);
  const makeModel = pick(
    /class="[^"]*atds-advert-card__heading[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    card,
  ).replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim();
  const title = pick(
    /class="[^"]*atds-advert-card__title[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    card,
  ).replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim();
  const registration = pick(
    /class="[^"]*atds-advert-card__registration[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    card,
  ).replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim();
  const year = pick(/\b(20\d{2}|19\d{2})\b/, registration);
  const mileage = pick(/([\d,]+)\s*miles/i, registration);
  const price = pick(/atds-advert-card__display-price[^>]*>([^<]+)</, card);
  const attentionGrabber = pick(
    /class="[^"]*atds-advert-card__attention-grabber[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    card,
  ).replace(/\s+/g, ' ').trim();
  const image = pick(/<img[^>]+src="([^"]+)"/, card);
  const description = pick(/\sdescription="([^"]*)"/, card).slice(0, 120);
  const reserveOnline = card.includes('data-testid="reserve-online"');

  rows.push({
    advertId,
    detailHref,
    makeModel,
    title,
    year,
    mileage,
    price,
    attentionGrabber,
    image,
    reserveOnline,
    descriptionPreview: description,
  });
}

console.log(`Found ${cards.length} <article> card blocks in ${file}\n`);
for (const r of rows) console.log(JSON.stringify(r));

const out = file.replace(/\.html$/, '.listings.json');
await writeFile(out, JSON.stringify(rows, null, 2));
console.log(`\nWrote ${out}`);
