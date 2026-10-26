// Single-fusion page: ranks every A + B fusion pair by profit.
import { loadFusions, rankFusions, RARITIES } from "./fusions.js";
import { pendingCount, requestBaselines } from "./history.js";
import {
  PAGE_SIZE,
  bindRowToggle,
  bindSharedControls,
  coins,
  compactFmt,
  esc,
  historyUrl,
  inflatedTagHtml,
  intFmt,
  pct,
  priceCheck,
  priceCheckHtml,
  qtyText,
  renderEmpty,
  renderSkeleton,
  saveSettings,
  settings,
  shardHtml as sharedShardHtml,
  showError,
  signed,
  startPriceLoop,
  syncSharedControls,
  timeFmt,
  wikiUrl,
} from "./ui.js";

const COLUMNS = 8;
// Cost, revenue and weekly volume are hidden on phones.
const HIDDEN_ON_PHONE = [3, 4, 7];

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
};

const $ = (id) => document.getElementById(id);
const el = {
  search: $("search-input"),
  budget: $("budget-input"),
  rarityChips: $("rarity-chips"),
  sort: $("sort-select"),
  unique: $("unique-toggle"),
  overview: $("overview"),
  rows: $("rows"),
  count: $("count-text"),
  more: $("more-btn"),
  dataSource: $("data-source"),
};

const shardHtml = (id, qty) => sharedShardHtml(state.fusions.shards, id, qty);
const check = (row) => priceCheck(state.fusions.shards, row);

/* ---------- Data ---------- */

async function init() {
  bindControls();
  syncControls();
  renderSkeleton(el.rows, [18, 62, 44, 30, 30, 30, 22, 26], HIDDEN_ON_PHONE);

  const prices = startPriceLoop({
    onPrices: (bazaar) => {
      state.bazaar = bazaar;
      if (!state.fusions) return;
      const before = new Map(state.ranked.map((row) => [row.key, row.profit]));
      recompute();
      state.changes = new Map();
      for (const row of state.ranked) {
        const prev = before.get(row.key);
        if (prev !== undefined && Math.round(prev) !== Math.round(row.profit)) {
          state.changes.set(row.key, row.profit > prev ? "up" : "down");
        }
      }
      render();
    },
    onFirstFailure: () => renderEmpty(el.rows, COLUMNS, "Waiting for Bazaar prices", "The table fills in as soon as the Bazaar API responds."),
  });

  try {
    state.fusions = await loadFusions();
    await prices.ready;
    el.dataSource.textContent = state.fusions.source === "live" ? "latest data" : "offline snapshot";
    recompute();
    document.body.classList.add("intro");
    render();
    setTimeout(() => document.body.classList.remove("intro"), 1200);
  } catch (err) {
    showError(`Could not load fusion recipes: ${err.message}`);
  }
}

function recompute() {
  if (!state.fusions || !state.bazaar) return;
  state.ranked = rankFusions(state.fusions, state.bazaar.products, {
    buyMode: settings.buyMode,
    sellMode: settings.sellMode,
    tax: settings.tax / 100,
    crocodileLevel: settings.crocodileLevel,
  });
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
    if (settings.hideInflated && check(row).status === "inflated") return false;
    return true;
  });

  const key = settings.sort;
  rows.sort((x, y) => y[key] - x[key] || y.profit - x.profit);

  if (!settings.unique) return rows;
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.output) && seen.add(row.output));
}

/* ---------- Rendering ---------- */

let historyRenderTimer;
// History arrives one product at a time; batch the re-renders it triggers.
const renderSoon = () => {
  clearTimeout(historyRenderTimer);
  historyRenderTimer = setTimeout(render, 400);
};

function render() {
  if (!state.fusions || !state.bazaar) return;
  const rows = visibleRows();
  const shown = rows.slice(0, state.limit);
  if (settings.priceCheck) {
    requestBaselines(new Set(shown.map((row) => state.fusions.shards[row.output].internal_id)), renderSoon);
  }
  renderOverview(rows);
  renderRows(rows, shown);
  state.changes = new Map();
}

function renderOverview(rows) {
  if (rows.length === 0) {
    el.overview.innerHTML = "";
    return;
  }
  const { shards } = state.fusions;
  // Skip pumped outputs for the headline pick; fall back to the raw best if everything is flagged.
  const trusted = rows.filter((row) => check(row).status !== "inflated");
  const best = (trusted.length ? trusted : rows).reduce((a, b) => (b.profit > a.profit ? b : a));
  const skipped = rows.filter((row) => row.profit > best.profit).length;
  const bestRoi = rows.reduce((a, b) => (b.roi > a.roi ? b : a));
  const totalPriced = state.ranked.length;
  const profitable = state.ranked.filter((r) => r.profit > 0).length;

  el.overview.innerHTML = `
    <article class="pick">
      <h2 class="pick-title">Most profitable fusion right now</h2>
      ${skipped ? `<p class="pick-note"><i class="ph ph-warning" aria-hidden="true"></i>Skipped ${skipped} higher-profit fusion${skipped > 1 ? "s" : ""} with inflated output prices.</p>` : ""}
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

function renderRows(rows, shown) {
  if (rows.length === 0) {
    const both = settings.buyMode === "instaBuy" && settings.sellMode === "instaSell";
    renderEmpty(
      el.rows,
      COLUMNS,
      "No profitable fusions match",
      both
        ? "Insta-buying and insta-selling leaves thin margins. Try buy orders or sell offers, or loosen the filters."
        : "Loosen the filters or clear the search to see more.",
    );
    el.count.textContent = "";
    el.more.hidden = true;
    return;
  }

  el.rows.innerHTML = shown.map((row, i) => rowHtml(row, i + 1)).join("");
  const checking = settings.priceCheck ? pendingCount() : 0;
  el.count.textContent =
    `Showing ${shown.length} of ${intFmt.format(rows.length)} profitable fusions` +
    (checking ? `, checking 7-day prices for ${checking} shard${checking > 1 ? "s" : ""}` : "");
  el.more.hidden = rows.length <= state.limit;
}

function rowHtml(row, rank) {
  const open = state.expanded.has(row.key);
  const change = state.changes.get(row.key);
  const flash = change ? ` flash-${change}` : "";
  const alts = row.alternatives.length;
  const boosted = row.isReptile && settings.crocodileLevel > 0;
  const reptileTag = boosted
    ? `<span class="reptile-tag" title="Pure Reptile: expected ×${qtyText(row.expectedQty)} output at Crocodile ${settings.crocodileLevel}">Reptile</span>`
    : "";
  const priceStatus = check(row);
  const inflated = priceStatus.status === "inflated";
  return `
    <tr class="row" tabindex="0" data-key="${row.key}" aria-expanded="${open}" style="animation-delay:${Math.min(rank, 20) * 15}ms">
      <td class="col-rank num">${rank}</td>
      <td><div class="fusion-cell">${shardHtml(row.a, row.amountA)}<span class="plus">+</span>${shardHtml(row.b, row.amountB)}</div></td>
      <td><div class="result-cell"><i class="ph ph-arrow-right" aria-hidden="true"></i>${shardHtml(row.output, row.outputQty)}${inflatedTagHtml(priceStatus)}${reptileTag}${alts ? `<span class="alt-count" title="${alts} other output option${alts > 1 ? "s" : ""}">+${alts}</span>` : ""}</div></td>
      <td class="num col-hide-sm">${coins(row.cost)}</td>
      <td class="num col-hide-sm">${coins(row.revenue)}</td>
      <td class="num ${inflated ? "suspect" : "gain"}${flash}"${inflated ? ' title="Unreliable: output price looks inflated"' : ""}>${signed(row.profit)}</td>
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
            (alt) => `<tr><td>${shardHtml(alt.id)}</td><td class="num">${qtyText(alt.expectedQty)}</td><td class="num">${coins(alt.revenue)}</td><td class="num ${alt.profit >= 0 ? "gain" : "loss"}">${signed(alt.profit)}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>`
    : `<p>This pair only offers one output.</p>`;

  return `
    <tr class="detail"><td colspan="${COLUMNS}">
      <div class="detail-inner">
        <div>
          <h3>Prices used</h3>
          <div class="mini-scroll"><table class="mini">
            <thead><tr><th>Shard</th><th>Role</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Lowest offer</th><th class="num">Highest order</th><th>Links</th></tr></thead>
            <tbody>
              ${item(row.a, row.amountA, row.priceA, sameInput ? "Inputs" : "Input 1")}
              ${sameInput ? "" : item(row.b, row.amountB, row.priceB, "Input 2")}
              ${item(row.output, qtyText(row.expectedQty), row.outputPrice, "Output")}
            </tbody>
          </table></div>
          <p>Insta-buy and insta-sell prices are averaged across the order book for the full stack, so they can differ from the top offer or order. Revenue is after ${settings.tax}% Bazaar tax.${
            row.isReptile && settings.crocodileLevel > 0
              ? ` This is a reptile fusion, so output is the average with a ${settings.crocodileLevel * 2}% Pure Reptile chance to double: profit is an expected value over many fusions.`
              : ""
          }</p>
          ${priceCheckHtml(shards, row)}
        </div>
        <div>
          <h3>Other outputs from this pair</h3>
          ${alternatives}
        </div>
      </div>
    </td></tr>`;
}

/* ---------- Controls ---------- */

function bindControls() {
  bindSharedControls({ onPricingChange, onFilterChange });

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

  let searchTimer;
  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = el.search.value;
      state.limit = PAGE_SIZE;
      render();
    }, 120);
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

  bindRowToggle(el.rows, (key) => {
    state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
    render();
  });
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
  syncSharedControls();
  for (const chip of el.rarityChips.querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(settings.rarities.includes(chip.dataset.rarity)));
  }
  el.budget.value = settings.maxCost ?? "";
  el.sort.value = settings.sort;
  el.unique.checked = settings.unique;
}

init();
