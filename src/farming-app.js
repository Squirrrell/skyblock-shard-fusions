// Farming page: the most profitable shards to hunt with each tool, in coins per hour.
import { TOOLS, loadFarming, rankFarming } from "./farming.js";
import { loadFusions } from "./fusions.js";
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
  priceCheck,
  priceCheckHtml,
  renderEmpty,
  renderSkeleton,
  saveSettings,
  settings,
  shardHtml as sharedShardHtml,
  showError,
  startPriceLoop,
  syncSharedControls,
  wikiUrl,
} from "./ui.js";

const COLUMNS = 8;
// Tool, place, price and weekly volume are hidden on phones.
const HIDDEN_ON_PHONE = [2, 3, 5, 7];

const state = {
  shards: null,
  farming: null,
  bazaar: null,
  rows: [],
  changes: new Map(),
  search: "",
  limit: PAGE_SIZE,
  expanded: new Set(),
};

const $ = (id) => document.getElementById(id);
const el = {
  fortune: $("fortune-input"),
  efficiency: $("efficiency-select"),
  search: $("search-input"),
  sort: $("sort-select"),
  overview: $("overview"),
  rows: $("rows"),
  count: $("count-text"),
  more: $("more-btn"),
};

const shardHtml = (id, qty) => sharedShardHtml(state.shards, id, qty);
const check = (row) => priceCheck(state.shards, row);
const perHour = (n) => compactFmt.format(n);

/* ---------- Data ---------- */

async function init() {
  bindControls();
  syncControls();
  renderSkeleton(el.rows, [18, 44, 40, 50, 22, 26, 30, 24], HIDDEN_ON_PHONE);

  const prices = startPriceLoop({
    onPrices: (bazaar) => {
      state.bazaar = bazaar;
      if (!state.farming) return;
      const before = new Map(state.rows.map((row) => [row.key, row.moneyPerHour]));
      recompute();
      state.changes = new Map();
      for (const row of state.rows) {
        const prev = before.get(row.key);
        if (prev !== undefined && Math.round(prev) !== Math.round(row.moneyPerHour)) {
          state.changes.set(row.key, row.moneyPerHour > prev ? "up" : "down");
        }
      }
      render();
    },
    onFirstFailure: () => renderEmpty(el.rows, COLUMNS, "Waiting for Bazaar prices", "The table fills in as soon as the Bazaar API responds."),
  });

  try {
    const [fusions, farming] = await Promise.all([loadFusions(), loadFarming()]);
    state.shards = fusions.shards;
    state.farming = farming;
    await prices.ready;
    recompute();
    document.body.classList.add("intro");
    render();
    setTimeout(() => document.body.classList.remove("intro"), 1200);
  } catch (err) {
    showError(`Could not load shard data: ${err.message}`);
  }
}

function recompute() {
  if (!state.farming || !state.bazaar) return;
  state.rows = rankFarming(state.farming, state.shards, state.bazaar.products, {
    sellMode: settings.sellMode,
    tax: settings.tax / 100,
    hunterFortune: settings.hunterFortune,
    efficiency: settings.efficiency,
  });
}

/* ---------- Filtering ---------- */

/** Rows passing every filter except the tool, so the per-tool cards can use them too. */
function filteredRows() {
  const query = state.search.trim().toLowerCase();
  return state.rows.filter((row) => {
    if (row.volume < (settings.minVolume || 0)) return false;
    if (query && !`${state.shards[row.output].name} ${row.zones.join(" ")}`.toLowerCase().includes(query)) return false;
    if (settings.hideInflated && check(row).status === "inflated") return false;
    return true;
  });
}

function visibleRows(rows) {
  const tool = settings.farmTool;
  const key = settings.farmSort;
  return rows.filter((row) => tool === "all" || row.tools.includes(tool)).sort((x, y) => y[key] - x[key] || y.moneyPerHour - x.moneyPerHour);
}

/* ---------- Rendering ---------- */

let historyRenderTimer;
// History arrives one product at a time; batch the re-renders it triggers.
const renderSoon = () => {
  clearTimeout(historyRenderTimer);
  historyRenderTimer = setTimeout(render, 400);
};

function render() {
  if (!state.farming || !state.bazaar) return;
  const filtered = filteredRows();
  const rows = visibleRows(filtered);
  const shown = rows.slice(0, state.limit);
  if (settings.priceCheck) {
    // Shown rows plus the top few per tool, which the cards display.
    const ids = new Set(shown.map((row) => state.shards[row.output].internal_id));
    for (const tool of Object.keys(TOOLS)) {
      for (const row of topFor(filtered, tool, 3)) ids.add(state.shards[row.output].internal_id);
    }
    requestBaselines(ids, renderSoon);
  }
  renderToolCards(filtered);
  renderRows(rows, shown);
  state.changes = new Map();
}

function topFor(rows, tool, count) {
  return rows
    .filter((row) => row.tools.includes(tool))
    .sort((x, y) => y.moneyPerHour - x.moneyPerHour)
    .slice(0, count);
}

function toolTag(tool) {
  const t = TOOLS[tool];
  return `<span class="tool-tag" title="${t.label}"><i class="ph ${t.icon}" aria-hidden="true"></i>${t.short}</span>`;
}

/** One card per tool: the best shard to farm with it, plus the next two. */
function renderToolCards(rows) {
  el.overview.innerHTML = Object.entries(TOOLS)
    .map(([tool, t]) => {
      // Inflated prices would make a shard look better than it is, so cards skip them.
      const top = topFor(rows.filter((row) => check(row).status !== "inflated"), tool, 3);
      const active = settings.farmTool === tool;
      if (top.length === 0) {
        return `<article class="tool-card"><h2><i class="ph ${t.icon}" aria-hidden="true"></i>${t.label}</h2><p class="tool-empty">Nothing matches the current filters.</p></article>`;
      }
      const [best, ...rest] = top;
      return `
        <button type="button" class="tool-card${active ? " is-active" : ""}" data-tool="${tool}" aria-pressed="${active}" title="Show only ${t.label} shards">
          <h2><i class="ph ${t.icon}" aria-hidden="true"></i>${t.label}</h2>
          <div class="tool-best">${shardHtml(best.output)}</div>
          <strong class="tool-money">${perHour(best.moneyPerHour)}<span>coins/h</span></strong>
          <span class="tool-sub">About ${intFmt.format(Math.round(best.catchesPerHour))} catches/h${best.zones[0] ? ` in ${esc(best.zones[0])}` : ""}</span>
          ${
            rest.length
              ? `<ol class="tool-rest" start="2">${rest
                  .map((row) => `<li><span>${esc(state.shards[row.output].name)}</span><span class="mono">${perHour(row.moneyPerHour)}/h</span></li>`)
                  .join("")}</ol>`
              : ""
          }
        </button>`;
    })
    .join("");
}

function renderRows(rows, shown) {
  if (rows.length === 0) {
    renderEmpty(el.rows, COLUMNS, "No shards match", "Clear the search, lower the minimum volume or pick another tool.");
    el.count.textContent = "";
    el.more.hidden = true;
    return;
  }
  el.rows.innerHTML = shown.map((row, i) => rowHtml(row, i + 1)).join("");
  const checking = settings.priceCheck ? pendingCount() : 0;
  el.count.textContent =
    `Showing ${shown.length} of ${intFmt.format(rows.length)} huntable shards` +
    (checking ? `, checking 7-day prices for ${checking} shard${checking > 1 ? "s" : ""}` : "");
  el.more.hidden = rows.length <= state.limit;
}

function rowHtml(row, rank) {
  const open = state.expanded.has(row.key);
  const change = state.changes.get(row.key);
  const flash = change ? ` flash-${change}` : "";
  const priceStatus = check(row);
  const inflated = priceStatus.status === "inflated";
  const thin = row.thinMarket ? `<span class="thin-tag" title="One hour of farming is more than a tenth of what sells in a day, so prices may drop as you sell">Thin market</span>` : "";
  return `
    <tr class="row" tabindex="0" data-key="${row.key}" aria-expanded="${open}" style="animation-delay:${Math.min(rank, 20) * 15}ms">
      <td class="col-rank num">${rank}</td>
      <td><div class="result-cell">${shardHtml(row.output)}${inflatedTagHtml(priceStatus)}${thin}</div></td>
      <td class="col-hide-sm"><div class="tool-list">${row.tools.map(toolTag).join("")}</div></td>
      <td class="col-hide-sm where">${row.zones.length ? esc(row.zones.slice(0, 2).join(", ")) : `<a href="${wikiUrl(state.shards[row.output].name)}" target="_blank" rel="noopener">See wiki</a>`}</td>
      <td class="num">${intFmt.format(Math.round(row.catchesPerHour))}</td>
      <td class="num col-hide-sm col-hide-md">${coins(row.outputPrice)}</td>
      <td class="num ${inflated ? "suspect" : "gain"}${flash}"${inflated ? ' title="Unreliable: price looks inflated"' : ""}>${perHour(row.moneyPerHour)}</td>
      <td class="num col-hide-sm col-hide-md">${compactFmt.format(row.volume)}</td>
    </tr>
    ${open ? detailHtml(row) : ""}`;
}

function detailHtml(row) {
  const shard = state.shards[row.output];
  const name = esc(shard.name);
  const perCatch = 1 + settings.hunterFortune / 100;
  const how = {
    blackHole: `Hit ${name} with a Huntaxe until it's below 10% health, then place a Pocket Black Hole to capture it.`,
    lasso: `Throw a Lasso at ${name}, wait for its stamina to drain, then reel it in when prompted.`,
    net: `Throw a Fishing Net at ${name} in the water. Stronger nets (more Pull) catch tougher fish faster.`,
  };
  return `
    <tr class="detail"><td colspan="${COLUMNS}">
      <div class="detail-inner">
        <div>
          <h3>How to farm it</h3>
          <ul class="how">${row.tools.map((tool) => `<li>${toolTag(tool)}<span>${how[tool]}</span></li>`).join("")}</ul>
          <p>${row.zones.length ? `Spawns in ${esc(row.zones.join(", "))}.` : "The wiki lists no huntrap zones for it."} <a href="${wikiUrl(shard.name)}" target="_blank" rel="noopener">Wiki</a> / <a href="${historyUrl(shard.internal_id)}" target="_blank" rel="noopener">Price history</a></p>
        </div>
        <div>
          <h3>The estimate</h3>
          <p>About ${intFmt.format(Math.round(row.catchesPerHour))} catches per hour${settings.efficiency < 1 ? ` (${Math.round(settings.efficiency * 100)}% of the best-case rate)` : " in the best case"}. With ${settings.hunterFortune} Hunter Fortune that's ${perCatch.toFixed(2)} shards per catch, so about ${intFmt.format(Math.round(row.shardsPerHour))} shards per hour.</p>
          <p>At ${coins(row.outputPrice)} each after ${settings.tax}% tax, that's <strong class="gain">${coins(row.moneyPerHour)}</strong> coins per hour. ${
            row.thinMarket
              ? `The market only trades about ${intFmt.format(Math.round(row.volume / 7))} a day, so selling a full hour's haul will likely push the price down.`
              : `About ${intFmt.format(Math.round(row.volume / 7))} trade per day, so the market can absorb it.`
          }</p>
          ${priceCheckHtml(state.shards, row)}
        </div>
      </div>
    </td></tr>`;
}

/* ---------- Controls ---------- */

function bindControls() {
  bindSharedControls({ onPricingChange, onFilterChange });

  el.fortune.addEventListener("change", () => {
    settings.hunterFortune = Math.max(0, Math.round(Number(el.fortune.value)) || 0);
    onPricingChange();
  });

  el.efficiency.addEventListener("change", () => {
    settings.efficiency = Number(el.efficiency.value) || 1;
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

  el.sort.addEventListener("change", () => {
    settings.farmSort = el.sort.value;
    onFilterChange();
  });

  // Clicking a tool card filters the table to that tool; clicking it again shows all.
  el.overview.addEventListener("click", (e) => {
    const card = e.target.closest(".tool-card[data-tool]");
    if (!card) return;
    settings.farmTool = settings.farmTool === card.dataset.tool ? "all" : card.dataset.tool;
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
  el.fortune.value = settings.hunterFortune;
  el.efficiency.value = String(settings.efficiency);
  el.sort.value = settings.farmSort;
}

init();
