// Chain page: the most profitable shards to make by feeding fusions into each other.
import { solveChains } from "./chains.js";
import { loadFusions } from "./fusions.js";
import { pendingCount, requestBaselines } from "./history.js";
import {
  PAGE_SIZE,
  bindRowToggle,
  bindSharedControls,
  coins,
  compactFmt,
  esc,
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
} from "./ui.js";

const COLUMNS = 9;
// Buy list, steps, cost, per-fusion profit and ROI are hidden on phones.
const HIDDEN_ON_PHONE = [2, 3, 5, 7, 8];

const state = {
  fusions: null,
  bazaar: null,
  // Every profitable route, recomputed only when prices or pricing settings change.
  routes: [],
  changes: new Map(),
  search: "",
  limit: PAGE_SIZE,
  expanded: new Set(),
};

const $ = (id) => document.getElementById(id);
const el = {
  search: $("search-input"),
  depth: $("depth-select"),
  sort: $("sort-select"),
  singles: $("singles-toggle"),
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
  renderSkeleton(el.rows, [18, 40, 60, 16, 16, 30, 30, 26, 22], HIDDEN_ON_PHONE);

  const prices = startPriceLoop({
    onPrices: (bazaar) => {
      state.bazaar = bazaar;
      if (!state.fusions) return;
      const before = new Map(state.routes.map((row) => [row.key, row.profit]));
      recompute();
      state.changes = new Map();
      for (const row of state.routes) {
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
  state.routes = solveChains(state.fusions, state.bazaar.products, {
    buyMode: settings.buyMode,
    sellMode: settings.sellMode,
    tax: settings.tax / 100,
    crocodileLevel: settings.crocodileLevel,
    maxDepth: settings.maxDepth,
  });
}

/* ---------- Filtering ---------- */

/** Every shard id that appears anywhere in a route, for search. */
function routeShards(node, out = new Set()) {
  out.add(node.id);
  if (!node.buy) node.children.forEach((child) => routeShards(child, out));
  return out;
}

function visibleRows() {
  const { shards } = state.fusions;
  const query = state.search.trim().toLowerCase();

  const rows = state.routes.filter((row) => {
    if (!settings.includeSingles && row.depth < 2) return false;
    if (row.volume < (settings.minVolume || 0)) return false;
    if (query && ![...routeShards(row.tree)].some((id) => shards[id].name.toLowerCase().includes(query))) return false;
    if (settings.hideInflated && check(row).status === "inflated") return false;
    return true;
  });

  const key = settings.chainSort;
  return rows.sort((x, y) => y[key] - x[key] || y.profit - x.profit);
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

/** Compact "what to buy" list: icons with quantities. */
function shoppingHtml(row) {
  return [...row.shopping]
    .map(([id, qty]) => `<span class="buy-item" title="${esc(state.fusions.shards[id].name)}">${shardHtml(id, qtyText(qty))}</span>`)
    .join("");
}

function renderOverview(rows) {
  if (rows.length === 0) {
    el.overview.innerHTML = "";
    return;
  }
  const { shards } = state.fusions;
  const trusted = rows.filter((row) => check(row).status !== "inflated");
  const pool = trusted.length ? trusted : rows;
  const best = pool.reduce((a, b) => (b.profit > a.profit ? b : a));
  const bestPerFusion = pool.reduce((a, b) => (b.profitPerFusion > a.profitPerFusion ? b : a));
  const skipped = rows.filter((row) => row.profit > best.profit).length;
  const chains = state.routes.filter((row) => row.depth >= 2).length;

  el.overview.innerHTML = `
    <article class="pick">
      <h2 class="pick-title">Most profitable chain right now</h2>
      ${skipped ? `<p class="pick-note"><i class="ph ph-warning" aria-hidden="true"></i>Skipped ${skipped} higher-profit chain${skipped > 1 ? "s" : ""} with inflated result prices.</p>` : ""}
      <div class="pick-flow">
        <span class="pick-buy">${shoppingHtml(best)}</span>
        <i class="ph ph-arrow-right op" aria-label="makes"></i>
        ${shardHtml(best.output, qtyText(best.outputQty))}
      </div>
      <div class="pick-numbers">
        <div class="metric big"><span>Profit per batch</span><strong>${signed(best.profit)}</strong></div>
        <div class="metric"><span>Fusions</span><strong>${best.fusions} over ${best.depth} step${best.depth > 1 ? "s" : ""}</strong></div>
        <div class="metric"><span>Cost</span><strong>${compactFmt.format(best.cost)}</strong></div>
        <div class="metric"><span>Return on cost</span><strong>${pct(best.roi)}</strong></div>
      </div>
    </article>
    <aside class="stats">
      <div class="metric"><span>Profitable chains</span><strong>${intFmt.format(chains)}</strong><small>2+ steps, up to ${settings.maxDepth}</small></div>
      <div class="metric"><span>Best profit per fusion</span><strong class="gain">${signed(bestPerFusion.profitPerFusion)}</strong><small>${esc(shards[bestPerFusion.output].name)} in ${bestPerFusion.fusions} fusion${bestPerFusion.fusions > 1 ? "s" : ""}</small></div>
      <div class="metric"><span>Bazaar snapshot</span><strong>${timeFmt.format(state.bazaar.lastUpdated)}</strong><small>Refreshes every 60 seconds</small></div>
    </aside>`;
}

function renderRows(rows, shown) {
  if (rows.length === 0) {
    renderEmpty(
      el.rows,
      COLUMNS,
      "No profitable chains match",
      settings.maxDepth < 4 ? "Allow longer chains, switch to buy orders or sell offers, or clear the search." : "Try buy orders or sell offers, or clear the search.",
    );
    el.count.textContent = "";
    el.more.hidden = true;
    return;
  }

  el.rows.innerHTML = shown.map((row, i) => rowHtml(row, i + 1)).join("");
  const checking = settings.priceCheck ? pendingCount() : 0;
  el.count.textContent =
    `Showing ${shown.length} of ${intFmt.format(rows.length)} profitable ${settings.includeSingles ? "routes" : "chains"}` +
    (checking ? `, checking 7-day prices for ${checking} shard${checking > 1 ? "s" : ""}` : "");
  el.more.hidden = rows.length <= state.limit;
}

function rowHtml(row, rank) {
  const open = state.expanded.has(row.key);
  const change = state.changes.get(row.key);
  const flash = change ? ` flash-${change}` : "";
  const priceStatus = check(row);
  const inflated = priceStatus.status === "inflated";
  return `
    <tr class="row" tabindex="0" data-key="${row.key}" aria-expanded="${open}" style="animation-delay:${Math.min(rank, 20) * 15}ms">
      <td class="col-rank num">${rank}</td>
      <td><div class="result-cell">${shardHtml(row.output, qtyText(row.outputQty))}${inflatedTagHtml(priceStatus)}</div></td>
      <td class="col-hide-sm"><div class="buy-list">${shoppingHtml(row)}</div></td>
      <td class="num col-hide-sm">${row.depth}</td>
      <td class="num">${row.fusions}</td>
      <td class="num col-hide-sm">${coins(row.cost)}</td>
      <td class="num ${inflated ? "suspect" : "gain"}${flash}"${inflated ? ' title="Unreliable: result price looks inflated"' : ""}>${signed(row.profit)}</td>
      <td class="num col-hide-sm">${signed(row.profitPerFusion)}</td>
      <td class="num col-hide-sm">${pct(row.roi)}</td>
    </tr>
    ${open ? detailHtml(row) : ""}`;
}

/** Nested route, final fusion at the top and bought shards at the leaves. */
function treeHtml(node) {
  const { shards } = state.fusions;
  if (node.buy) {
    return `<li><div class="tree-node">
      <span class="tree-action buy">Buy</span>${shardHtml(node.id, qtyText(node.need))}
      <span class="tree-meta">${coins(node.unit)} each, ${coins(node.unit * node.need)} total</span>
    </div></li>`;
  }
  const { a, b, fa, fb } = node.recipe;
  const inputs = a === b ? `${esc(shards[a].name)} ×${fa + fb}` : `${esc(shards[a].name)} ×${fa} + ${esc(shards[b].name)} ×${fb}`;
  const spare = node.made - node.need;
  return `<li><div class="tree-node">
      <span class="tree-action fuse">Fuse ${node.crafts}×</span>${shardHtml(node.id, qtyText(node.made))}
      <span class="tree-meta">${inputs} per fusion${spare > 1e-9 ? `, ${qtyText(spare)} spare` : ""}</span>
    </div>
    <ul>${node.children.map(treeHtml).join("")}</ul>
  </li>`;
}

/** Fusions in the order you would actually do them: deepest first. */
function fusionOrder(node, steps = []) {
  if (node.buy) return steps;
  node.children.forEach((child) => fusionOrder(child, steps));
  steps.push(node);
  return steps;
}

function detailHtml(row) {
  const { shards } = state.fusions;
  const steps = fusionOrder(row.tree)
    .map((node) => {
      const { a, b, fa, fb } = node.recipe;
      const inputs = a === b ? `${esc(shards[a].name)} ×${node.crafts * (fa + fb)}` : `${esc(shards[a].name)} ×${node.crafts * fa} and ${esc(shards[b].name)} ×${node.crafts * fb}`;
      return `<li>Fuse ${inputs} into ${esc(shards[node.id].name)} ×${qtyText(node.made)} (${node.crafts} fusion${node.crafts > 1 ? "s" : ""})</li>`;
    })
    .join("");
  const leftovers = [...row.leftovers].map(([id, qty]) => `${esc(shards[id].name)} ×${qtyText(qty)}`).join(", ");
  const boosted = settings.crocodileLevel > 0 && fusionOrder(row.tree).some((node) => node.recipe.isReptile);

  return `
    <tr class="detail"><td colspan="${COLUMNS}">
      <div class="detail-inner">
        <div>
          <h3>Route</h3>
          <ul class="tree">${treeHtml(row.tree)}</ul>
        </div>
        <div>
          <h3>Fusion order</h3>
          <ol class="steps">${steps}</ol>
          <p>Sell ${esc(shards[row.output].name)} ×${qtyText(row.outputQty)} at ${coins(row.outputPrice)} each for ${coins(row.revenue - row.leftoverValue)} after ${settings.tax}% tax.${
            leftovers ? ` Spares (${leftovers}) add ${coins(row.leftoverValue)}.` : ""
          }${boosted ? " Reptile steps use the average Pure Reptile output, so profit is an expected value." : ""}</p>
          ${priceCheckHtml(shards, row)}
        </div>
      </div>
    </td></tr>`;
}

/* ---------- Controls ---------- */

function bindControls() {
  bindSharedControls({ onPricingChange, onFilterChange });

  let searchTimer;
  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = el.search.value;
      state.limit = PAGE_SIZE;
      render();
    }, 120);
  });

  el.depth.addEventListener("change", () => {
    settings.maxDepth = Number(el.depth.value);
    onPricingChange();
  });

  el.sort.addEventListener("change", () => {
    settings.chainSort = el.sort.value;
    onFilterChange();
  });

  el.singles.addEventListener("change", () => {
    settings.includeSingles = el.singles.checked;
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
  el.depth.value = String(settings.maxDepth);
  el.sort.value = settings.chainSort;
  el.singles.checked = settings.includeSingles;
}

init();
