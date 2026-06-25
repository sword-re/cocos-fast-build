/**
 * 装配校验:装配指定 bundle 到 temp,结构性对照真实 config(集合等价,非字节序)。
 * 用法:tsx assemble-check.ts <bundleName>(默认 Audio)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembleBundle } from "../assemble.js";
import { decompressUuid } from "../uuid.js";
import { BUILD_DIR } from "../paths.js";

const name = process.argv[2] || "Audio";

function realCfg(n: string): any | null {
    for (const base of ["assets", "subpackages", "remote"]) {
        let files: string[];
        try {
            files = readdirSync(join(BUILD_DIR, base, n));
        } catch {
            continue;
        }
        const c = files.find((f) => f.startsWith("config."));
        if (c) return JSON.parse(readFileSync(join(BUILD_DIR, base, n, c), "utf8"));
    }
    return null;
}

const out = join(tmpdir(), "fast-build-assemble");
const res = await assembleBundle(name, out);
const real = realCfg(name);
if (!real) {
    console.log(`无真实 config 对照(${name}),仅打印装配结果`);
    console.log(`import=${res.importCount} native=${res.nativeCount} skipped=${res.skipped.length}`);
    process.exit(0);
}

const mine = res.config;
const realU = new Set((real.uuids as string[]).map(decompressUuid));
const myU = new Set((mine.uuids as string[]).map(decompressUuid));
const setDiff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).length;

// paths:对照 (path -> type) 集合
const pathSet = (cfg: any) => {
    const s = new Set<string>();
    for (const k in cfg.paths) s.add(`${cfg.paths[k][0]}|${cfg.types[cfg.paths[k][1]]}`);
    return s;
};
const rp = pathSet(real);
const mp = pathSet(mine);

// redirect:对照 (uuid -> depBundle) 集合
const redirMap = (cfg: any) => {
    const m = new Map<string, string>();
    const u = (cfg.uuids as string[]).map(decompressUuid);
    for (let i = 0; i < (cfg.redirect || []).length; i += 2) m.set(u[cfg.redirect[i]], cfg.deps[cfg.redirect[i + 1]]);
    return m;
};
const rr = redirMap(real);
const mr = redirMap(mine);
let redirBad = 0;
for (const [u, t] of mr) if (rr.has(u) && rr.get(u) !== t) redirBad++;

console.log(`=== 装配校验 ${name} ===`);
console.log(`输出: ${res.outDir}`);
console.log(`uuids       real=${realU.size} 我=${myU.size}  漏=${setDiff(realU, myU)} 多=${setDiff(myU, realU)}`);
console.log(`owned import real=${(real.versions.import.length / 2) | 0} 我=${res.importCount}  native real=${(real.versions.native.length / 2) | 0} 我=${res.nativeCount}`);
console.log(`paths       real=${rp.size} 我=${mp.size}  漏=${setDiff(rp, mp)} 多=${setDiff(mp, rp)}`);
console.log(`types       real=[${real.types.join(",")}]  我=[${mine.types.join(",")}]`);
console.log(`redirect    real=${rr.size} 我=${mr.size}  目标不符=${redirBad}`);
console.log(`deps        real=[${(real.deps || []).join(",")}]  我=[${mine.deps.join(",")}]`);
console.log(`scenes/packs real packs=${Object.keys(real.packs || {}).length} scenes=${Object.keys(real.scenes || {}).length}  我 packs=${Object.keys(mine.packs).length} scenes=${Object.keys(mine.scenes).length}`);
if (res.skipped.length) console.log(`跳过(无import)=${res.skipped.length}`);
