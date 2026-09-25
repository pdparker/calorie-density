# kcal/g — Calorie Density

Installable web app (PWA) that shows **calories per gram** for Australian whole foods and packaged products.

- **Whole foods:** AFCD Release 3 (FSANZ), 1,588 foods. Energy uses "Energy with dietary fibre, equated", the basis of Australian labels.
- **Packaged products:** Open Food Facts, products sold in Australia, bundled for offline search. Community-entered, and the app flags entries whose energy disagrees with their macros.
- **Barcode scan:** native `BarcodeDetector` where available, polyfill (loaded from jsDelivr) elsewhere, e.g. iOS Safari. Unknown barcodes are looked up live on Open Food Facts.

## Features

- Search (typo- and plural-tolerant), whole foods / packaged filter
- **Rank by** kcal/g or protein ratio (kcal per g protein, lower = more protein per calorie). With nothing typed, ranks the whole database.
- **Compare:** tap ○ on any row to select (up to 20); the tray opens a side-by-side table sortable by any column. Selection persists per device.
- **Filters:** minimum protein (5/10/20 g per 100 g) and "hide ⚠ suspect" apply to search and rankings
- **Variants grouped:** preparations of one whole food (raw, grilled, baked…) and repeat listings of one product collapse into a single row with an expandable range
- **Swaps:** each food's page suggests up to 5 similar foods that are 10%+ lower in kcal/g or better on protein ratio. Whole foods match on name and food group; packaged products on Open Food Facts category (~37% of products have one)
- Protein ratio is shown as "–" when protein < 1 g/100 g, energy < 20 kcal/100 g, or the ratio is below 4 (physically impossible, so a data error)

## Layout

```
app/                 static site: deploy this folder as-is
  index.html  app.js  styles.css  sw.js  manifest.webmanifest
  foods.json         generated: AFCD
  branded.json       generated: Open Food Facts (AU)
  vendor/fuse.min.mjs
data/
  build_foods.py     AFCD xlsx -> app/foods.json
  build_branded.py   OFF search API crawl -> app/branded.json (cache: raw/off_au.jsonl)
  raw/               downloaded source files (not deployed)
```

## Run locally

```bash
python3 -m http.server 4318 --directory app
```

The camera needs HTTPS (or localhost), so test scanning on a phone from the deployed site.

## Refresh data

```bash
python3 data/build_foods.py
rm data/raw/off_au.jsonl && python3 data/build_branded.py   # ~25 min crawl
```

After a data refresh, bump `VERSION` in `app/sw.js` so installed copies update.

## Density bands

| Band | kcal/g |
|---|---|
| Very low | < 0.6 |
| Low | 0.6–1.5 |
| Medium | 1.5–4 |
| High | > 4 |

## Licences

AFCD © FSANZ (CC BY 4.0). Open Food Facts data under ODbL; attribution shown in-app.
