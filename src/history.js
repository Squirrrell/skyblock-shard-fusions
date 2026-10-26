// 7-day price baselines from Coflnet, used to spot outputs whose current price is pumped.
// The Hypixel API has no price history, so this is the only external source besides the Bazaar.
// Coflnet returns ~2-hourly points, allows CORS and is rate limited (about 50 requests per
// short window), so requests go through a small pool and results are cached for an hour.
const HISTORY_URL = (productId) => `https://sky.coflnet.com/api/bazaar/${productId}/history/week`;
const CACHE_KEY = "sff-history-v1";
const TTL_MS = 60 * 60 * 1000;
const CONCURRENCY = 3;
const MAX_TRIES = 3;
// Fewer points than a day's worth isn't a trustworthy baseline.
const MIN_POINTS = 12;

/** productId -> { buy, sell, fetchedAt } where buy/sell are 7-day medians or null. */
const baselines = loadCache();
const queue = [];
const queued = new Set();
let active = 0;
let onUpdate = () => {};

/** Baseline for a product, or undefined while it hasn't been fetched (or has expired). */
export function getBaseline(productId) {
  const entry = baselines.get(productId);
  return entry && Date.now() - entry.fetchedAt < TTL_MS ? entry : undefined;
}

/** Number of products still waiting for history. */
export const pendingCount = () => queued.size;

/**
 * Queues history fetches for any product that has no fresh baseline. `callback` runs after
 * each product resolves, so the caller should debounce its re-render.
 */
export function requestBaselines(productIds, callback) {
  onUpdate = callback;
  for (const id of productIds) {
    if (getBaseline(id) || queued.has(id)) continue;
    queued.add(id);
    queue.push({ id, tries: 0 });
  }
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    fetchBaseline(job).finally(() => {
      active--;
      pump();
    });
  }
}

async function fetchBaseline(job) {
  try {
    const res = await fetch(HISTORY_URL(job.id));
    if (res.status === 429 && ++job.tries < MAX_TRIES) {
      // Rate limited: back off, then retry at the end of the queue.
      await new Promise((resolve) => setTimeout(resolve, 2000 * job.tries));
      queue.push(job);
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const points = await res.json();
    baselines.set(job.id, {
      buy: median(points.map((p) => p.buy)),
      sell: median(points.map((p) => p.sell)),
      fetchedAt: Date.now(),
    });
  } catch {
    // Record the miss so the row stops showing "checking"; it is retried after the TTL.
    baselines.set(job.id, { buy: null, sell: null, fetchedAt: Date.now() });
  }
  queued.delete(job.id);
  saveCache();
  onUpdate();
}

function median(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length < MIN_POINTS) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function loadCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return new Map(Object.entries(saved).filter(([, entry]) => Date.now() - entry.fetchedAt < TTL_MS));
  } catch {
    return new Map();
  }
}

let saveTimer;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(baselines)));
    } catch {
      // Cache is a convenience; without it history is just refetched next visit.
    }
  }, 500);
}
