import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  searchComponents,
  getComponentById,
  closeDb,
  matchPalette,
  parseStoredCssVars,
  type ThemeTokens,
} from "./db.js";

const server = new McpServer({ name: "free-design-registry", version: "1.0.0" });

// --- Tool 1: search_designs -------------------------------------------------
server.tool(
  "search_designs",
  "Full-text search over the local design registry (SQLite FTS5). Returns matching components ranked by relevance.",
  {
    query: z.string().describe("Search terms, e.g. 'bento grid' or 'glow card'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results to return (default 8)."),
  },
  async ({ query, limit }) => {
    const results = searchComponents(query, limit ?? 8);
    if (results.length === 0) {
      return { content: [{ type: "text", text: `No components matched "${query}".` }] };
    }
    const lines = results.map(
      (r) =>
        `- ${r.id} — ${r.name}${r.category ? ` [${r.category}]` : ""}` +
        `${r.description ? ` — ${r.description}` : ""}`
    );
    return {
      content: [{ type: "text", text: `${results.length} result(s):\n${lines.join("\n")}` }],
    };
  }
);

// --- Helper: turn a component record into a reusable build-prompt ------------
function buildPromptText(c: {
  id: string;
  name: string;
  author: string;
  description: string | null;
}): string {
  const desc = (c.description ?? "").trim();
  return [
    `# Build Prompt — ${c.name}`,
    `Registry source: ${c.id} (author: ${c.author})`,
    "",
    "## What this is",
    desc || "(no description available — infer intent from the name and category)",
    "",
    "## Build requirements",
    "Turn the description above into a working implementation. Cover at minimum:",
    "- Layout & structure: describe the section/page layout top-to-bottom.",
    "- Key components: list each distinct UI piece (cards, tables, charts, modals, nav, etc.).",
    "- Data & content: what data it displays; use realistic mock data where none is given.",
    "- Interactions: hover states, clicks, sorting, modals, navigation, loading/empty states.",
    "- Styling & theme: match the project's design tokens (inspect /components/ui and /styles); support light + dark.",
    "- Responsive: behavior at mobile, tablet, and desktop breakpoints.",
    "",
    "## Acceptance criteria",
    "- [ ] Faithfully matches the description above.",
    "- [ ] Uses the project's design tokens (colors, spacing, typography) — no ad-hoc values.",
    "- [ ] Accessible: semantic HTML, aria labels, keyboard navigation, contrast ≥ 4.5:1.",
    "- [ ] Responsive down to mobile with no horizontal scroll.",
  ].join("\n");
}

// --- Tool: get_build_prompt --------------------------------------------------
server.tool(
  "get_build_prompt",
  "Turn a registry component into a detailed, reusable build-prompt. Provide an id ('author/slug') or a search query; the best-matching component's description is expanded into a structured spec (layout, components, data, interactions, styling, responsive, acceptance criteria) you can feed to your LLM to build the feature.",
  {
    id: z
      .string()
      .optional()
      .describe("Component id in 'author/slug' form. If omitted, `query` is used to find the best match."),
    query: z
      .string()
      .optional()
      .describe("Search terms used to find the best-matching component when `id` is omitted."),
  },
  async ({ id, query }) => {
    let c: { id: string; name: string; author: string; description: string | null } | null =
      null;
    if (id) {
      c = getComponentById(id);
    } else if (query) {
      const results = searchComponents(query, 1);
      c = results.length ? results[0] : null;
    }
    if (!c) {
      return {
        content: [
          {
            type: "text",
            text: `No component found${id ? ` for id "${id}"` : ` matching "${query}"`}.`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: buildPromptText(c) }] };
  }
);

// --- Tool 2: inspect_component ---------------------------------------------
server.tool(
  "inspect_component",
  "Fetch the full record for one component by its 'author/slug' id: files, dependencies, registry dependencies, tailwind config, and css vars.",
  {
    id: z.string().describe("Component id in 'author/slug' form, e.g. 'magicui/bento-grid'."),
  },
  async ({ id }) => {
    const comp = getComponentById(id);
    if (!comp) {
      return {
        content: [{ type: "text", text: `Component "${id}" not found in the registry.` }],
        isError: true,
      };
    }
    const out = {
      id: comp.id,
      name: comp.name,
      author: comp.author,
      slug: comp.slug,
      category: comp.category,
      description: comp.description,
      dependencies: JSON.parse(comp.dependencies),
      registryDependencies: JSON.parse(comp.registry_dependencies),
      files: JSON.parse(comp.files).map((f: any) => ({
        name: f.name,
        type: f.type,
        content: f.content,
      })),
      tailwindConfig: JSON.parse(comp.tailwind_config),
      cssVars: JSON.parse(comp.css_vars),
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

// --- Tool 3: install_component ---------------------------------------------
server.tool(
  "install_component",
  "Write a component's files to a target directory (default: current working directory). Returns the list of written file paths.",
  {
    id: z.string().describe("Component id in 'author/slug' form."),
    targetDir: z
      .string()
      .optional()
      .describe("Directory to write files into (default: process.cwd())."),
  },
  async ({ id, targetDir }) => {
    const comp = getComponentById(id);
    if (!comp) {
      return {
        content: [{ type: "text", text: `Component "${id}" not found in the registry.` }],
        isError: true,
      };
    }
    const files = JSON.parse(comp.files);
    if (!Array.isArray(files) || files.length === 0) {
      return {
        content: [{ type: "text", text: `Component "${id}" has no files to install.` }],
        isError: true,
      };
    }
    const dir = targetDir ? path.resolve(targetDir) : process.cwd();
    const written: string[] = [];
    for (const f of files) {
      const rel = f.name;
      if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
        return {
          content: [{ type: "text", text: `Unsafe file path in component "${id}": ${rel}` }],
          isError: true,
        };
      }
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content ?? "", "utf-8");
      written.push(abs);
    }
    return {
      content: [
        {
          type: "text",
          text: `Installed ${written.length} file(s) for "${id}" into ${dir}:\n` +
            written.map((w) => `- ${w}`).join("\n"),
        },
      ],
    };
  }
);

// --- Theme output formatters -------------------------------------------------
function cssVarsBlock(t: ThemeTokens): string {
  return [
    "```css",
    ":root {",
    `  --background: ${t.background};`,
    `  --foreground: ${t.foreground};`,
    `  --primary: ${t.primary};`,
    `  --accent: ${t.accent};`,
    `  --radius: ${t.radius};`,
    "}",
    ".dark {",
    `  --background: ${t.darkBackground};`,
    `  --foreground: ${t.darkForeground};`,
    "}",
    "```",
  ].join("\n");
}

function tailwindBlock(t: ThemeTokens): string {
  return [
    "```js",
    "/** @type {import('tailwindcss').Config} */",
    "module.exports = {",
    "  theme: {",
    "    extend: {",
    "      colors: {",
    `        background: "${t.background}",`,
    `        foreground: "${t.foreground}",`,
    `        primary: { DEFAULT: "${t.primary}" },`,
    `        accent: "${t.accent}",`,
    "      },",
    "      borderRadius: {",
    `        lg: "${t.radius}",`,
    "      },",
    "    },",
    "  },",
    "};",
    "```",
  ].join("\n");
}

function themeOutput(t: ThemeTokens, mode: "css_vars" | "tailwind" | "both", label: string): string {
  const parts: string[] = [`# ${label}`];
  if (mode === "css_vars" || mode === "both") parts.push(cssVarsBlock(t));
  if (mode === "tailwind" || mode === "both") parts.push(tailwindBlock(t));
  return parts.join("\n\n");
}

// --- Tool: get_theme ---------------------------------------------------------
server.tool(
  "get_theme",
  "Extract design tokens to theme a page. Give a component id ('author/slug'), an author name, or a style keyword (e.g. 'neon', 'dark', 'minimal'). Returns copy-pasteable :root/.dark CSS and/or a Tailwind config block you can drop into globals.css / tailwind.config.",
  {
    identifier: z
      .string()
      .describe("A component id ('author/slug'), an author name, or a style keyword (e.g. 'zinc', 'dark', 'neon')."),
    mode: z
      .enum(["css_vars", "tailwind", "both"])
      .optional()
      .describe("Output format to extract (default 'both')."),
  },
  async ({ identifier, mode }) => {
    const m = mode ?? "both";
    const id = identifier.trim();

    // 1) Exact component target: return stored tokens if present.
    const rec = getComponentById(id);
    if (rec) {
      const stored = parseStoredCssVars(rec.css_vars);
      if (stored) {
        return { content: [{ type: "text", text: themeOutput(stored, m, `Theme tokens from registry component "${id}"`) }] };
      }
      // No stored tokens (partial hydration) → infer a palette from the component's own text.
      const inferred = matchPalette(`${rec.name} ${rec.category ?? ""} ${rec.description ?? ""}`);
      return {
        content: [
          {
            type: "text",
            text:
              `Component "${id}" has no stored theme tokens (partial hydration — css_vars/tailwind_config empty).\n` +
              `Inferred aesthetic: ${inferred.name}.\n` +
              (rec.description ? `Description: ${rec.description}\n\n` : "\n") +
              themeOutput(inferred.tokens, m, `Inferred default theme for "${id}" (not from registry)`),
          },
        ],
      };
    }

    // 2) Keyword / author target: show matching components + a curated palette.
    const matches = searchComponents(id, 5);
    const palette = matchPalette(id);
    const listLine = matches.length
      ? `Matching registry components (for reference):\n${matches.map((r) => `- ${r.id} — ${r.name}${r.category ? ` [${r.category}]` : ""}`).join("\n")}\n\n`
      : `No registry component matched "${id}" — using a curated default palette.\n\n`;
    return {
      content: [
        {
          type: "text",
          text:
            `Curated theme for "${id}" (palette: ${palette.name}).\n` +
            listLine +
            themeOutput(palette.tokens, m, `Curated default theme for "${id}"`),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
// Wrap in an async IIFE: top-level await is not supported in CJS output.
(async () => {
  await server.connect(transport);
  // Log to stderr (stdout is reserved for the MCP protocol).
  console.error("free-design-registry MCP server running on stdio.");
})();

process.on("SIGINT", () => {
  closeDb();
  process.exit(0);
});
