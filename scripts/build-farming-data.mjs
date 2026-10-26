// Builds data/farming.json: which hunting tool catches each shard, where it spawns, and
// SkyShards' shards-per-hour estimate. Run with `node scripts/build-farming-data.mjs`
// from the repo root whenever new shards are added to the game.
//
// Sources:
// - Tool and location: the "Hunting" and "Huntraps" sections of each shard's page on the
//   official Hypixel SkyBlock Wiki (hypixelskyblock.minecraft.wiki, CC BY-NC-SA 3.0).
// - Rate: SkyShards' rates.json (MIT), measured "with hyper-max gear and farming in the most
//   optimal way possible", in shards per hour before Hunter Fortune.
import { readFile, writeFile } from "node:fs/promises";

const WIKI_API = "https://hypixelskyblock.minecraft.wiki/api.php";
const RATES_URL = "https://raw.githubusercontent.com/Campionnn/SkyShards/master/public/rates.json";
const USER_AGENT = "shard-fusion-flips/1.0 (https://github.com/Squirrrell/skyblock-shard-fusions)";
const BATCH = 50;

const TOOLS = {
  "Black Hole": "blackHole",
  "Pocket Black Hole": "blackHole",
  Lasso: "lasso",
  "Fishing Net": "net",
};

const { shards } = JSON.parse(await readFile("data/fusion-data.json", "utf8"));
const rates = await (await fetch(RATES_URL)).json();

const titleOf = (id) => `${shards[id].name} Shard`;
const ids = Object.keys(shards);

/** Fetches wiki pages' wikitext in batches, keyed by the title that was asked for. */
async function fetchPages(allTitles) {
  const pages = new Map();
  for (let i = 0; i < allTitles.length; i += BATCH) {
    await fetchBatch(allTitles.slice(i, i + BATCH), pages);
    // Be polite to the wiki.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return pages;
}

async function fetchBatch(titles, pages) {
  const params = new URLSearchParams({
    action: "query",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    redirects: "1",
    format: "json",
    formatversion: "2",
    titles: titles.join("|"),
  });
  const res = await fetch(`${WIKI_API}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  const body = await res.json();
  // Map redirected/normalized titles back to the title we asked for.
  const alias = new Map();
  for (const n of body.query.normalized ?? []) alias.set(n.to, n.from);
  for (const r of body.query.redirects ?? []) alias.set(r.to, alias.get(r.from) ?? r.from);
  for (const page of body.query.pages) {
    const text = page.revisions?.[0]?.slots?.main?.content;
    if (text) pages.set(alias.get(page.title) ?? page.title, text);
  }
}

const pages = await fetchPages(ids.map(titleOf));

/** Body of a "=== Name ===" section, up to the next heading. */
function section(text, name) {
  const match = text.match(new RegExp(`===\\s*${name}\\s*===\\n([\\s\\S]*?)(?=\\n==)`));
  return match ? match[1] : "";
}

const out = {};
let missing = 0;
for (const id of ids) {
  const text = pages.get(titleOf(id));
  if (!text) {
    missing++;
    continue;
  }
  const hunting = section(text, "Hunting");
  const tools = [...new Set([...hunting.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => TOOLS[m[1]]).filter(Boolean))];
  if (tools.length === 0) continue;
  const zones = [...new Set([...section(text, "Huntraps").matchAll(/\{\{Zone\|([^}|]+)/g)].map((m) => m[1].trim()))];
  out[id] = {
    tools,
    zones,
    // Hunting this mob through Charm (e.g. Salt) is also possible but much slower; not ranked.
    rate: rates[id] ?? 0,
  };
}

// Shards with no huntrap zones: fall back to where the mob spawns, from its own page's infobox.
const zoneless = Object.keys(out).filter((id) => out[id].zones.length === 0);
const mobPages = await fetchPages(zoneless.map((id) => shards[id].name));
for (const id of zoneless) {
  const text = mobPages.get(shards[id].name) ?? "";
  const fromInfobox = [...text.matchAll(/\|spawn_location\d*\s*=\s*([^\n]+)/g)].flatMap((m) =>
    [...m[1].matchAll(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|\{\{Zone\|([^}|]+)/gi)].map((z) => (z[2] || z[1] || z[3]).trim()),
  );
  out[id].zones = [...new Set(fromInfobox)].slice(0, 4);
}

await writeFile(
  "data/farming.json",
  `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), shards: out }, null, 2)}\n`,
);
const counts = Object.values(out).reduce((acc, s) => {
  for (const t of s.tools) acc[t] = (acc[t] || 0) + 1;
  return acc;
}, {});
console.log(`Wrote ${Object.keys(out).length} huntable shards`, counts, `(${missing} wiki pages not found)`);
