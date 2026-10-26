# Shard Fusion Flips

A small web dashboard that ranks Hypixel SkyBlock shard fusions by profit, using live Bazaar prices.

Pick how you buy the inputs (insta-buy or buy order) and how you sell the result (insta-sell or sell offer). The table recalculates every fusion pair and shows the ones that make money right now. Prices refresh automatically every 60 seconds.

**Live site:** https://squirrrell.github.io/skyblock-shard-fusions/ (chains page: [/chains.html](https://squirrrell.github.io/skyblock-shard-fusions/chains.html)). GitHub Pages redeploys it automatically on every push to `main`.

## Run it locally

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

**Crocodile / Pure Reptile:** set your Crocodile attribute level (0-10) in the toolbar. Each level gives a 2% chance to double the output of a fusion with a Reptile-family input, so those fusions use the average output `outputQty × (1 + 0.02 × level)`. Their profit is then an expected value over many fusions, and the rows get a "Reptile" tag.

Price sources from the Bazaar order book (`/v2/skyblock/bazaar`):

| Mode | Price used |
| --- | --- |
| Insta-buy | Lowest sell offer (top of `buy_summary`) |
| Buy order | Highest buy order (top of `sell_summary`) |
| Insta-sell | Highest buy order (top of `sell_summary`) |
| Sell offer | Lowest sell offer (top of `buy_summary`) |

**Inflated price warning:** each output's current price is compared with its 7-day median from Coflnet, on the same side of the book as the sell mode (insta-sell price or lowest sell offer). If it's above the median by the chosen threshold (15%, 25% by default, or 50%), the row gets a red "+X% vs 7d" tag, its profit is struck through, and the detail view shows what the fusion would make at the median price. You can hide flagged fusions entirely, and the "most profitable" card always skips them.

A 7-day median was chosen over 3 days because someone would have to hold an inflated price for more than 3.5 days to move it, while a 1-2 day pump can drag a 3-day window along with it. Only outputs are checked: an inflated input price just makes a fusion look worse, never better. History is fetched only for the shards on screen (3 requests at a time, to respect Coflnet's rate limit) and cached in the browser for an hour.

Bazaar tax defaults to 1.25% and can be changed in the toolbar. Weekly volume is shown so you can skip shards that barely trade.

Not modelled: order-book depth beyond one fusion's worth of shards, and Hunting XP gained from fusing.

## Chains page

`chains.html` (the "Chains" tab) ranks shards you can make by feeding one fusion's output into the next instead of selling it, for example buying Flaming Spider and Shinyfish, fusing them into Sun Fish, then fusing Sun Fish into Galaxy Fish.

- For every shard it finds the cheapest route of up to 2, 3 or 4 stacked fusion steps (you choose). Each step's inputs are either bought or made by a shorter route, whichever is cheaper.
- One **batch** is a single run of the final fusion. The page works out whole fusions for every step below it, the shopping list, and any spare shards left over from rounding up (counted as sold).
- Columns show profit per batch, profit per fusion (useful for long chains that take many fusions), the number of steps and fusions, and the return on cost. Expand a row to see the route as a tree and the fusions in the order you'd do them.
- By default only real chains (2+ steps) are listed, since single fusions are on the main page. The buy/sell modes, tax, Crocodile level and the inflated-price warning are shared with the main page.
- Chains use top-of-book prices (lowest offer or highest order) rather than walking the order book, because chain quantities vary by route.

## Farming page

`farming.html` (the "Farming" tab) ranks the shards worth hunting yourself and selling, in coins per hour, for each hunting tool:

- **Huntaxe + Black Hole** for Combat mobs (e.g. Glacite Walker, Miner Zombie, Zealot)
- **Lasso** for Forest mobs (e.g. Thyst, Bunbun, Phanpyre)
- **Fishing Net** for Water mobs (e.g. Verdant, Coralot, Salmon)

Each tool gets a card with its best shard and the runners-up; click one to filter the table. Every row shows the estimated catches per hour, where the mob spawns, the shard price and coins per hour, and the detail view explains how to catch it.

How the estimate works: `coins/h = catches/h × your speed × (1 + Hunter Fortune / 100) × price × (1 − tax)`.

- **Catches per hour** come from SkyShards' rates, which assume top gear in the best spot and often a group. They're best-case numbers, so use **Your speed** (100/75/50/25%) to scale them to your setup.
- **Hunter Fortune** adds extra shards per catch; include pet and attribute bonuses in the number you enter.
- A **Thin market** tag means one hour of farming is more than a tenth of what that shard trades in a day, so selling it all would likely drop the price.
- The inflated-price warning works here too, and the tool cards skip flagged shards.

The tool and location data lives in `data/farming.json`. Rebuild it when new shards are added:

```bash
node scripts/build-farming-data.mjs
```

It reads each shard's "Hunting" and "Huntraps" sections from the Hypixel SkyBlock Wiki (falling back to the mob's spawn location) and SkyShards' `rates.json`.

## Data sources

- **Prices:** [Hypixel Bazaar API](https://api.hypixel.net/v2/skyblock/bazaar), no API key needed.
- **Fusion recipes:** [SkyShards](https://github.com/Campionnn/SkyShards) `fusion-data.json` by Campion, MIT licensed. The app fetches the latest version on load and falls back to the snapshot in `data/fusion-data.json`. License text is in `data/SKYSHARDS_LICENSE`.
- **7-day price history:** [Coflnet](https://sky.coflnet.com) `/api/bazaar/{item}/history/week`, no API key needed.
- **Farming rates:** SkyShards `rates.json` (MIT). **Hunting tools and spawn locations:** [Hypixel SkyBlock Wiki](https://hypixelskyblock.minecraft.wiki/w/Hunting) (CC BY-NC-SA 3.0), extracted into `data/farming.json`.
- **Shard icons:** loaded from the SkyShards repository.
