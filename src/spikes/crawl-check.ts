/**
 * 爬取核心验证:用真实 config 当"使用集"oracle,验证依赖图+物理归属能否复现 redirect。
 * 对每个 bundle:owned=real.uuids∩本bundle;ext=owned 的外部引用(归属≠本bundle);
 * realRedirect=real.uuids 中归属≠本bundle 的。比较 ext 与 realRedirect。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { discoverBundles } from "../bundles.js";
import { bundleOf, directDeps } from "../assetGraph.js";
import { decompressUuid } from "../uuid.js";
import { BUILD_DIR } from "../paths.js";

function realCfg(name: string): Set<string> | null {
    for (const base of ["assets", "subpackages", "remote"]) {
        let files: string[];
        try {
            files = readdirSync(join(BUILD_DIR, base, name));
        } catch {
            continue;
        }
        const cfg = files.find((f) => f.startsWith("config."));
        if (cfg) return new Set((JSON.parse(readFileSync(join(BUILD_DIR, base, name, cfg), "utf8")).uuids as string[]).map(decompressUuid));
    }
    return null;
}

for (const b of discoverBundles().sort((a, b) => b.priority - a.priority)) {
    const real = realCfg(b.name);
    if (!real) continue;
    const owned = [...real].filter((u) => bundleOf(u) === b.name);
    const realRedirect = new Set([...real].filter((u) => bundleOf(u) !== b.name));
    // 闭包遍历:从 owned 出发,经"物理属本bundle"的中间资源传递,收集外部引用
    const ext = new Set<string>();
    const seen = new Set<string>(owned);
    const stack = [...owned];
    while (stack.length) {
        const u = stack.pop()!;
        for (const d of directDeps(u)) {
            if (!real.has(d)) continue; // 用 real 当"使用集"oracle
            if (!seen.has(d)) {
                seen.add(d);
                stack.push(d); // 全闭包遍历(含外部),config.uuids 是完整传递闭包
            }
            if (bundleOf(d) !== b.name) ext.add(d); // 外部 → redirect
        }
    }
    // ext 应 ≈ realRedirect
    let hit = 0;
    for (const u of ext) if (realRedirect.has(u)) hit++;
    const missing = [...realRedirect].filter((u) => !ext.has(u)).length; // real redirect 我没算出
    const extra = [...ext].filter((u) => !realRedirect.has(u)).length; // 我多算的
    console.log(
        `${b.name.padEnd(15)} owned=${owned.length} realRedirect=${realRedirect.size} 我算ext=${ext.size} 命中=${hit} 漏=${missing} 多=${extra}`
    );
}
