import { buyPrice, sellPrice, weeklyVolume } from "./bazaar.js";
import { crocodileMultiplier } from "./fusions.js";

/**
 * Finds, for every shard, the cheapest way to make it through chained fusions (feeding one
 * fusion's output into the next instead of selling it), and how much selling it then earns.
 *
 * Costs come from a layered relaxation: layer k holds the cheapest unit cost of each shard
 * using at most k fusion steps, where every input costs its layer k-1 price. Layer 0 is just
 * buying. Keeping every layer lets a tree be expanded with an exact depth budget.
 *
 * Unit prices are top of book (lowest offer or highest order), since chain quantities make
 * walking the order book per route impractical.
 *
 * @returns rows for every shard whose best route is a fusion and turns a profit, one batch
 *   being a single run of the final fusion.
 */
export function solveChains({ shards, pairs }, products, { buyMode, sellMode, tax, crocodileLevel = 0, maxDepth = 3 }) {
  const ids = Object.keys(shards);
  const productOf = (id) => products.get(shards[id].internal_id);
  const unitBuy = new Map(ids.map((id) => [id, buyPrice(productOf(id), buyMode, 1) ?? Infinity]));
  const unitSell = (id, amount) => sellPrice(productOf(id), sellMode, Math.max(1, Math.ceil(amount))) ?? 0;
  const reptileMultiplier = crocodileMultiplier(crocodileLevel);

  const buyLayer = new Map(ids.map((id) => [id, { cost: unitBuy.get(id), recipe: null }]));
  const layers = [buyLayer];
  for (let k = 1; k <= maxDepth; k++) {
    const prev = layers[k - 1];
    const next = new Map(buyLayer);
    for (const pair of pairs) {
      const costA = prev.get(pair.a).cost;
      const costB = prev.get(pair.b).cost;
      if (!Number.isFinite(costA) || !Number.isFinite(costB)) continue;
      const fa = shards[pair.a].fuse_amount;
      const fb = shards[pair.b].fuse_amount;
      const inputCost = fa * costA + fb * costB;
      const multiplier = pair.isReptile ? reptileMultiplier : 1;
      for (const { id, qty } of pair.outputs) {
        const qtyEff = qty * multiplier;
        const unit = inputCost / qtyEff;
        if (unit < next.get(id).cost * (1 - 1e-9)) {
          next.set(id, { cost: unit, recipe: { a: pair.a, b: pair.b, fa, fb, qty, qtyEff, isReptile: pair.isReptile } });
        }
      }
    }
    layers.push(next);
  }

  // Turns the layered routes into a concrete tree for `need` shards, crafting whole fusions.
  const expand = (id, need, budget) => {
    const recipe = budget > 0 ? layers[budget].get(id).recipe : null;
    if (!recipe) return { id, need, buy: true, unit: unitBuy.get(id) };
    const crafts = Math.ceil(need / recipe.qtyEff - 1e-9);
    const children =
      recipe.a === recipe.b
        ? [expand(recipe.a, crafts * (recipe.fa + recipe.fb), budget - 1)]
        : [expand(recipe.a, crafts * recipe.fa, budget - 1), expand(recipe.b, crafts * recipe.fb, budget - 1)];
    return { id, need, crafts, made: crafts * recipe.qtyEff, recipe, children };
  };

  const rows = [];
  for (const id of ids) {
    const top = layers[maxDepth].get(id);
    if (!top.recipe || !productOf(id)) continue;

    const tree = expand(id, top.recipe.qtyEff, maxDepth);
    const shopping = new Map();
    const leftovers = new Map();
    let fusions = 0;
    let depth = 0;
    const walk = (node, level, isRoot) => {
      if (node.buy) {
        shopping.set(node.id, (shopping.get(node.id) || 0) + node.need);
        return;
      }
      fusions += node.crafts;
      depth = Math.max(depth, level);
      const extra = node.made - node.need;
      if (!isRoot && extra > 1e-9) leftovers.set(node.id, (leftovers.get(node.id) || 0) + extra);
      for (const child of node.children) walk(child, level + 1, false);
    };
    walk(tree, 1, true);

    let cost = 0;
    for (const [shardId, qty] of shopping) cost += qty * unitBuy.get(shardId);
    const outputPrice = unitSell(id, tree.made);
    if (!outputPrice) continue;
    // Whole crafts can overshoot what the next step needs; those spares are counted as sold.
    let leftoverValue = 0;
    for (const [shardId, qty] of leftovers) leftoverValue += qty * unitSell(shardId, qty) * (1 - tax);
    const revenue = tree.made * outputPrice * (1 - tax) + leftoverValue;
    const profit = revenue - cost;
    if (profit <= 0) continue;

    rows.push({
      key: id,
      output: id,
      tree,
      depth,
      fusions,
      shopping,
      leftovers,
      leftoverValue,
      cost,
      outputPrice,
      outputQty: tree.made,
      revenue,
      profit,
      profitPerFusion: profit / fusions,
      roi: profit / cost,
      volume: Math.min(
        weeklyVolume(productOf(id), sellMode),
        ...[...shopping.keys()].map((shardId) => weeklyVolume(productOf(shardId), buyMode)),
      ),
    });
  }
  return rows;
}
