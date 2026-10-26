import { fetchBazaar } from "./bazaar.js";
import { loadFusions, rankFusions, RARITIES } from "./fusions.js";

const REFRESH_MS = 60_000;
const PAGE_SIZE = 100;
const SETTINGS_KEY = "sff-settings";
const THEME_KEY = "sff-theme";

const iconUrl = (id) => `https://raw.githubusercontent.com/Campionnn/SkyShards/master/public/shardIcons/${id}.png`;
const wikiUrl = (name) => `https://hypixelskyblock.minecraft.wiki/w/${encodeURIComponent(name.replaceAll(" ", "_"))}_Shard`;
const historyUrl = (productId) => `https://sky.coflnet.com/item/${productId}`;

const DEFAULTS = {
  buyMode: "instaBuy",
  sellMode: "instaSell",
  tax: 1.25,
  minVolume: 0,
  maxCost: null,
  rarities: [...RARITIES],
  sort: "profit",
  unique: true,
};

const settings = loadSettings();

const state = {
  fusions: null,
  bazaar: null,
  // Every priced pair, recomputed only when prices, modes or tax change.
  ranked: [],
  // Profit direction per row key from the last price refresh, consumed by the next render.
  changes: new Map(),
  search: "",
  limit: PAGE_SIZE,
  expanded: new Set(),
  lastFetch: 0,
  loading: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  status: $("status-text"),
  refresh: $("refresh-btn"),
  theme: $("theme-btn"),
  tax: $("tax-input"),
  search: $("search-input"),
  volume: $("volume-input"),
  budget: $("budget-input"),
  rarityChips: $("rarity-chips"),
  sort: $("sort-select"),
  unique: $("unique-toggle"),
  error: $("error-banner"),
  errorText: $("error-text"),
  overview: $("overview"),
  rows: $("rows"),
  count: $("count-text"),
  more: $("more-btn"),
  dataSource: $("data-source"),
};

/* ---------- Formatting ---------- */

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const coins = (n) => intFmt.format(Math.round(n));
const signed = (n) => (n > 0 ? "+" : n < 0 ? "-" : "") + coins(Math.abs(n));
const pct = (r) => `${(r * 100).toFixed(1)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ---------- Settings ---------- */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); settings just won't persist.
  }
}

/* ---------- Data ---------- */

async function init() {
  bindControls();
  syncControls();
  renderSkeleton();

  try {
    const [fusions] = await Promise.all([loadFusions(), refreshPrices({ render: false })]);
    state.fusions = fusions;
    el.dataSource.textContent = fusions.source === "live" ? "latest data" : "offline snapshot";
    recompute();
    document.body.classList.add("intro");
    render();
    setTimeout(() => document.body.classList.remove("intro"), 1200);
  } catch (err) {
    showError(`Could not load fusion recipes: ${err.message}`);
  }

  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", tick);
}

async function refreshPrices({ render: shouldRender = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  el.refresh.classList.add("spinning");
  try {
    state.bazaar = await fetchBazaar();
    hideError();
    if (state.fusions) {
      const before = new Map(state.ranked.map((row) => [row.key, row.profit]));
      recompute();
      state.changes = new Map();
      for (const row of state.ranked) {
        const prev = before.get(row.key);
        if (prev !== undefined && Math.round(prev) !== Math.round(row.profit)) {
          state.changes.set(row.key, row.profit > prev ? "up" : "down");
        }
      }
      if (shouldRender) render();
    }
  } catch (err) {
    const stale = state.bazaar ? " Showing the last prices that loaded." : "";
    showError(`Bazaar prices failed to load (${err.message}).${stale} Retrying automatically.`);
    if (!state.bazaar) renderEmpty("Waiting for Bazaar prices", "The table fills in as soon as the Bazaar API responds.");
  } finally {
    // Count failures as attempts too, so a down API is retried once per interval, not every second.
    state.lastFetch = Date.now();
    state.loading = false;
    el.refresh.classList.remove("spinning");
    updateStatus();
  }
}

function recompute() {
  if (!state.fusions || !state.bazaar) return;
  state.ranked = rankFusions(state.fusions, state.bazaar.products, {
    buyMode: settings.buyMode,
    sellMode: settings.sellMode,
    tax: settings.tax / 100,
  });
}

function tick() {
  if (document.visibilityState === "visible" && Date.now() - state.lastFetch >= REFRESH_MS) {
    refreshPrices();
  }
  updateStatus();
}

function updateStatus() {
  if (!state.bazaar) {
    el.status.textContent = state.loading ? "Loading prices" : "Prices unavailable";
    return;
  }
  const age = Math.max(0, Math.round((Date.now() - state.bazaar.lastUpdated) / 1000));
  const next = Math.max(0, Math.ceil((REFRESH_MS - (Date.now() - state.lastFetch)) / 1000));
  el.status.textContent = state.loading ? "Refreshing" : `Prices ${age}s old, refresh in ${next}s`;
}

/* ---------- Filtering ---------- */

function visibleRows() {
  const { shards } = state.fusions;
  const query = state.search.trim().toLowerCase();
  const rarities = new Set(settings.rarities);

  const rows = state.ranked.filter((row) => {
    if (row.profit <= 0) return false;
    if (row.volume < (settings.minVolume || 0)) return false;
    if (settings.maxCost && row.cost > settings.maxCost) return false;
    if (!rarities.has(shards[row.output].rarity)) return false;
    if (query) {
      const names = `${shards[row.a].name} ${shards[row.b].name} ${shards[row.output].name}`.toLowerCase();
      if (!names.includes(query)) return false;
    }
    return true;
  });

  const key = settings.sort;
  rows.sort((x, y) => y[key] - x[key] || y.profit - x.profit);

  if (!settings.unique) return rows;
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.output) && seen.add(row.output));
}

/* ---------- Rendering ---------- */

function render() {
  if (!state.fusions || !state.bazaar) return;
  const rows = visibleRows();
  renderOverview(rows);
  renderRows(rows);
  state.changes = new Map();
}

function shardHtml(id, qty) {
  const shard = state.fusions.shards[id];
  const r = shard.rarity;
  return `<span class="shard" data-rarity="${r}">
    <img src="${iconUrl(id)}" alt="" width="24" height="24" loading="lazy" onerror="this.style.visibility='hidden'">
    <span class="rarity-letter" title="${r[0].toUpperCase() + r.slice(1)}">${r[0].toUpperCase()}</span>
    <span>${esc(shard.name)}</span>${qty ? `<span class="qty">×${qty}</span>` : ""}
  </span>`;
}

function renderOverview(rows) {
  if (rows.length === 0) {
    el.overview.innerHTML = "";
    return;
  }
  const { shards } = state.fusions;
  const best = rows.reduce((a, b) => (b.profit > a.profit ? b : a));
  const bestRoi = rows.reduce((a, b) => (b.roi > a.roi ? b : a));
  const totalPriced = state.ranked.length;
  const profitable = state.ranked.filter((r) => r.profit > 0).length;

  el.overview.innerHTML = `
    <article class="pick">
      <h2 class="pick-title">Most profitable fusion right now</h2>
      <div class="pick-flow">
        ${shardHtml(best.a, best.amountA)}
        <i class="ph ph-plus op" aria-label="plus"></i>
        ${shardHtml(best.b, best.amountB)}
        <i class="ph ph-arrow-right op" aria-label="makes"></i>
        ${shardHtml(best.output, best.outputQty)}
      </div>
      <div class="pick-numbers">
        <div class="metric big"><span>Profit per fusion</span><strong>${signed(best.profit)}</strong></div>
        <div class="metric"><span>Cost</span><strong>${compactFmt.format(best.cost)}</strong></div>
        <div class="metric"><span>Return on cost</span><strong>${pct(best.roi)}</strong></div>
        <div class="metric"><span>Weekly volume</span><strong>${compactFmt.format(best.volume)}</strong></div>
      </div>
    </article>
    <aside class="stats">
      <div class="metric"><span>Profitable fusions</span><strong>${intFmt.format(profitable)}</strong><small>of ${intFmt.format(totalPriced)} priced pairs</small></div>
      <div class="metric"><span>Best return on cost</span><strong class="gain">${pct(bestRoi.roi)}</strong><small>${esc(shards[bestRoi.a].name)} + ${esc(shards[bestRoi.b].name)} into ${esc(shards[bestRoi.output].name)}</small></div>
      <div class="metric"><span>Bazaar snapshot</span><strong>${timeFmt.format(state.bazaar.lastUpdated)}</strong><small>Refreshes every 60 seconds</small></div>
    </aside>`;
}

function renderRows(rows) {
  if (rows.length === 0) {
    const both = settings.buyMode === "instaBuy" && settings.sellMode === "instaSell";
    renderEmpty(
      "No profitable fusions match",
      both
        ? "Insta-buying and insta-selling leaves thin margins. Try buy orders or sell offers, or loosen the filters."
        : "Loosen the filters or clear the search to see more.",
    );
    el.count.textContent = "";
    el.more.hidden = true;
    return;
  }

  const shown = rows.slice(0, state.limit);
  el.rows.innerHTML = shown.map((row, i) => rowHtml(row, i + 1)).join("");
  el.count.textContent = `Showing ${shown.length} of ${intFmt.format(rows.length)} profitable fusions`;
  el.more.hidden = rows.length <= state.limit;
}

function rowHtml(row, rank) {
  const open = state.expanded.has(row.key);
  const change = state.changes.get(row.key);
  const flash = change ? ` flash-${change}` : "";
  const alts = row.alternatives.length;
  return `
    <tr class="row" tabindex="0" data-key="${row.key}" aria-expanded="${open}" style="animation-delay:${Math.min(rank, 20) * 15}ms">
      <td class="col-rank num">${rank}</td>
      <td><div class="fusion-cell">${shardHtml(row.a, row.amountA)}<span class="plus">+</span>${shardHtml(row.b, row.amountB)}</div></td>
      <td><div class="result-cell"><i class="ph ph-arrow-right" aria-hidden="true"></i>${shardHtml(row.output, row.outputQty)}${alts ? `<span class="alt-count" title="${alts} other output option${alts > 1 ? "s" : ""}">+${alts}</span>` : ""}</div></td>
      <td class="num col-hide-sm">${coins(row.cost)}</td>
      <td class="num col-hide-sm">${coins(row.revenue)}</td>
      <td class="num gain${flash}">${signed(row.profit)}</td>
      <td class="num">${pct(row.roi)}</td>
      <td class="num col-hide-sm">${compactFmt.format(row.volume)}</td>
    </tr>
    ${open ? detailHtml(row) : ""}`;
}

function detailHtml(row) {
  const { shards } = state.fusions;
  const { products } = state.bazaar;
  const item = (id, qty, unit, role) => {
    const p = products.get(shards[id].internal_id);
    return `<tr>
      <td>${shardHtml(id)}</td>
      <td>${role}</td>
      <td class="num">${qty}</td>
      <td class="num">${coins(unit)}</td>
      <td class="num">${p?.lowestOffer != null ? coins(p.lowestOffer) : "-"}</td>
      <td class="num">${p?.highestOrder != null ? coins(p.highestOrder) : "-"}</td>
      <td><a href="${wikiUrl(shards[id].name)}" target="_blank" rel="noopener">Wiki</a> / <a href="${historyUrl(shards[id].internal_id)}" target="_blank" rel="noopener">History</a></td>
    </tr>`;
  };

  const sameInput = row.a === row.b;
  const alternatives = row.alternatives.length
    ? `<div class="mini-scroll"><table class="mini">
        <thead><tr><th>Output</th><th class="num">Qty</th><th class="num">Revenue</th><th class="num">Profit</th></tr></thead>
        <tbody>${row.alternatives
          .map(
            (alt) => `<tr><td>${shardHtml(alt.id)}</td><td class="num">${alt.qty}</td><td class="num">${coins(alt.revenue)}</td><td class="num ${alt.profit >= 0 ? "gain" : "loss"}">${signed(alt.profit)}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>`
    : `<p>This pair only offers one output.</p>`;

  return `
    <tr class="detail"><td colspan="8">
      <div class="detail-inner">
        <div>
          <h3>Prices used</h3>
          <div class="mini-scroll"><table class="mini">
            <thead><tr><th>Shard</th><th>Role</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Lowest offer</th><th class="num">Highest order</th><th>Links</th></tr></thead>
            <tbody>
              ${item(row.a, row.amountA, row.priceA, sameInput ? "Inputs" : "Input 1")}
              ${sameInput ? "" : item(row.b, row.amountB, row.priceB, "Input 2")}
              ${item(row.output, row.outputQty, row.outputPrice, "Output")}
            </tbody>
          </table></div>
          <p>Insta-buy and insta-sell prices are averaged across the order book for the full stack, so they can differ from the top offer or order. Revenue is after ${settings.tax}% Bazaar tax.</p>
        </div>
        <div>
          <h3>Other outputs from this pair</h3>
          ${alternatives}
        </div>
      </div>
    </td></tr>`;
}

function renderSkeleton() {
  const widths = [18, 62, 44, 30, 30, 30, 22, 26];
  el.rows.innerHTML = Array.from(
    { length: 10 },
    () => `<tr class="skeleton">${widths.map((w, i) => `<td class="${i === 3 || i === 4 || i === 7 ? "col-hide-sm" : ""}"><span style="width:${w + Math.random() * 30}%"></span></td>`).join("")}</tr>`,
  ).join("");
}

function renderEmpty(title, body) {
  el.rows.innerHTML = `<tr class="empty"><td colspan="8"><strong>${esc(title)}</strong>${esc(body)}</td></tr>`;
}

function showError(message) {
  el.errorText.textContent = message;
  el.error.hidden = false;
}

function hideError() {
  el.error.hidden = true;
}

/* ---------- Controls ---------- */

function bindControls() {
  for (const group of document.querySelectorAll(".segmented")) {
    group.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (!button) return;
      settings[group.dataset.setting] = button.dataset.value;
      onPricingChange();
    });
  }

  el.rarityChips.innerHTML = RARITIES.map(
    (r) => `<button type="button" class="chip" data-rarity="${r}" aria-pressed="false"><span class="rarity-letter">${r[0].toUpperCase()}</span>${r[0].toUpperCase() + r.slice(1)}</button>`,
  ).join("");
  el.rarityChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const set = new Set(settings.rarities);
    set.has(chip.dataset.rarity) ? set.delete(chip.dataset.rarity) : set.add(chip.dataset.rarity);
    settings.rarities = RARITIES.filter((r) => set.has(r));
    onFilterChange();
  });

  el.tax.addEventListener("change", () => {
    const value = Number(el.tax.value);
    settings.tax = Number.isFinite(value) && value >= 0 ? value : DEFAULTS.tax;
    onPricingChange();
  });

  let searchTimer;
  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = el.search.value;
      state.limit = PAGE_SIZE;
      render();
    }, 120);
  });

  el.volume.addEventListener("change", () => {
    settings.minVolume = Math.max(0, Number(el.volume.value) || 0);
    onFilterChange();
  });

  el.budget.addEventListener("change", () => {
    const value = Number(el.budget.value);
    settings.maxCost = value > 0 ? value : null;
    onFilterChange();
  });

  el.sort.addEventListener("change", () => {
    settings.sort = el.sort.value;
    onFilterChange();
  });

  el.unique.addEventListener("change", () => {
    settings.unique = el.unique.checked;
    onFilterChange();
  });

  el.more.addEventListener("click", () => {
    state.limit += PAGE_SIZE;
    render();
  });

  el.refresh.addEventListener("click", () => refreshPrices());
  el.theme.addEventListener("click", toggleTheme);

  el.rows.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const row = e.target.closest(".row");
    if (row) toggleRow(row.dataset.key);
  });
  el.rows.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".row");
    if (!row) return;
    e.preventDefault();
    toggleRow(row.dataset.key);
    el.rows.querySelector(`.row[data-key="${row.dataset.key}"]`)?.focus();
  });
}

function toggleRow(key) {
  state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
  render();
}

function onPricingChange() {
  syncControls();
  saveSettings();
  recompute();
  render();
}

function onFilterChange() {
  syncControls();
  saveSettings();
  state.limit = PAGE_SIZE;
  render();
}

function syncControls() {
  for (const group of document.querySelectorAll(".segmented")) {
    for (const button of group.querySelectorAll("button")) {
      button.setAttribute("aria-checked", String(button.dataset.value === settings[group.dataset.setting]));
    }
  }
  for (const chip of el.rarityChips.querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(settings.rarities.includes(chip.dataset.rarity)));
  }
  el.tax.value = settings.tax;
  el.volume.value = settings.minVolume || "";
  el.budget.value = settings.maxCost ?? "";
  el.sort.value = settings.sort;
  el.unique.checked = settings.unique;
  syncThemeIcon();
}

/* ---------- Theme ---------- */

function effectiveTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Theme choice just won't persist.
  }
  syncThemeIcon();
}

function syncThemeIcon() {
  const icon = el.theme.querySelector("i");
  icon.className = `ph ${effectiveTheme() === "dark" ? "ph-sun" : "ph-moon"}`;
}

init();
