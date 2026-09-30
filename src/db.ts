import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
// In the esbuild CJS bundle, __dirname is a built-in global pointing at the
// bundle's directory (dist/server or dist/crawler). schema.sql is copied next
// to each bundle at build time; data/ lives one level up (dist/data).
const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "registry.db");
const SCHEMA_PATH = path.resolve(__dirname, "schema.sql");

// Instance types derived from the better-sqlite3 class to avoid using the
// imported binding directly as a type under Node16 ESM resolution.
type DB = InstanceType<typeof Database>;
type Stmt = ReturnType<DB["prepare"]>;

let _db: DB | null = null;
let _insertStmt: Stmt | null = null;

/** Open (or return) the singleton SQLite connection. Creates data/ + applies schema. */
export function getDb(): DB {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _insertStmt = null;
    _db.close();
    _db = null;
  }
}

export interface ComponentRecord {
  id: string;
  name: string;
  author: string;
  slug: string;
  category: string | null;
  description: string | null;
  dependencies: string; // JSON stringified array of npm packages
  registry_dependencies: string; // JSON stringified array of other shadcn components
  files: string; // JSON stringified array of { name, content, type }
  tailwind_config: string; // JSON stringified custom tailwind rules if present
  css_vars: string; // JSON stringified CSS variables if present
  raw_json: string;
  created_at?: string; // defaulted by SQLite (CURRENT_TIMESTAMP)
}

export interface ComponentSummary {
  id: string;
  name: string;
  author: string;
  category: string | null;
  description: string | null;
  rank: number;
}

function getInsertStmt(): Stmt {
  if (!_insertStmt) {
    const db = getDb();
    _insertStmt = db.prepare(
      `INSERT OR REPLACE INTO components (
         id, name, author, slug, category, description,
         dependencies, registry_dependencies, files, tailwind_config, css_vars, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }
  return _insertStmt;
}

/** Insert (or upsert) one component record. FTS stays in sync via triggers. */
export function insertComponent(comp: ComponentRecord): void {
  getInsertStmt().run([
    comp.id,
    comp.name,
    comp.author,
    comp.slug,
    comp.category,
    comp.description,
    comp.dependencies,
    comp.registry_dependencies,
    comp.files,
    comp.tailwind_config,
    comp.css_vars,
    comp.raw_json
  ]);
}

/** Sanitize a raw user query into prefix-matched FTS5 terms (handles plurals/inflections). */
function sanitizeTokens(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => '"' + t.replace(/"/g, '""') + '"*');
}

/**
 * Full-text search over the FTS5 index. Returns best matches by rank.
 * Tries an AND of prefix terms first (precise); if that yields nothing and the
 * query has >1 term, falls back to OR so a natural-language query still recalls.
 */
export function searchComponents(query: string, limit = 8): ComponentSummary[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const tokens = sanitizeTokens(query);
  if (tokens.length === 0) return [];
  const stmt = db.prepare(
    `SELECT c.id, c.name, c.author, c.category, c.description, f.rank AS rank
     FROM components_fts f
     JOIN components c ON c.rowid = f.rowid
     WHERE components_fts MATCH ?
     ORDER BY f.rank
     LIMIT ?`
  );
  const andQuery = tokens.join(" ");
  let rows = stmt.all(andQuery, safeLimit) as ComponentSummary[];
  if (rows.length === 0 && tokens.length > 1) {
    rows = stmt.all(tokens.join(" OR "), safeLimit) as ComponentSummary[];
  }
  return rows;
}

/** Fetch the full record for one component by its "author/slug" id. */
export function getComponentById(id: string): ComponentRecord | null {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM components WHERE id = ?`);
  const row = stmt.get(id) as ComponentRecord | undefined;
  return row ?? null;
}

/** Total indexed components (for reporting/verification). */
export function countComponents(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM components`).get() as { n: number };
  return row.n;
}

// --- Theme extraction & synthesis ------------------------------------------
// The registry's css_vars / tailwind_config columns are currently empty for all
// records (403-gated partial hydration). These helpers make get_theme useful
// with metadata-only data AND future-proof: if the crawler later captures real
// shadcn cssVars, parseStoredCssVars returns them automatically.

export interface ThemeTokens {
  background: string;
  foreground: string;
  primary: string;
  accent: string;
  radius: string;
  darkBackground: string;
  darkForeground: string;
}

interface CuratedPalette {
  name: string;
  keywords: string[];
  tokens: ThemeTokens;
}

/** Curated, copy-pasteable palettes keyed by aesthetic keywords. */
const CURATED_PALETTES: CuratedPalette[] = [
  {
    name: "neon",
    keywords: ["neon", "cyber", "glow", "electric", "synth", "vaporwave", "arcade"],
    tokens: { background: "#0a0a0a", foreground: "#e5e5e5", primary: "#22d3ee", accent: "#a855f7", radius: "0.25rem", darkBackground: "#0a0a0a", darkForeground: "#e5e5e5" },
  },
  {
    name: "sunset",
    keywords: ["sunset", "warm", "ember", "amber", "fire", "orange", "copper"],
    tokens: { background: "#fffbeb", foreground: "#1c1917", primary: "#f59e0b", accent: "#ef4444", radius: "0.5rem", darkBackground: "#1c1917", darkForeground: "#fafaf9" },
  },
  {
    name: "ocean",
    keywords: ["ocean", "aqua", "teal", "cool", "blue", "sky", "water"],
    tokens: { background: "#f0f9ff", foreground: "#0c4a6e", primary: "#0284c7", accent: "#14b8a6", radius: "0.5rem", darkBackground: "#082f49", darkForeground: "#e0f2fe" },
  },
  {
    name: "forest",
    keywords: ["forest", "green", "nature", "emerald", "moss", "earth"],
    tokens: { background: "#f0fdf4", foreground: "#14532d", primary: "#16a34a", accent: "#84cc16", radius: "0.5rem", darkBackground: "#052e16", darkForeground: "#dcfce7" },
  },
  {
    name: "royal",
    keywords: ["royal", "violet", "purple", "luxury", "premium", "regal"],
    tokens: { background: "#faf5ff", foreground: "#4c1d95", primary: "#7c3aed", accent: "#db2777", radius: "0.5rem", darkBackground: "#2e1065", darkForeground: "#f5f3ff" },
  },
  {
    name: "mono",
    keywords: ["mono", "monochrome", "grayscale", "black", "greyscale"],
    tokens: { background: "#ffffff", foreground: "#000000", primary: "#171717", accent: "#525252", radius: "0.25rem", darkBackground: "#0a0a0a", darkForeground: "#fafafa" },
  },
  {
    name: "dark",
    keywords: ["dark", "midnight", "noir", "slate", "night"],
    tokens: { background: "#09090b", foreground: "#f4f4f5", primary: "#fafafa", accent: "#818cf8", radius: "0.5rem", darkBackground: "#09090b", darkForeground: "#f4f4f5" },
  },
];

const DEFAULT_PALETTE: CuratedPalette = {
  name: "default",
  keywords: ["default", "minimal", "clean", "neutral", "zinc", "shadcn", "light", "simple"],
  tokens: { background: "#ffffff", foreground: "#09090b", primary: "#18181b", accent: "#6366f1", radius: "0.5rem", darkBackground: "#09090b", darkForeground: "#fafafa" },
};

/** Pick the best curated palette for a free-text aesthetic query. Falls back to default. */
export function matchPalette(query: string): { name: string; tokens: ThemeTokens } {
  const q = (query || "").toLowerCase();
  for (const p of [...CURATED_PALETTES, DEFAULT_PALETTE]) {
    if (p.keywords.some((k) => q.includes(k))) return { name: p.name, tokens: p.tokens };
  }
  return { name: DEFAULT_PALETTE.name, tokens: DEFAULT_PALETTE.tokens };
}

/**
 * Parse a stored css_vars JSON object into ThemeTokens (best-effort). Returns null
 * when the field is empty/unparseable. Future-proofs get_theme: if the crawler
 * later captures real shadcn cssVars (flat map of hex values), these are returned.
 */
export function parseStoredCssVars(cssVarsJson: string | null): ThemeTokens | null {
  if (!cssVarsJson) return null;
  const s = cssVarsJson.trim();
  if (!s || s === "null" || s === "{}") return null;
  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    const pick = (v: unknown): string | null =>
      typeof v === "string"
        ? v
        : v && typeof v === "object" && typeof (v as { DEFAULT?: unknown }).DEFAULT === "string"
          ? (v as { DEFAULT: string }).DEFAULT
          : null;
    const background = pick(obj.background);
    const foreground = pick(obj.foreground);
    const primary = pick(obj.primary);
    const accent = pick(obj.accent ?? obj.secondary);
    const radius = typeof obj.radius === "string" ? (obj.radius as string) : null;
    if (!background && !foreground && !primary) return null;
    return {
      background: background ?? "#ffffff",
      foreground: foreground ?? "#09090b",
      primary: primary ?? "#18181b",
      accent: accent ?? "#6366f1",
      radius: radius ?? "0.5rem",
      darkBackground: pick(obj["dark-background"] ?? obj.darkBackground) ?? "#09090b",
      darkForeground: pick(obj["dark-foreground"] ?? obj.darkForeground) ?? "#fafafa",
    };
  } catch {
    return null;
  }
}
