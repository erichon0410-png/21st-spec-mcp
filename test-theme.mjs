import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/server/index.cjs"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const responses = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch {}
  }
});

const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
function call(id, method, params) {
  return new Promise((res) => {
    const t = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(t);
        res(responses.get(id));
      }
    }, 50);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const init = await call(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0" },
});
console.log("INIT:", JSON.stringify(init.result?.serverInfo ?? init));
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const list = await call(2, "tools/list", {});
console.log("TOOLS:", (list.result?.tools ?? []).map((t) => t.name).join(", "));

const show = (label, r) => console.log(`\n=== ${label} ===\n` + (r.result?.content?.[0]?.text ?? JSON.stringify(r)));

show("get_theme('neon')", await call(3, "tools/call", { name: "get_theme", arguments: { identifier: "neon" } }));
show("get_theme('minimal', css_vars)", await call(4, "tools/call", { name: "get_theme", arguments: { identifier: "minimal", mode: "css_vars" } }));
show("get_theme('sunset', tailwind)", await call(5, "tools/call", { name: "get_theme", arguments: { identifier: "sunset", mode: "tailwind" } }));
show("get_theme('nikolas-sapa/hero-recursive-type')", await call(6, "tools/call", { name: "get_theme", arguments: { identifier: "nikolas-sapa/hero-recursive-type" } }));

proc.kill();
process.exit(0);
