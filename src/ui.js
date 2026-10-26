// Shared by the single-fusion page (app.js) and the chain page (chains-app.js):
// formatting, settings, the price refresh loop, the 7-day price check and common controls.
import { fetchBazaar } from "./bazaar.js";
import { getBaseline } from "./history.js";

export const REFRESH_MS = 60_000;
export const PAGE_SIZE = 100;
const SETTINGS_KEY = "sff-settings";
const THEME_KEY = "sff-theme";

export const iconUrl = (id) => `https://raw.githubusercontent.com/Campionnn/SkyShards/master/public/shardIcons/${id}.png`;
export const wikiUrl = (name) => `https://hypixelskyblock.minecraft.wiki/w/${encodeURIComponent(name.replaceAll(" ", "_"))}_Shard`;
export const historyUrl = (productId) => `https://sky.coflnet.com/item/${productId}`;

/* ---------- Formatting ---------- */

export const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
export const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const coins = (n) => intFmt.format(Math.round(n));
export const signed = (n) => (n > 0 ? "+" : n < 0 ? "-" : "") + coins(Math.abs(n));
export const pct = (r) => `${(r * 100).toFixed(1)}%`;
export const qtyText = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function shardHtml(shards, id, qty) {
  const shard = shards[id];
  const r = shard.rarity;
  return `<span class="shard" data-rarity="${r}">
    <img src="${iconUrl(id)}" alt="" width="24" height="24" loading="lazy" onerror="this.style.visibility='hidden'">
    <span class="rarity-letter" title="${r[0].toUpperCase() + r.slice(1)}">${r[0].toUpperCase()}</span>
    <span>${esc(shard.name)}</span>${qty ? `<span class="qty">×${qty}</span>` : ""}
  </span>`;
}

/* ---------- Settings (shared by both pages) ---------- */

const DEFAULTS = {
  buyMode: "instaBuy",
  sellMode: "instaSell",
  tax: 1.25,
  crocodileLevel: 0,
  minVolume: 0,
  maxCost: null,
  rarities: ["common", "uncommon", "rare", "epic", "legendary"],
  sort: "profit",
  unique: true,
  // Flag outputs priced this far above their 7-day median; 0 turns the check off.
  priceCheck: 0.25,
  hideInflated: false,
  // Chain page
  chainSort: "profit",
  maxDepth: 3,
  includeSingles: false,
  // Farming page
  farmTool: "all",
  farmSort: "moneyPerHour",
  hunterFortune: 0,
  efficiency: 1,
};

export const settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
})();

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); settings just won't persist.
  }
}

/* ---------- 7-day price check ---------- */

/**
 * Compares the output's current price with its 7-day median, on the same side of the book
 * the sell mode uses. A pumped output is what makes a fake flip look profitable; inputs
 * priced high only shrink the profit, so they aren't checked.
 *
 * `row` needs output, outputPrice, cost and the expected output quantity (expectedQty, or
 * outputQty when that is already the expected amount); leftoverValue is added if present.
 */
export function priceCheck(shards, row) {
  if (!settings.priceCheck) return { status: "off" };
  const baseline = getBaseline(shards[row.output].internal_id);
  if (!baseline) return { status: "pending" };
  const median = settings.sellMode === "instaSell" ? baseline.sell : baseline.buy;
  if (!median) return { status: "unknown" };
  const ratio = row.outputPrice / median;
  const qty = row.expectedQty ?? row.outputQty;
  return {
    status: ratio >= 1 + settings.priceCheck ? "inflated" : "ok",
    ratio,
    median,
    medianProfit: median * qty * (1 - settings.tax / 100) + (row.leftoverValue || 0) - row.cost,
  };
}

export function inflatedTagHtml(check) {
  if (check.status !== "inflated") return "";
  return `<span class="inflated-tag" title="Output price is ${pct(check.ratio - 1)} above its 7-day median of ${coins(check.median)}. It may be artificially inflated."><i class="ph ph-warning" aria-hidden="true"></i><span>+${Math.round((check.ratio - 1) * 100)}% vs 7d</span></span>`;
}

export function priceCheckHtml(shards, row) {
  const check = priceCheck(shards, row);
  const name = esc(shards[row.output].name);
  const side = settings.sellMode === "instaSell" ? "insta-sell" : "lowest offer";
  switch (check.status) {
    case "off":
      return "";
    case "pending":
      return `<p class="check">Checking the 7-day price history of ${name}.</p>`;
    case "unknown":
      return `<p class="check">Not enough 7-day price history for ${name} to check for inflation.</p>`;
    default: {
      const diff = check.ratio - 1;
      return `<p class="check${check.status === "inflated" ? " is-inflated" : ""}">
        ${check.status === "inflated" ? '<i class="ph ph-warning" aria-hidden="true"></i>' : ""}
        The ${side} price of ${name} is ${pct(Math.abs(diff))} ${diff >= 0 ? "above" : "below"} its 7-day median of ${coins(check.median)}.
        At the median this would make <strong class="${check.medianProfit >= 0 ? "gain" : "loss"}">${signed(check.medianProfit)}</strong>.
      </p>`;
    }
  }
}

/* ---------- Price loop ---------- */

/**
 * Fetches Bazaar prices now and every 60 seconds while the tab is visible, and keeps the
 * status text and error banner current. `onPrices(bazaar)` runs after each successful fetch.
 */
export function startPriceLoop({ onPrices, onFirstFailure }) {
  const statusEl = document.getElementById("status-text");
  const refreshBtn = document.getElementById("refresh-btn");
  const loop = { bazaar: null, lastFetch: 0, loading: false };

  const updateStatus = () => {
    if (!loop.bazaar) {
      statusEl.textContent = loop.loading ? "Loading prices" : "Prices unavailable";
      return;
    }
    const age = Math.max(0, Math.round((Date.now() - loop.bazaar.lastUpdated) / 1000));
    const next = Math.max(0, Math.ceil((REFRESH_MS - (Date.now() - loop.lastFetch)) / 1000));
    statusEl.textContent = loop.loading ? "Refreshing" : `Prices ${age}s old, refresh in ${next}s`;
  };

  loop.refresh = async () => {
    if (loop.loading) return;
    loop.loading = true;
    refreshBtn.classList.add("spinning");
    try {
      loop.bazaar = await fetchBazaar();
      hideError();
      onPrices(loop.bazaar);
    } catch (err) {
      const stale = loop.bazaar ? " Showing the last prices that loaded." : "";
      showError(`Bazaar prices failed to load (${err.message}).${stale} Retrying automatically.`);
      if (!loop.bazaar) onFirstFailure?.();
    } finally {
      // Count failures as attempts too, so a down API is retried once per interval, not every second.
      loop.lastFetch = Date.now();
      loop.loading = false;
      refreshBtn.classList.remove("spinning");
      updateStatus();
    }
  };

  const tick = () => {
    if (document.visibilityState === "visible" && Date.now() - loop.lastFetch >= REFRESH_MS) loop.refresh();
    updateStatus();
  };

  refreshBtn.addEventListener("click", () => loop.refresh());
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", tick);
  loop.ready = loop.refresh();
  return loop;
}

export function showError(message) {
  document.getElementById("error-text").textContent = message;
  document.getElementById("error-banner").hidden = false;
}

function hideError() {
  document.getElementById("error-banner").hidden = true;
}

/* ---------- Shared controls ---------- */

const byId = (id) => document.getElementById(id);

/**
 * Binds the controls both pages have: buy/sell mode, tax, Crocodile level, minimum volume,
 * price check threshold, hide-inflated switch and the theme button. Pricing changes need a
 * recompute; the others only a re-render.
 */
export function bindSharedControls({ onPricingChange, onFilterChange }) {
  for (const group of document.querySelectorAll(".segmented")) {
    group.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (!button) return;
      settings[group.dataset.setting] = button.dataset.value;
      onPricingChange();
    });
  }

  // Not every page has every control, so missing ones are skipped.
  const on = (id, handler) => byId(id)?.addEventListener("change", (e) => handler(e.target));

  on("tax-input", (input) => {
    const value = Number(input.value);
    settings.tax = Number.isFinite(value) && value >= 0 ? value : DEFAULTS.tax;
    onPricingChange();
  });

  on("croco-input", (input) => {
    const value = Math.round(Number(input.value));
    settings.crocodileLevel = Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : 0;
    onPricingChange();
  });

  on("volume-input", (input) => {
    settings.minVolume = Math.max(0, Number(input.value) || 0);
    onFilterChange();
  });

  on("price-check-select", (input) => {
    settings.priceCheck = Number(input.value);
    onFilterChange();
  });

  on("inflated-toggle", (input) => {
    settings.hideInflated = input.checked;
    onFilterChange();
  });

  byId("theme-btn").addEventListener("click", toggleTheme);
}

export function syncSharedControls() {
  for (const group of document.querySelectorAll(".segmented")) {
    for (const button of group.querySelectorAll("button")) {
      button.setAttribute("aria-checked", String(button.dataset.value === settings[group.dataset.setting]));
    }
  }
  const set = (id, prop, value) => {
    const input = byId(id);
    if (input) input[prop] = value;
  };
  set("tax-input", "value", settings.tax);
  set("croco-input", "value", settings.crocodileLevel);
  set("volume-input", "value", settings.minVolume || "");
  set("price-check-select", "value", String(settings.priceCheck));
  set("inflated-toggle", "checked", settings.hideInflated);
  set("inflated-toggle", "disabled", !settings.priceCheck);
  syncThemeIcon();
}

/* ---------- Table states ---------- */

/** Placeholder rows shaped like the real table while data loads. */
export function renderSkeleton(tbody, widths, hiddenOnPhone = []) {
  tbody.innerHTML = Array.from(
    { length: 10 },
    () =>
      `<tr class="skeleton">${widths
        .map((w, i) => `<td class="${hiddenOnPhone.includes(i) ? "col-hide-sm" : ""}"><span style="width:${w + Math.random() * 30}%"></span></td>`)
        .join("")}</tr>`,
  ).join("");
}

export function renderEmpty(tbody, columns, title, body) {
  tbody.innerHTML = `<tr class="empty"><td colspan="${columns}"><strong>${esc(title)}</strong>${esc(body)}</td></tr>`;
}

/** Makes table rows with class "row" expand/collapse on click, Enter or Space. */
export function bindRowToggle(tbody, toggle) {
  tbody.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const row = e.target.closest(".row");
    if (row) toggle(row.dataset.key);
  });
  tbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".row");
    if (!row) return;
    e.preventDefault();
    toggle(row.dataset.key);
    tbody.querySelector(`.row[data-key="${row.dataset.key}"]`)?.focus();
  });
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
  byId("theme-btn").querySelector("i").className = `ph ${effectiveTheme() === "dark" ? "ph-sun" : "ph-moon"}`;
}
