/**
 * 爬取归属验证:用真实 config 当 oracle,逐 bundle 对比 crawl() 的产出。
 * 指标:
 *  - uuids 闭包:命中/漏/多(我多算=误报隐患)。
 *  - owned 归属:命中/漏/多。
 *  - redirect 目标:命中/不同。
 *  - 健全性:redirect 的 owner 是否进了 deps(构造应 100%)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { crawl } from "../crawl.js";
import { decompressUuid } from "../uuid.js";
import { BUILD_DIR } from "../paths.js";
import { atlasConsumption } from "../atlas.js";

// 合成图集大图:我们的 uuid 与 cocos 合成 id 必然不同(按设计不复现),从一致性统计里排除
const SYNTH = atlasConsumption().bigTextures;
const real = (arr: string[]) => arr.filter((u) => !SYNTH.has(u));

function realCfg(name: string): any | null {
    for (const base of ["assets", "subpackages", "remote"]) {
        let files: string[];
        try {
            files = readdirSync(join(BUILD_DIR, base, name));
        } catch {
            continue;
        }
        const c = files.find((f) => f.startsWith("config."));
        if (c) return JSON.parse(readFileSync(join(BUILD_DIR, base, name, c), "utf8"));
    }
    return null;
}

const { bundles, bundleInfo } = crawl();

const pad = (s: string | number, n: number) => String(s).padEnd(n);
let totOwnMiss = 0,
    totOwnExtra = 0,
    totUuidMiss = 0,
    totUuidExtra = 0,
    totRedirBad = 0,
    totUnsound = 0;

console.log(
    pad("bundle", 15) +
        pad("uuids real/我", 14) +
        pad("uuid漏/多", 12) +
        pad("owned real/我", 14) +
        pad("own漏/多", 12) +
        pad("redir差", 9) +
        "不健全"
);

for (const b of [...bundles].sort((a, b) => b.priority - a.priority)) {
    const cfg = realCfg(b.name);
    if (!cfg) continue;
    const info = bundleInfo.get(b.name)!;

    // real uuids / redirect / owned
    const realUuids = (cfg.uuids as string[]).map(decompressUuid);
    const realRedirIdx = new Set<number>();
    const realRedirTarget = new Map<string, string>();
    const deps: string[] = cfg.deps || [];
    const red: number[] = cfg.redirect || [];
    for (let i = 0; i < red.length; i += 2) {
        realRedirIdx.add(red[i]);
        realRedirTarget.set(realUuids[red[i]], deps[red[i + 1]]);
    }
    const realUuidSet = new Set(realUuids);
    const realOwned = new Set(realUuids.filter((_, i) => !realRedirIdx.has(i)));

    const myUuids = new Set(real(info.uuids)); // 排除合成大图(uuid 必然不同)
    const myOwned = new Set(real(info.owned));

    const uuidMiss = realUuids.filter((u) => !myUuids.has(u)).length;
    const uuidExtra = [...myUuids].filter((u) => !realUuidSet.has(u)).length;
    const ownMiss = [...realOwned].filter((u) => !myOwned.has(u)).length;
    const ownExtra = [...myOwned].filter((u) => !realOwned.has(u)).length;

    // redirect 目标对比(两边都判为 redirect 的)
    let redirBad = 0;
    for (const [u, t] of info.redirect) {
        const rt = realRedirTarget.get(u);
        if (rt && rt !== t) redirBad++;
    }
    // 健全:我的 redirect 目标必须在我的 deps 里
    const myDeps = new Set(info.deps);
    let unsound = 0;
    for (const t of info.redirect.values()) if (!myDeps.has(t)) unsound++;

    totOwnMiss += ownMiss;
    totOwnExtra += ownExtra;
    totUuidMiss += uuidMiss;
    totUuidExtra += uuidExtra;
    totRedirBad += redirBad;
    totUnsound += unsound;

    console.log(
        pad(b.name, 15) +
            pad(`${realUuids.length}/${info.uuids.length}`, 14) +
            pad(`${uuidMiss}/${uuidExtra}`, 12) +
            pad(`${realOwned.size}/${myOwned.size}`, 14) +
            pad(`${ownMiss}/${ownExtra}`, 12) +
            pad(redirBad, 9) +
            unsound
    );
}

console.log(
    `\n合计  uuid漏=${totUuidMiss} uuid多=${totUuidExtra}  own漏=${totOwnMiss} own多(误报)=${totOwnExtra}  redir差=${totRedirBad}  不健全=${totUnsound}`
);
