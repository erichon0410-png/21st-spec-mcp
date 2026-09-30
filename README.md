# free-design-registry

A standalone, fully-local MCP design registry of 21st-style shadcn components. It scrapes the
public `21st.dev` registry into a local SQLite database (FTS5 full-text search) and serves the
components over MCP on stdio — **no third-party MCP paywall, no API keys, no rate limits.**

## What it does

- **Crawler** (`src/crawler.ts`) discovers public component URLs from `21st.dev`'s sitemap,
  hydrates each via `https://21st.dev/r/{author}/{slug}`, and stores the payload in SQLite.
  Idempotent (`INSERT OR REPLACE` by id) — re-running refreshes existing rows.
- **Database** (`src/db.ts`, `src/schema.sql`) — a `components` table plus an FTS5 non-external
  virtual table kept in sync by plain-SQL triggers, with a final rebuild after each crawl.
- **MCP server** (`src/server.ts`) exposes five tools over stdio:
  - `search_designs(query, limit?)` — full-text search ranked by relevance.
  - `inspect_component(id)` — full record for one `author/slug` component.
  - `get_build_prompt(id | query)` — a detailed, reusable build-prompt scaffold for a component.
  - `install_component(id)` — the component's file list + install steps.
  - `get_theme(identifier, mode?)` — design tokens (CSS variables and/or Tailwind config) for an
    aesthetic keyword (`"neon"`, `"minimal"`, `"sunset"`) or a component id. Curated/inferred:
    the registry stores metadata only, not raw theme tokens, so output is clearly labeled.

Component ids are `"author/slug"`.

## Requirements

- Node.js >= 20 (tested on 22). npm.
- **No API keys.** The crawler talks to the public `21st.dev` endpoints directly.

## Setup (rebuild from scratch)

```bash
npm install        # installs better-sqlite3 (prebuilt binary) + deps
npm run build      # esbuild CJS bundle -> dist/server/index.cjs, dist/crawler/index.cjs (+ copies schema.sql)
npm run crawl      # populates the catalog (~15 min; idempotent). Flags below.
```

### Crawl flags

`--limit <n>` (default: all), `--concurrency <n>` (default 5), `--delay <ms>` (default 50, jittered),
`--dry-run`. Useful smoke test: `npm run crawl -- --limit 25`.

> **Note on the catalog:** `21st.dev`'s detail endpoint is 403-gated for anonymous hydration, so
> records are *partial* (name / author / description; no raw CSS tokens or file contents). That's
> by design — the value is the searchable metadata + build prompts + curated theme scaffolds, not
> the source files. `get_theme` output is therefore clearly labeled as curated/inferred.

## Run the MCP server

```bash
node dist/server/index.cjs     # or: npm start  /  npm run mcp
npm run dev                    # dev mode (runs src/server.ts directly, no build needed)
```

The server speaks MCP over stdio; it logs to stderr, stdout is reserved for the protocol.

### MCP client config

Point any MCP client (Claude Code, Cursor, Windsurf, OpenCode, etc.) at it:

```json
{
  "mcpServers": {
    "free-designs": {
      "command": "node",
      "args": ["<ABS_PATH_TO_THIS_DIR>/dist/server/index.cjs"]
    }
  }
}
```

## Verify

```bash
# row count (expect ~7,000)
node -e "const db=require('better-sqlite3')('dist/data/registry.db');console.log(db.prepare('SELECT COUNT(*) c FROM components').get().c)"
# FTS search
node -e "const db=require('better-sqlite3')('dist/data/registry.db',{readonly:true});console.log(db.prepare(\"SELECT id,name FROM components_fts WHERE components_fts MATCH 'bento' LIMIT 5\").all())"
```

The database lives at `dist/data/registry.db` (WAL mode). It is git-ignored; the crawl recreates it.

## Agent workflow skills

`.cursorrules` contains the agent-facing workflow skills (discovery → build prompt → theme → audit).
Drop it into any agent's project rules to teach registry usage.

## Project layout

```
free-design-registry/
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
├── .cursorrules          # agent workflow skills
├── test-mcp.mjs          # MCP stdio integration test (all tools)
├── test-theme.mjs        # get_theme integration test
└── src/
    ├── schema.sql        # components table + FTS5 virtual table + triggers
    ├── db.ts             # SQLite access layer (better-sqlite3) + theme engine
    ├── crawler.ts        # discovery + hydration
    ├── server.ts         # MCP stdio server (5 tools)
    └── build.ts          # esbuild CJS bundler
```

## Publishing / rebuilding elsewhere

This is a self-contained repo. To reproduce on any machine or agent:

1. `git clone <this-repo>`
2. `npm install && npm run build && npm run crawl`
3. Add the MCP client config above.

No secrets, no external services. The only network dependency is the public `21st.dev` endpoints
during the one-time crawl. The prebuilt catalog is intentionally **not** committed (it's a ~10 MB
binary blob); the idempotent crawl reproduces it in ~15 minutes.
