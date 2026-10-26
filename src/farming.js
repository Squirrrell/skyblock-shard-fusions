import { sellPrice, weeklyVolume } from "./bazaar.js";

export const TOOLS = {
  blackHole: { label: "Huntaxe + Black Hole", short: "Black Hole", icon: "ph-axe" },
  lasso: { label: "Lasso", short: "Lasso", icon: "ph-lasso" },
  net: { label: "Fishing Net", short: "Net", icon: "ph-fish-simple" },
};

/** Tool, spawn zones and base rate per huntable shard, built by scripts/build-farming-data.mjs. */
export async function loadFarming() {
  const res = await fetch("./data/farming.json");
  if (!res.ok) throw new Error(`farming.json returned ${res.status}`);
  return res.json();
}

/**
 * Coins per hour for farming each huntable shard and selling it.
 *
 * Base rates are SkyShards' estimates with top gear in the best spot (often in a group), in
 * catches per hour. `efficiency` scales that to the player's setup; Hunter Fortune then adds
 * extra shards per catch. Prices are top of book, since an hour's haul is sold over time.
 *
 * @param {{sellMode: "instaSell"|"sellOffer", tax: number, hunterFortune: number, efficiency: number}} opts
 *   `tax` and `efficiency` are fractions.
 */
export function rankFarming(farming, shards, products, { sellMode, tax, hunterFortune, efficiency }) {
  const rows = [];
  for (const [id, info] of Object.entries(farming.shards)) {
    if (!info.rate || !shards[id]) continue;
    const product = products.get(shards[id].internal_id);
    const unit = sellPrice(product, sellMode, 1);
    if (!unit) continue;

    const catchesPerHour = info.rate * efficiency;
    const shardsPerHour = catchesPerHour * (1 + hunterFortune / 100);
    const volume = weeklyVolume(product, sellMode);
    rows.push({
      key: id,
      output: id,
      tools: info.tools,
      zones: info.zones,
      catchesPerHour,
      shardsPerHour,
      outputPrice: unit,
      // Read by the shared 7-day price check: an hour's haul, with nothing to buy.
      outputQty: shardsPerHour,
      cost: 0,
      moneyPerHour: shardsPerHour * unit * (1 - tax),
      volume,
      // One hour of farming is more than a tenth of what the market trades in a day.
      thinMarket: shardsPerHour > volume / 7 / 10,
    });
  }
  return rows;
}
