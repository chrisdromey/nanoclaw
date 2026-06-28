# AutoTrader.co.uk Access Spikes

Goal: determine the most robust way to pull listing data from autotrader.co.uk for the Deal Hunter system.

**Constraints:**
- Running from a UK residential IP (low bot-detection risk)
- Low polling volume (handful of requests per hunt, not continuous)
- Eventual use: (a) periodic search by criteria (make/model/price/mileage), (b) watch specific listings for price drops / sold

**Spikes:**
- `01-http-direct/` — plain HTTP fetch + parse `__NEXT_DATA__` / JSON-LD / sniff for XHR JSON endpoints
- `02-puppeteer-stealth/` — full headless browser with `puppeteer-extra-plugin-stealth`

Each spike's `FINDINGS.md` is the canonical writeup. Code and sample outputs live alongside.
