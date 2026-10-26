import { buyPrice, sellPrice, weeklyVolume } from "./bazaar.js";

// SkyShards keeps this file in sync with the game; the local copy is a fallback snapshot.
const LIVE_DATA_URL = "https://raw.githubusercontent.com/Campionnn/SkyShards/master/public/fusion-data.json";
const SNAPSHOT_URL = "./data/fusion-data.json";

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];

/**
 * Loads the recipe dataset and inverts it into fusion pairs.
 *
 * The source is keyed by output: `recipes[outputId][outputQty] = [[inputA, inputB], ...]`.
 * In game you pick two shards and get offered up to three outputs, so for profit we
 * need the reverse: each ordered pair with every output it can offer.
 */
export async function loadFusions() {
  let data;
  let source = "live";
  try {
    data = await fetchJson(LIVE_DATA_URL);
  } catch {
    data = await fetchJson(SNAPSHOT_URL);
    source = "snapshot";
  }

  const byPair = new Map();
  for (const [outputId, byQty] of Object.entries(data.recipes)) {
    for (const [qty, inputPairs] of Object.entries(byQty)) {
      for (const [a, b] of inputPairs) {
        const key = `${a}|${b}`;
        let pair = byPair.get(key);
        if (!pair) {
          pair = { a, b, outputs: [] };
          byPair.set(key, pair);
        }
        pair.outputs.push({ id: outputId, qty: Number(qty) });
      }
    }
  }

  return { shards: data.shards, pairs: [...byPair.values()], source };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

/**
 * Prices every fusion pair and returns one row per pair, using its most valuable output.
 * Pairs with an input or every output missing from the Bazaar are dropped.
 *
 * @param {{buyMode: "instaBuy"|"buyOrder", sellMode: "instaSell"|"sellOffer", tax: number}} opts
 *   `tax` is a fraction, e.g. 0.0125.
 */
export function rankFusions({ shards, pairs }, products, { buyMode, sellMode, tax }) {
  const productOf = (id) => products.get(shards[id].internal_id);
  const rows = [];

  for (const { a, b, outputs } of pairs) {
    const amountA = shards[a].fuse_amount;
    const amountB = shards[b].fuse_amount;
    // Same shard twice (e.g. Treefrog + Treefrog) means buying both stacks at once.
    const priceA = buyPrice(productOf(a), buyMode, a === b ? amountA + amountB : amountA);
    const priceB = a === b ? priceA : buyPrice(productOf(b), buyMode, amountB);
    if (priceA == null || priceB == null) continue;
    const cost = priceA * amountA + priceB * amountB;

    const options = [];
    for (const { id, qty } of outputs) {
      const unit = sellPrice(productOf(id), sellMode, qty);
      if (unit == null) continue;
      const revenue = unit * qty * (1 - tax);
      options.push({ id, qty, unit, revenue, profit: revenue - cost });
    }
    if (options.length === 0) continue;
    options.sort((x, y) => y.profit - x.profit);
    const best = options[0];

    rows.push({
      key: `${a}|${b}`,
      a,
      b,
      amountA,
      amountB,
      priceA,
      priceB,
      cost,
      output: best.id,
      outputQty: best.qty,
      outputPrice: best.unit,
      revenue: best.revenue,
      profit: best.profit,
      roi: best.profit / cost,
      alternatives: options.slice(1),
      // The slowest of the three markets limits how often this flip can be repeated.
      volume: Math.min(
        weeklyVolume(productOf(a), buyMode),
        weeklyVolume(productOf(b), buyMode),
        weeklyVolume(productOf(best.id), sellMode),
      ),
    });
  }
  return rows;
}
