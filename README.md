# Shard Fusion Flips

A small web dashboard that ranks Hypixel SkyBlock shard fusions by profit, using live Bazaar prices.

Pick how you buy the inputs (insta-buy or buy order) and how you sell the result (insta-sell or sell offer). The table recalculates every fusion pair and shows the ones that make money right now. Prices refresh automatically every 60 seconds.

## Run it

It's a static site with no build step. Serve the folder with any static server:

```bash
npx serve .
```

or

```bash
python -m http.server 8080
```

Then open the printed URL (e.g. http://localhost:8080). Opening `index.html` directly from disk also works, as long as the live fusion data can be fetched from GitHub.

## How profit is calculated

For every fusion pair `A + B`:

- **Cost** = `fuse_amount(A) × buyPrice(A) + fuse_amount(B) × buyPrice(B)`
  - `fuse_amount` is 5 for most shards, 2 for Reptile, Amphibian and Elemental shards, 1 for Chameleon.
- **Revenue** = `outputQty × sellPrice(output) × (1 − bazaar tax)`
  - A fusion offers up to three outputs and you pick one, so the dashboard uses the most valuable one.
  - Special fusions give 2 of the output, the rest give 1.
- **Profit** = Revenue − Cost

Price sources from the Bazaar order book (`/v2/skyblock/bazaar`):

| Mode | Price used |
| --- | --- |
| Insta-buy | Lowest sell offer (top of `buy_summary`) |
| Buy order | Highest buy order (top of `sell_summary`) |
| Insta-sell | Highest buy order (top of `sell_summary`) |
| Sell offer | Lowest sell offer (top of `buy_summary`) |

Bazaar tax defaults to 1.25% and can be changed in the toolbar. Weekly volume is shown so you can skip shards that barely trade.

Not modelled: the Pure Reptile / Crocodile chance to double reptile outputs, order-book depth when buying in bulk, and Hunting XP gained from fusing.

## Data sources

- **Prices:** [Hypixel Bazaar API](https://api.hypixel.net/v2/skyblock/bazaar), no API key needed.
- **Fusion recipes:** [SkyShards](https://github.com/Campionnn/SkyShards) `fusion-data.json` by Campion, MIT licensed. The app fetches the latest version on load and falls back to the snapshot in `data/fusion-data.json`. License text is in `data/SKYSHARDS_LICENSE`.
- **Shard icons:** loaded from the SkyShards repository.
