import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dist = path.join(root, "dist");
const srcDir = path.join(root, "src");
const outDir = path.join(dist, "server");

async function main() {
  // 1. Clean only the build output dirs — NOT dist/data (the crawled catalog
  //    lives there and must survive rebuilds). Wiping all of dist/ used to
  //    destroy registry.db on every build.
  await rm(path.join(dist, "server"), { recursive: true, force: true });
  await rm(path.join(dist, "crawler"), { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  // 2. esbuild bundle server.ts -> dist/server/index.cjs (cjs)
  //    .cjs extension => Node treats it as CommonJS regardless of the
  //    package.json "type" field.
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [path.join(srcDir, "server.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(outDir, "index.cjs"),
    external: ["better-sqlite3"],
    sourcemap: false,
    logLevel: "info",
  });

  // 3. Copy schema.sql next to each bundle (each finds it via its own __dirname)
  const crawlerOutDir = path.join(dist, "crawler");
  await mkdir(crawlerOutDir, { recursive: true });
  await cp(path.join(srcDir, "schema.sql"), path.join(outDir, "schema.sql"));
  await cp(path.join(srcDir, "schema.sql"), path.join(crawlerOutDir, "schema.sql"));

  // 4. Copy the base registry.db into dist/data/ if not already present.
  //    A fresh clone ships the crawled catalog as a committed asset (assets/registry.db),
  //    so setup is `npm install && npm run build` — no 15-min crawl required. If a
  //    fresh crawl already produced dist/data/registry.db, leave it untouched.
  const dataDir = path.join(dist, "data");
  const baseDb = path.join(root, "assets", "registry.db");
  const distDb = path.join(dataDir, "registry.db");
  await mkdir(dataDir, { recursive: true });
  let hasDistDb = false;
  try {
    const s = await stat(distDb);
    hasDistDb = s.isFile();
  } catch {
    hasDistDb = false;
  }
  if (!hasDistDb) {
    await cp(baseDb, distDb);
    console.log(`[build] copied base DB -> ${distDb}`);
  }

  // 5. esbuild bundle crawler.ts -> dist/crawler/index.cjs (cjs)
  await esbuild.build({
    entryPoints: [path.join(srcDir, "crawler.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(dist, "crawler", "index.cjs"),
    external: ["better-sqlite3"],
    sourcemap: false,
    logLevel: "info",
  });

  // 6. Sanity: ensure dist artifacts exist
  for (const p of [
    path.join(outDir, "index.cjs"),
    path.join(outDir, "schema.sql"),
    path.join(dist, "crawler", "index.cjs"),
    distDb,
  ]) {
    const s = await stat(p);
    if (!s.isFile()) throw new Error(`missing artifact: ${p}`);
  }

  console.log(
    "[build] done -> dist/server/index.cjs, dist/server/schema.sql, dist/crawler/index.cjs"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
