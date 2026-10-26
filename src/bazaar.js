// Hypixel Bazaar API client. No API key is needed for this endpoint and it sends
// `Access-Control-Allow-Origin: *`, so it can be called straight from the browser.
const BAZAAR_URL = "https://api.hypixel.net/v2/skyblock/bazaar";

/**
 * Bazaar naming is from the seller's point of view, which trips everyone up:
 * - `buy_summary`  = sell offers, ascending. Its top is what you pay to insta-buy.
 * - `sell_summary` = buy orders, descending. Its top is what you get to insta-sell.
 */
export async function fetchBazaar() {
  const res = await fetch(BAZAAR_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bazaar API returned ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error(body.cause || "Bazaar API request failed");

  const products = new Map();
  for (const [id, product] of Object.entries(body.products)) {
    // Only shards are relevant here; skipping the other ~1900 products keeps refreshes cheap.
    if (!id.startsWith("SHARD_")) continue;
    const qs = product.quick_status;
    products.set(id, {
      sellOffers: product.buy_summary,
      buyOrders: product.sell_summary,
      lowestOffer: product.buy_summary[0]?.pricePerUnit ?? null,
      highestOrder: product.sell_summary[0]?.pricePerUnit ?? null,
      instaBoughtWeek: qs.buyMovingWeek,
      instaSoldWeek: qs.sellMovingWeek,
    });
  }
  return { lastUpdated: body.lastUpdated, products };
}

/**
 * Average unit price to fill `amount` units against the given book levels, or null
 * when the visible book (top 30 levels) can't fill it.
 */
export function fillPrice(levels, amount) {
  let remaining = amount;
  let total = 0;
  for (const level of levels) {
    const take = Math.min(remaining, level.amount);
    total += take * level.pricePerUnit;
    remaining -= take;
    if (remaining === 0) return total / amount;
  }
  return null;
}

/** Unit price for acquiring `amount` of a product. Insta-buy walks the sell offers; a buy order sits at the top order. */
export function buyPrice(product, mode, amount) {
  if (!product) return null;
  return mode === "instaBuy" ? fillPrice(product.sellOffers, amount) : product.highestOrder;
}

/** Unit price for selling `amount` of a product. Insta-sell walks the buy orders; a sell offer sits at the lowest offer. */
export function sellPrice(product, mode, amount) {
  if (!product) return null;
  return mode === "instaSell" ? fillPrice(product.buyOrders, amount) : product.lowestOffer;
}

/** Weekly volume on the side of the book a given mode trades against. */
export function weeklyVolume(product, mode) {
  if (!product) return 0;
  // Insta-buying and sell offers both depend on people buying from offers;
  // insta-selling and buy orders both depend on people selling into orders.
  return mode === "instaBuy" || mode === "sellOffer" ? product.instaBoughtWeek : product.instaSoldWeek;
}
