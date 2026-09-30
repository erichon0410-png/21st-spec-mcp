import { getDb, insertComponent, countComponents, closeDb, type ComponentRecord } from "./db.js";

const BASE = "https://21st.dev";
const UA = "free-design-registry/1.0 (+local MCP registry; contact: local)";

interface DiscoveryItem {
  author: string;
  slug: string;
  category?: string;
}

interface CrawlerArgs {
  limit: number; // Infinity for full crawl
  concurrency: number;
  delay: number; // base ms jitter
  dryRun: boolean;
}

function parseArgs(argv: string[]): CrawlerArgs {
  const args: CrawlerArgs = { limit: Infinity, concurrency: 5, delay: 50, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--delay") args.delay = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": UA, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Fetch a URL returning status + body without throwing on 4xx (for hydration). */
async function fetchStatus(url: string, timeoutMs = 15000): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": UA, Accept: "*/*" },
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** Parse a sitemap (or index) into direct URLs and sub-sitemap URLs via regex. */
function parseSitemap(xml: string): { urls: string[]; subSitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].trim());
  if (/<sitemapindex/i.test(xml)) return { urls: [], subSitemaps: locs };
  return { urls: locs, subSitemaps: [] };
}

/**
 * Extract {author, slug, category} from a 21st.dev component URL.
 * Only `@author/...` URLs are unambiguous component pages; `/community/...`
 * URLs mix real components with listing/navigation pages (e.g.
 * /community/components/newest) and are rejected to avoid false positives.
 * Every real component also has an @author page, so nothing is lost.
 */
function parseComponentUrl(url: string): DiscoveryItem | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "21st.dev") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("@")) {
      const author = parts[0].slice(1);
      const category = parts[1];
      const slug = parts.slice(2).join("/");
      if (!author || !slug) return null;
      return { author, slug, category };
    }
    return null;
  } catch {
    return null;
  }
}

async function discoverFromSitemap(): Promise<DiscoveryItem[]> {
  const items: DiscoveryItem[] = [];
  let xml: string;
  try {
    xml = await fetchText(`${BASE}/sitemap.xml`);
  } catch (e) {
    console.log(`[Discovery] sitemap.xml unavailable: ${e}`);
    return items;
  }
  const { urls, subSitemaps } = parseSitemap(xml);
  const allUrls = [...urls];
  if (subSitemaps.length > 0) {
    console.log(`[Discovery] sitemap index with ${subSitemaps.length} sub-sitemaps; fetching...`);
    for (const sub of subSitemaps) {
      try {
        const subXml = await fetchText(sub);
        allUrls.push(...parseSitemap(subXml).urls);
      } catch (e) {
        console.log(`[Discovery] sub-sitemap ${sub} failed: ${e}`);
      }
    }
  }
  for (const url of allUrls) {
    const parsed = parseComponentUrl(url);
    if (parsed) items.push(parsed);
  }
  return items;
}

/** Last-resort curated seed list (hydration skips any that 404). */
const SEED_ITEMS: DiscoveryItem[] = [
  { author: "magicui", slug: "bento-grid" },
  { author: "magicui", slug: "marquee" },
  { author: "aceternity", slug: "spotlight-card" },
  { author: "shadcn", slug: "button" },
  { author: "shadcn", slug: "card" },
];

function buildRecord(item: DiscoveryItem, payload: any): ComponentRecord {
  return {
    id: `${item.author}/${item.slug}`,
    name: payload?.name || item.slug,
    author: payload?.author || item.author,
    slug: item.slug,
    category: item.category ?? null,
    description: payload?.description ?? null,
    dependencies: JSON.stringify(payload?.dependencies ?? []),
    registry_dependencies: JSON.stringify(payload?.registryDependencies ?? []),
    files: JSON.stringify(payload?.files ?? []),
    tailwind_config: JSON.stringify(payload?.tailwind ?? {}),
    css_vars: JSON.stringify(payload?.cssVars ?? {}),
    raw_json: JSON.stringify(payload ?? {}),
  };
}

/**
 * Hydrate one component. The /r/ endpoint now returns 403 "authentication
 * required" for full data, but the 403 body still carries component metadata
 * (name/description/author) — enough to populate the FTS-indexable fields.
 */
async function hydrateItem(item: DiscoveryItem): Promise<"ok" | "partial" | "skip" | "fail"> {
  const url = `${BASE}/r/${item.author}/${item.slug}`;
  try {
    const { status, text } = await fetchStatus(url);
    if (status === 200) {
      const payload = JSON.parse(text);
      insertComponent(buildRecord(item, payload));
      return "ok";
    }
    if (status === 403) {
      try {
        const body = JSON.parse(text);
        const comp = body?.component;
        if (comp && typeof comp.name === "string") {
          insertComponent(buildRecord(item, comp));
          return "partial";
        }
      } catch {
        /* not JSON */
      }
    }
    if (status === 404) return "skip";
    return "fail";
  } catch (e) {
    if (String(e).includes("HTTP 404")) return "skip";
    return "fail";
  }
}

/** Simple concurrency limiter (no external dependency). */
async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[Crawler] starting (limit=${args.limit}, concurrency=${args.concurrency}, delay=${args.delay}ms, dryRun=${args.dryRun})`
  );

  // --- Discovery ---
  let items = await discoverFromSitemap();
  let source = "sitemap";
  if (items.length === 0) {
    console.log(`[Discovery] sitemap yielded no items; using seed list...`);
    items = SEED_ITEMS;
    source = "seed";
  }

  // Deduplicate by author/slug.
  const seen = new Set<string>();
  const queue: DiscoveryItem[] = [];
  for (const it of items) {
    const key = `${it.author}/${it.slug}`;
    if (!seen.has(key)) {
      seen.add(key);
      queue.push(it);
    }
  }
  console.log(`[Discovery] source=${source}; ${queue.length} unique items to hydrate.`);

  if (args.dryRun) {
    console.log(
      `[Dry-run] first 20: ` + queue.slice(0, 20).map((i) => `${i.author}/${i.slug}`).join(", ")
    );
    return;
  }

  // --- Hydration ---
  const toHydrate = Number.isFinite(args.limit) ? queue.slice(0, args.limit) : queue;
  console.log(`[Hydration] hydrating ${toHydrate.length} items...`);

  let done = 0;
  let ok = 0;
  let partial = 0;
  let skipped = 0;
  let failed = 0;
  const total = toHydrate.length;

  await runWithConcurrency(toHydrate, args.concurrency, async (item) => {
    await sleep(args.delay + Math.random() * args.delay); // ~50ms jitter
    const result = await hydrateItem(item);
    if (result === "ok") ok++;
    else if (result === "partial") partial++;
    else if (result === "skip") skipped++;
    else failed++;
    done++;
    if (done % 25 === 0 || done === total) {
      console.log(`[Hydrated ${done}/${total}] ${item.author}/${item.slug}`);
    }
  });

  // --- Final FTS index rebuild (safety net; triggers already keep it in sync).
  // Uses plain SQL because this SQLite build does not support the FTS5
  // 'rebuild' special command. ---
  const db = getDb();
  db.exec(`
    DELETE FROM components_fts;
    INSERT INTO components_fts(rowid, id, name, author, description)
    SELECT rowid, id, name, author, description FROM components;
  `);

  console.log(
    `[Crawler] done. ok=${ok} partial=${partial} skipped(404)=${skipped} failed=${failed} total_in_db=${countComponents()}`
  );
  closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
