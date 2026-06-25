import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { primeCrawl, crawl } from "../crawl.js";
import { assembleBundle } from "../assemble.js";
import { PROJECT_ROOT } from "../paths.js";

await primeCrawl();
const bundles = [...crawl().bundles].sort((a, b) => b.priority - a.priority);
const out = join(PROJECT_ROOT, "build/_asm-digest");
rmSync(out, { recursive: true, force: true });
const t0 = performance.now();
for (const b of bundles) {
  const parent = b.isRemote ? "remote" : (b.name === "resources" || b.name === "main" || b.name === "internal") ? "assets" : "subpackages";
  try { await assembleBundle(b.name, join(out, parent)); } catch {}
}
const ms = performance.now() - t0;
// 收集全部产物文件 -> 相对路径 + 内容md5,排序后总hash
const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
walk(out);
const lines = files.map((f) => `${relative(out, f)}:${createHash("md5").update(readFileSync(f)).digest("hex")}`).sort();
const digest = createHash("md5").update(lines.join("\n")).digest("hex");
console.log(`files=${files.length} digest=${digest} assemble=${ms.toFixed(0)}ms`);
rmSync(out, { recursive: true, force: true });
