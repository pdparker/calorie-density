import Fuse from "./vendor/fuse.min.mjs";

const $ = (s) => document.querySelector(s);
const PAGE = 40;
const BANDS = [
  { max: 0.6, cls: "b0", label: "Very low" },
  { max: 1.5, cls: "b1", label: "Low" },
  { max: 4, cls: "b2", label: "Medium" },
  { max: Infinity, cls: "b3", label: "High" },
];

// kcal per gram of protein: lower = more protein per calorie
const PROT_BANDS = [
  { max: 10, label: "Very high protein" },
  { max: 20, label: "High protein" },
  { max: 40, label: "Moderate protein" },
  { max: Infinity, label: "Low protein" },
];
const SORTS = {
  "kcal-asc": { label: "Lowest kcal/g", val: (f) => f.kcal, dir: 1 },
  "kcal-desc": { label: "Highest kcal/g", val: (f) => f.kcal, dir: -1 },
  "prot-asc": { label: "Best protein ratio", val: (f) => ratio(f), dir: 1 },
  "prot-desc": { label: "Worst protein ratio", val: (f) => ratio(f), dir: -1 },
};
const MAX_PICK = 20;

const state = { foods: [], src: "all", q: "", results: [], shown: 0, current: null, fuse: {}, sort: "rel", picked: new Map(), cmpSort: { col: "kcal", dir: 1 } };

// Null when protein is negligible (<1 g/100 g), the food is nearly calorie-free
// (<20 kcal/100 g, where label rounding dominates), or the figures are impossible
// (pure protein is ~4 kcal/g, so anything below that is a data error).
function ratio(f) {
  if (!(f.p >= 1) || f.kcal < 0.2) return null;
  const r = (f.kcal * 100) / f.p;
  return r < 4 ? null : r;
}
const fmtR = (r) => (r == null ? "–" : r < 100 ? r.toFixed(1) : Math.round(r).toString());

// ---------- storage (per-device conveniences; failure-tolerant) ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const slim = (f) => ({ id: f.id, name: f.name, brand: f.brand, qty: f.qty, group: f.group, kcal: f.kcal, kj: f.kj, p: f.p, f: f.f, c: f.c, fb: f.fb, src: f.src, warn: f.warn });
const key = (f) => `${f.src}:${f.id}`;

// ---------- text helpers ----------
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9%]+/g, " ").trim();
const stem = (t) => (t.length > 4 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const band = (k) => BANDS.find((b) => k < b.max);
const fmtK = (k) => (k < 10 ? k.toFixed(2) : k.toFixed(1));

function highlight(text, tokens) {
  let out = esc(text);
  for (const t of tokens) {
    if (t.length < 2) continue;
    out = out.replace(new RegExp(`(^|[^a-z0-9])(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "$1<mark>$2</mark>");
  }
  return out;
}

// ---------- data ----------
async function loadData() {
  const prep = (arr) => arr.map((f, i) => ((f._s = " " + norm(`${f.name} ${f.brand || ""}`)), (f._i = i), f));
  const generic = prep(await (await fetch("foods.json")).json());
  state.foods = generic;
  status();
  if (state.q || state.sort !== "rel") run();
  try {
    const branded = prep(await (await fetch("branded.json")).json());
    state.foods = generic.concat(branded);
    state.fuse = {};
    status();
    if (state.q || state.sort !== "rel") run();
  } catch {
    $("#ds-status").textContent = " Packaged-product list unavailable offline; barcode lookup still works online.";
  }
}

function status() {
  const g = state.foods.filter((f) => f.src === "AFCD").length;
  const b = state.foods.length - g;
  $("#ds-status").textContent = ` ${g.toLocaleString()} whole foods${b ? ` · ${b.toLocaleString()} packaged products` : ""}.`;
}

// ---------- search ----------
function pool() {
  return state.src === "all" ? state.foods : state.foods.filter((f) => f.src === state.src);
}

function search(q) {
  const tokens = norm(q).split(" ").filter(Boolean).map(stem);
  if (!tokens.length) return { items: [], tokens };
  const items = [];
  for (const f of pool()) {
    let score = 0, ok = true;
    for (const t of tokens) {
      const at = f._s.indexOf(t);
      if (at < 0) {
        // "weetbix" should match "Weet-Bix": retry ignoring spaces
        if ((f._c ||= f._s.replace(/ /g, "")).includes(t)) { score += 4; continue; }
        ok = false; break;
      }
      if (f._s[at - 1] === " ") score += 10; // starts a word
      if (at === 1) score += 8;               // starts the name
      if (/^(e?s)?( |$)/.test(f._s.slice(at + t.length, at + t.length + 3))) score += 6; // whole word or plural
    }
    if (!ok) continue;
    score -= f._s.length / 12;                // prefer short, generic names
    if (f.src === "AFCD") score += 3;
    if (/\braw\b|\bfresh\b/.test(f._s)) score += 1;
    score -= f._i / 20000;                    // branded sorted by popularity
    items.push({ f, score });
  }
  items.sort((a, b) => b.score - a.score);
  let out = items.map((x) => x.f);

  // Typo fallback
  if (out.length < 8 && q.trim().length >= 3) {
    // Fuzzy matching over 40k products is slow on phones; limit to whole foods + most-scanned products
    const fuzzyPool = pool().filter((f) => f.src === "AFCD" || f._i < 5000);
    const fuse = (state.fuse[state.src] ||= new Fuse(fuzzyPool, { keys: [{ name: "name", weight: 3 }, "brand"], threshold: 0.4, ignoreLocation: true }));
    const seen = new Set(out);
    for (const r of fuse.search(q, { limit: 40 })) if (!seen.has(r.item)) out.push(r.item);
  }
  return { items: out, tokens };
}

function sortItems(items) {
  const s = SORTS[state.sort];
  if (!s) return items;
  // Missing values and flagged (suspect) entries always sink to the bottom
  const k = (f) => { const v = s.val(f); return v == null ? Infinity : (f.warn ? 1e9 : 0) + s.dir * v; };
  return items.map((f) => [k(f), f]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

function run() {
  const q = state.q.trim();
  const browsing = !q && state.sort !== "rel";
  $("#clear").hidden = !q;
  $("#home").hidden = !!q || browsing;
  $("#results-wrap").hidden = !q && !browsing;
  if (!q && !browsing) return renderHome();
  const { items, tokens } = q ? search(q) : { items: pool(), tokens: [] };
  state.results = sortItems(items);
  state.tokens = tokens;
  state.shown = 0;
  $("#results").innerHTML = "";
  const digits = q.replace(/\s/g, "");
  if (/^\d{8,14}$/.test(digits)) {
    const li = document.createElement("li");
    li.innerHTML = `<button class="row"><span class="txt"><span class="nm">Look up barcode ${esc(digits)}</span><span class="sub">Open Food Facts</span></span></button>`;
    li.firstChild.onclick = () => lookupBarcode(digits);
    $("#results").append(li);
  }
  const n = items.length.toLocaleString();
  $("#count").textContent = browsing
    ? `All ${n} ${state.src === "AFCD" ? "whole foods" : state.src === "OFF" ? "packaged products" : "foods"}, ${SORTS[state.sort].label.toLowerCase()} first`
    : items.length ? `${n} match${items.length === 1 ? "" : "es"}` : "No matches. Try fewer or different words.";
  more();
}

function more() {
  const slice = state.results.slice(state.shown, state.shown + PAGE);
  $("#results").append(...slice.map((f) => rowEl(f, state.tokens)));
  state.shown += slice.length;
  $("#more").hidden = state.shown >= state.results.length;
}

function rowEl(f, tokens = []) {
  const b = band(f.kcal);
  const r = ratio(f);
  const prot = state.sort.startsWith("prot");
  const li = document.createElement("li");
  li.className = "item";
  li.dataset.k = key(f);
  const sub = f.src === "OFF" ? [f.brand, f.qty].filter(Boolean).join(" · ") || "Packaged product" : f.group;
  li.innerHTML = `<button class="pick" aria-label="Add ${esc(f.name)} to comparison"></button><button class="row">
    <span class="dot ${b.cls}" title="${b.label} density"></span>
    <span class="txt"><span class="nm">${highlight(f.name, tokens)}</span>
      <span class="sub">${f.src === "OFF" ? '<span class="tag">Packaged</span>' : ""}${f.warn ? '<span class="flag" title="Data looks inconsistent">⚠ </span>' : ""}${esc(sub)}</span></span>
    <span class="val${prot ? "" : " on"}"><b>${fmtK(f.kcal)}</b><small>kcal/g</small></span>
    <span class="val${prot ? " on" : ""}"><b>${fmtR(r)}</b><small>kcal/g prot</small></span></button>`;
  li.firstChild.setAttribute("aria-pressed", state.picked.has(key(f)));
  li.firstChild.onclick = () => togglePick(f);
  li.lastChild.onclick = () => openDetail(f);
  return li;
}

function renderHome() {
  const favs = store.get("favs", []);
  const recent = store.get("recent", []);
  $("#favs-wrap").hidden = !favs.length;
  $("#recent-wrap").hidden = !recent.length;
  $("#favs").replaceChildren(...favs.map((f) => rowEl(f)));
  $("#recent").replaceChildren(...recent.map((f) => rowEl(f)));
}

// ---------- compare ----------
function togglePick(f) {
  const k = key(f);
  if (state.picked.has(k)) state.picked.delete(k);
  else if (state.picked.size >= MAX_PICK) return toast(`Compare up to ${MAX_PICK} items`);
  else state.picked.set(k, slim(f));
  savePicks();
}

function savePicks() {
  store.set("picked", [...state.picked.values()]);
  const n = state.picked.size;
  $("#tray").hidden = !n;
  $("#tray-n").textContent = `${n} selected`;
  $("#tray-go").disabled = n < 2;
  document.body.classList.toggle("has-tray", !!n);
  syncPickButtons();
  if ($("#compare").open) renderCompare();
  if ($("#detail").open && state.current) updatePickBtn();
}

function syncPickButtons() {
  document.querySelectorAll(".item").forEach((li) => li.firstChild.setAttribute("aria-pressed", state.picked.has(li.dataset.k)));
}

const CMP_COLS = {
  kcal: { label: "kcal/g", val: (f) => f.kcal, fmt: fmtK },
  p: { label: "Protein g/100 g", val: (f) => f.p ?? null, fmt: (v) => (v == null ? "–" : v.toFixed(1)) },
  ratio: { label: "kcal per g protein", val: ratio, fmt: fmtR },
};

function renderCompare() {
  const { col, dir } = state.cmpSort;
  const c = CMP_COLS[col];
  const items = [...state.picked.values()].sort((a, b) => {
    const va = c.val(a), vb = c.val(b);
    if (va == null) return 1;
    if (vb == null) return -1;
    return dir * (va - vb);
  });
  const max = Math.max(...items.map((f) => c.val(f) ?? 0), 0) || 1;
  $("#cmp-head").innerHTML = `<th scope="col">Food</th>` + Object.entries(CMP_COLS).map(([k, cc]) =>
    `<th scope="col" aria-sort="${k === col ? (dir > 0 ? "ascending" : "descending") : "none"}"><button data-col="${k}">${cc.label}${k === col ? (dir > 0 ? " ↑" : " ↓") : ""}</button></th>`).join("") + `<th><span class="sr">Remove</span></th>`;
  $("#cmp-body").innerHTML = items.map((f, i) => {
    const b = band(f.kcal);
    return `<tr data-k="${esc(key(f))}">
      <th scope="row"><span class="who"><span class="rank">${i + 1}</span><button class="cmp-name"><span class="dot ${b.cls}"></span>${esc(f.name)}${f.warn ? ' <span class="flag">⚠</span>' : ""}</button></span>${f.brand ? `<small>${esc(f.brand)}</small>` : ""}</th>
      ${Object.entries(CMP_COLS).map(([k, cc]) => {
        const v = cc.val(f);
        return `<td class="${k === col ? "on" : ""}">${cc.fmt(v)}${k === col && v != null ? `<i class="bar" style="width:${Math.max(4, (v / max) * 100)}%"></i>` : ""}</td>`;
      }).join("")}
      <td><button class="icon-btn rm" aria-label="Remove ${esc(f.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td></tr>`;
  }).join("");
  if (items.length < 2) $("#compare").close();
}

function openCompare() {
  // Default the comparison to whatever the list is ranked by
  if (state.sort.startsWith("prot")) state.cmpSort = { col: "ratio", dir: state.sort.endsWith("asc") ? 1 : -1 };
  else if (state.sort.startsWith("kcal")) state.cmpSort = { col: "kcal", dir: state.sort.endsWith("asc") ? 1 : -1 };
  renderCompare();
  $("#compare").showModal();
}

let toastT;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (el.hidden = true), 2200);
}

// ---------- detail ----------
function openDetail(f) {
  state.current = f;
  const b = band(f.kcal);
  $("#d-name").textContent = f.name;
  $("#d-sub").textContent = f.src === "OFF" ? [f.brand, f.qty].filter(Boolean).join(" · ") || "Packaged product" : f.group;
  $("#d-kcal").textContent = fmtK(f.kcal);
  $("#d-kj").textContent = `${fmtK(f.kj)} kJ/g · ${Math.round(f.kcal * 100)} kcal per 100 g`;
  const bandEl = $("#d-band");
  bandEl.className = `band ${b.cls}`;
  bandEl.textContent = `${b.label} density`;
  const r = ratio(f);
  $("#d-prot").innerHTML = r == null
    ? `<b>–</b> kcal per g protein <span class="muted">(${f.p == null ? "protein not listed" : f.p < 1 ? "under 1 g protein per 100 g" : f.kcal < 0.2 ? "too few calories to rate" : "figures look wrong"})</span>`
    : `<b>${fmtR(r)}</b> kcal per g protein · ${PROT_BANDS.find((x) => r <= x.max).label}`;
  $("#d-warn").hidden = !f.warn;
  $("#d-src").textContent = f.src === "OFF" ? `Open Food Facts · ${f.id}` : `AFCD · ${f.id}`;
  renderMacros(f);
  updatePortion();
  updateFav();
  updatePickBtn();
  $("#detail").showModal();

  const recent = store.get("recent", []).filter((x) => key(x) !== key(f));
  recent.unshift(slim(f));
  store.set("recent", recent.slice(0, 8));
}

function renderMacros(f) {
  const el = $("#d-macros");
  if (f.p == null && f.f == null && f.c == null) return (el.innerHTML = "");
  const e = { p: (f.p || 0) * 4, c: (f.c || 0) * 4, f: (f.f || 0) * 9 };
  const tot = e.p + e.c + e.f || 1;
  const pct = (v) => Math.round((v / tot) * 100);
  el.innerHTML = `<div class="mbar" role="img" aria-label="Energy from protein ${pct(e.p)}%, carbohydrate ${pct(e.c)}%, fat ${pct(e.f)}%">
      <i class="mp" style="width:${pct(e.p)}%"></i><i class="mc" style="width:${pct(e.c)}%"></i><i class="mf" style="width:${pct(e.f)}%"></i></div>
    <div class="mleg">
      <span style="--c:#5b8def">Protein ${f.p ?? "–"} g · ${pct(e.p)}%</span>
      <span style="--c:#e0a43a">Carbs ${f.c ?? "–"} g · ${pct(e.c)}%</span>
      <span style="--c:#c65ba8">Fat ${f.f ?? "–"} g · ${pct(e.f)}%</span>
      ${f.fb != null ? `<span style="--c:transparent">Fibre ${f.fb} g</span>` : ""}
    </div><div class="mleg">per 100 g · % of energy</div>`;
}

function updatePortion() {
  const f = state.current;
  if (!f) return;
  const g = parseFloat($("#d-g").value) || 0;
  $("#d-total").textContent = `${Math.round(f.kcal * g).toLocaleString()} kcal`;
  $("#d-total").title = `${Math.round(f.kj * g).toLocaleString()} kJ`;
  store.set("portion", g);
}

function updateFav() {
  const favs = store.get("favs", []);
  const on = favs.some((x) => key(x) === key(state.current));
  $("#d-fav").textContent = on ? "★ Saved" : "☆ Save";
  $("#d-fav").classList.toggle("ghost", false);
}

function toggleFav() {
  const f = state.current;
  let favs = store.get("favs", []);
  favs = favs.some((x) => key(x) === key(f)) ? favs.filter((x) => key(x) !== key(f)) : [slim(f), ...favs];
  store.set("favs", favs);
  updateFav();
}

// ---------- barcode ----------
const macroWarn = (kcal100, p, f, c, fb) => {
  if ([p, f, c].some((v) => v == null)) return 0;
  const est = 4 * p + 4 * c + 9 * f + 2 * (fb || 0);
  return est > 40 && Math.abs(kcal100 - est) / est > 0.35 ? 1 : 0;
};

async function lookupBarcode(raw) {
  const code = raw.replace(/\D/g, "");
  const variants = [code, code.replace(/^0+/, ""), "0" + code];
  const local = state.foods.find((f) => f.src === "OFF" && variants.includes(f.id));
  if (local) return closeScanner(), openDetail(local);

  setScanMsg("Looking up " + code + "…");
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=code,product_name,product_name_en,brands,quantity,nutriments`);
    const d = await r.json();
    const p = d.product;
    const n = p?.nutriments || {};
    let kcal = n["energy-kcal_100g"];
    const kj = n["energy-kj_100g"] ?? n["energy_100g"];
    if (kcal == null && kj != null) kcal = kj / 4.184;
    if (d.status !== 1 || kcal == null) {
      setScanMsg(d.status === 1 ? "Found, but it has no energy data." : "Not in Open Food Facts yet.");
      return;
    }
    const num = (v) => (v == null || v === "" ? undefined : Math.round(+v * 10) / 10);
    const item = {
      id: p.code || code, name: p.product_name_en || p.product_name || "Unnamed product",
      brand: (p.brands || "").split(",")[0].trim(), qty: p.quantity || "",
      kcal: Math.round(kcal) / 100, kj: Math.round(kcal * 4.184) / 100,
      p: num(n.proteins_100g), f: num(n.fat_100g), c: num(n.carbohydrates_100g), fb: num(n.fiber_100g), src: "OFF",
    };
    item.warn = macroWarn(kcal, item.p, item.f, item.c, item.fb);
    closeScanner();
    openDetail(item);
  } catch {
    setScanMsg("Couldn't reach Open Food Facts. Are you online?");
  }
}

let stream, scanning = false;
const setScanMsg = (m) => ($("#scan-msg").textContent = m);

async function openScanner() {
  $("#scanner").showModal();
  $("#scan-manual").value = "";
  setScanMsg("Starting camera…");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    const v = $("#video");
    v.srcObject = stream;
    await v.play();
    let Detector = window.BarcodeDetector;
    if (!Detector) {
      setScanMsg("Loading scanner…");
      ({ BarcodeDetector: Detector } = await import("https://cdn.jsdelivr.net/npm/barcode-detector@3/+esm"));
    }
    const det = new Detector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
    setScanMsg("Point the camera at a barcode");
    scanning = true;
    const tick = async () => {
      if (!scanning) return;
      try {
        const [hit] = await det.detect(v);
        if (hit?.rawValue) { scanning = false; navigator.vibrate?.(40); return lookupBarcode(hit.rawValue); }
      } catch {}
      setTimeout(tick, 200);
    };
    tick();
  } catch (e) {
    setScanMsg(e?.name === "NotAllowedError" ? "Camera access was blocked. Type the barcode instead." : "No camera available. Type the barcode instead.");
  }
}

function closeScanner() {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if ($("#scanner").open) $("#scanner").close();
}

function updatePickBtn() {
  const on = state.picked.has(key(state.current));
  $("#d-pick").textContent = on ? "✓ Comparing" : "+ Compare";
  $("#d-pick").setAttribute("aria-pressed", on);
}

// ---------- wiring ----------
let t;
$("#q").addEventListener("input", (e) => {
  state.q = e.target.value;
  clearTimeout(t);
  t = setTimeout(run, 90);
});
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
$("#clear").onclick = () => { $("#q").value = state.q = ""; run(); $("#q").focus(); };
$("#more").onclick = more;
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-selected", x === b));
    state.src = b.dataset.src;
    store.set("src", state.src);
    run();
  })
);
$("#d-g").value = store.get("portion", 100);
$("#d-g").addEventListener("input", updatePortion);
$("#d-chips").addEventListener("click", (e) => { const g = e.target.dataset?.g; if (g) { $("#d-g").value = g; updatePortion(); } });
$("#d-close").onclick = () => $("#detail").close();
$("#d-fav").onclick = toggleFav;
$("#detail").addEventListener("close", () => { if (!$("#home").hidden) renderHome(); });
$("#d-pick").onclick = () => togglePick(state.current);
$("#sort").value = state.sort = SORTS[store.get("sort")] ? store.get("sort") : "rel";
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; store.set("sort", state.sort); run(); });
$("#tray-go").onclick = openCompare;
$("#tray-clear").onclick = () => { state.picked.clear(); savePicks(); };
$("#cmp-close").onclick = () => $("#compare").close();
$("#cmp-head").addEventListener("click", (e) => {
  const col = e.target.closest("button")?.dataset.col;
  if (!col) return;
  state.cmpSort = { col, dir: state.cmpSort.col === col ? -state.cmpSort.dir : 1 };
  renderCompare();
});
$("#cmp-body").addEventListener("click", (e) => {
  const k = e.target.closest("tr")?.dataset.k;
  const f = k && state.picked.get(k);
  if (!f) return;
  if (e.target.closest(".rm")) { state.picked.delete(k); savePicks(); }
  else if (e.target.closest(".cmp-name")) openDetail(f);
});
for (const f of store.get("picked", [])) state.picked.set(key(f), f);
savePicks();
for (const d of ["#detail", "#scanner", "#compare"]) $(d).addEventListener("click", (e) => { if (e.target === e.currentTarget) d === "#scanner" ? closeScanner() : $(d).close(); });
$("#scanner").addEventListener("cancel", closeScanner);
$("#scan").onclick = openScanner;
$("#scan-close").onclick = closeScanner;
$("#scan-go").onclick = () => { const v = $("#scan-manual").value.trim(); if (v) lookupBarcode(v); };
$("#scan-manual").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#scan-go").click(); });

const savedSrc = store.get("src", "all");
document.querySelector(`.seg button[data-src="${savedSrc}"]`)?.click();

renderHome();
loadData();

if ("serviceWorker" in navigator && location.protocol === "https:") { // skip on localhost so edits show immediately
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
