/** crawl 输出指纹:用于重构前后等价性对比。只调用 crawl()(同步,新旧通用)。 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { crawl } from "../crawl.js";

const t0 = performance.now();
const r = crawl();
const ms = performance.now() - t0;

const h = createHash("md5");
const names = [...r.bundles.map((b) => b.name)].sort();
for (const name of names) {
    const info = r.bundleInfo.get(name)!;
    h.update(`\n# ${name}\n`);
    h.update("uuids:" + [...info.uuids].sort().join(",") + "\n");
    h.update("owned:" + [...info.owned].sort().join(",") + "\n");
    h.update("deps:" + [...info.deps].sort().join(",") + "\n");
    h.update("atlas:" + [...info.atlasTextures].sort().join(",") + "\n");
    h.update("redirect:" + [...info.redirect.entries()].map(([k, v]) => `${k}>${v}`).sort().join(",") + "\n");
    const clo = r.closures.get(name)!;
    h.update("closure:" + [...clo].sort().join(",") + "\n");
}
console.log(`bundles=${names.length} digest=${h.digest("hex")} crawl(sync)=${ms.toFixed(0)}ms`);
