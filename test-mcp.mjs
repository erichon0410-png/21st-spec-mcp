import { spawn } from "node:child_process";

const p = spawn("node", ["dist/server/index.cjs"], { cwd: process.cwd() });
let buf = "";
const responses = [];
p.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    if (!line) continue;
    buf = buf.slice(idx + 1);
    try { responses.push(JSON.parse(line)); } catch {}
  }
});
const send = (obj) => p.stdin.write(JSON.stringify(obj) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });
setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_build_prompt", arguments: { query: "stock dashboard" } } });
}, 600);

setTimeout(() => {
  const tools = responses.find((r) => r.id === 2)?.result?.tools ?? [];
  console.log("=== TOOLS ===");
  for (const t of tools) console.log(`- ${t.name}: ${t.description?.slice(0, 60)}...`);
  const call = responses.find((r) => r.id === 3)?.result;
  console.log("\n=== get_build_prompt(query='stock dashboard') ===");
  console.log(call?.content?.[0]?.text ?? "(no result)");
  p.kill();
  process.exit(0);
}, 2000);
