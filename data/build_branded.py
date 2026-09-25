"""Build app/branded.json: Australian packaged products from Open Food Facts.

Crawls the OFF search API (search.openfoodfacts.org) for products sold in
Australia, partitioning by barcode prefix so each query stays under the API's
10,000-result window. The raw crawl is cached in raw/off_au.jsonl; delete it
to refresh. Open Food Facts data is ODbL-licensed.

Quality checks: each product's energy is compared with its macronutrients
(4 kcal/g protein and carbs, 9 fat, 2 fibre). Rows that disagree badly get a
`warn` flag; rows with impossible values are dropped.
"""
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
CACHE = HERE / "raw" / "off_au.jsonl"
OUT = HERE.parent / "app" / "branded.json"
API = "https://search.openfoodfacts.org/search"
BASE_Q = 'countries_tags:"en:australia"'
FIELDS = "code,product_name,product_name_en,brands,quantity,nutriments,unique_scans_n,categories_tags"
PAGE = 200
UA = "CalorieDensityPWA/0.1 (personal project)"
# Categories too broad to find like-for-like swaps
GENERIC = {"groceries", "foods", "snacks", "sweet snacks", "salty snacks", "beverages", "plant based foods",
           "plant based foods and beverages", "beverages and beverages preparations", "dairies", "meals",
           "condiments", "baking", "cereals and potatoes", "fruits and vegetables based foods", "unsweetened beverages",
           "fermented foods", "fermented milk products", "desserts", "frozen foods", "canned foods", "dried products"}


def get(q, page=1, size=PAGE, fields=FIELDS):
    qs = urllib.parse.urlencode({"q": q, "page": page, "page_size": size, "fields": fields})
    for attempt in range(5):
        try:
            req = urllib.request.Request(f"{API}?{qs}", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            wait = 2 ** attempt
            print(f"  retry {attempt + 1} in {wait}s ({e})")
            time.sleep(wait)
    raise RuntimeError(f"failed: {q} p{page}")


def partitions(prefix=""):
    """Yield barcode prefixes whose result count fits in one 10k window."""
    for d in "0123456789":
        p = prefix + d
        d0 = get(f"{BASE_Q} AND code:{p}*", size=1, fields="code")
        if d0["count"] == 0:
            continue
        if d0.get("is_count_exact") and d0["count"] <= 10000:
            yield p, d0["count"]
        else:
            yield from partitions(p)


def crawl():
    seen = set()
    with CACHE.open("w") as fh:
        for prefix, n in partitions():
            pages = -(-n // PAGE)
            print(f"prefix {prefix}: {n} products, {pages} pages")
            for page in range(1, pages + 1):
                for hit in get(f"{BASE_Q} AND code:{prefix}*", page)["hits"]:
                    if hit.get("code") not in seen:
                        seen.add(hit.get("code"))
                        fh.write(json.dumps(hit, ensure_ascii=False) + "\n")
                time.sleep(0.2)
    print(f"crawled {len(seen)} products")


def num(n, k):
    v = n.get(k)
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def main():
    if not CACHE.exists():
        crawl()

    out, dropped, warned = [], 0, 0
    for line in CACHE.open():
        r = json.loads(line)
        name = (r.get("product_name_en") or r.get("product_name") or "").strip()
        if isinstance(r.get("product_name"), dict):
            name = ""
        n = r.get("nutriments") or {}
        kcal = num(n, "energy-kcal_100g")
        kj = num(n, "energy-kj_100g") or num(n, "energy_100g")
        if kcal is None and kj is not None:
            kcal = kj / 4.184
        p, f, c, fb = (num(n, k) for k in ("proteins_100g", "fat_100g", "carbohydrates_100g", "fiber_100g"))
        if (
            not name or not r.get("code") or kcal is None
            or not 0 <= kcal <= 902  # nothing exceeds pure fat
            or any(v is not None and not 0 <= v <= 100 for v in (p, f, c, fb))
        ):
            dropped += 1
            continue

        warn = 0
        if None not in (p, f, c):
            est = 4 * p + 4 * c + 9 * f + 2 * (fb or 0)
            if est > 40 and abs(kcal - est) / est > 0.35:
                warn = 1
        warned += warn

        # Most specific English categories, e.g. ["biscuits", "chocolate biscuits"]
        cats = [c[3:].replace("-", " ") for c in (r.get("categories_tags") or []) if c.startswith("en:")]
        cats = [c for c in cats if c not in GENERIC][-2:]

        brands = r.get("brands") or ""
        brand = (brands[0] if isinstance(brands, list) and brands else str(brands).split(",")[0]).strip()
        item = {
            "id": r["code"], "name": name[:120], "brand": brand, "qty": str(r.get("quantity") or "").strip()[:20],
            "kcal": round(kcal / 100, 2), "kj": round(kcal * 4.184 / 100, 2),
            "p": None if p is None else round(p, 1), "f": None if f is None else round(f, 1),
            "c": None if c is None else round(c, 1), "fb": None if fb is None else round(fb, 1),
            "cat": cats[-1] if cats else None, "cat2": cats[0] if len(cats) == 2 else None,
            "src": "OFF", "warn": warn, "_pop": r.get("unique_scans_n") or 0,
        }
        out.append({k: v for k, v in item.items() if v not in (None, "", 0) or k in ("kcal", "kj", "_pop")})

    # Collapse community duplicates (same product entered under several barcodes),
    # keeping the most-scanned entry.
    out.sort(key=lambda x: -x["_pop"])
    squash = lambda s: re.sub(r"[^a-z0-9]", "", s.lower()).removesuffix("s")
    seen, deduped = set(), []
    for x in out:
        k = (squash(x["name"]), squash(x.get("brand", "")), round(x["kcal"], 1))
        if k not in seen:
            seen.add(k)
            deduped.append(x)
    dupes = len(out) - len(deduped)
    out = deduped

    # Borrow a category from other listings with the same name ("Tim Tam" entered twice,
    # only one categorised) so more products get like-for-like swaps.
    by_name = {}
    for x in out:
        if x.get("cat"):
            by_name.setdefault(squash(x["name"]), (x["cat"], x.get("cat2")))
    borrowed = 0
    for x in out:
        if not x.get("cat") and squash(x["name"]) in by_name:
            x["cat"], cat2 = by_name[squash(x["name"])]
            if cat2:
                x["cat2"] = cat2
            borrowed += 1
    print(f"categories: {sum(1 for x in out if x.get('cat'))} products ({borrowed} borrowed by name)")
    for x in out:
        x.pop("_pop")
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(out)} products ({warned} flagged, {dropped} dropped, {dupes} duplicates) -> {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
