# kcal/g — Calorie Density

Installable web app (PWA) that shows **calories per gram** for Australian whole foods and packaged products.

- **Whole foods:** AFCD Release 3 (FSANZ), 1,588 foods. Energy uses "Energy with dietary fibre, equated", the basis of Australian labels.
- **Packaged products:** Open Food Facts, products sold in Australia, bundled for offline search. Community-entered, and the app flags entries whose energy disagrees with their macros.
- **Barcode scan:** native `BarcodeDetector` where available, polyfill (loaded from jsDelivr) elsewhere, e.g. iOS Safari. Unknown barcodes are looked up live on Open Food Facts.

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
