/**
 * 反推共享资源归属规则:解析真实 config 得每个资源的真实 owner(uuids 去掉 redirect 项),
 * 对照物理归属 bundleOf,统计被"上浮"的资源去向。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { discoverBundles } from "../bundles.js";
import { bundleOf } from "../assetGraph.js";
import { decompressUuid } from "../uuid.js";
import { BUILD_DIR } from "../paths.js";

function loadConfig(name: string): any | null {
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

// 真实 owner:每个 bundle 的 uuids 中,不在 redirect 源位置的就是它 own 的
const realOwner = new Map<string, string>();
const conflict: string[] = [];
for (const b of discoverBundles()) {
    const cfg = loadConfig(b.name);
    if (!cfg) continue;
    const redirectedIdx = new Set<number>();
    const red = cfg.redirect || [];
    for (let i = 0; i < red.length; i += 2) redirectedIdx.add(red[i]);
    (cfg.uuids as string[]).forEach((cu, i) => {
        if (redirectedIdx.has(i)) return; // 这是 redirect,不是本 bundle own
        const u = decompressUuid(cu);
        if (realOwner.has(u) && realOwner.get(u) !== b.name && conflict.length < 5) conflict.push(`${u} owned by ${realOwner.get(u)} & ${b.name}`);
        realOwner.set(u, b.name);
    });
}

// 对照物理归属
let samePhys = 0,
    promoted = 0,
    physNull = 0;
const promoteTargets = new Map<string, number>(); // "physBundle->ownerBundle" -> count
for (const [u, owner] of realOwner) {
    const phys = bundleOf(u);
    if (phys === owner) samePhys++;
    else if (phys === null) physNull++;
    else {
        promoted++;
        const key = `${phys} -> ${owner}`;
        promoteTargets.set(key, (promoteTargets.get(key) ?? 0) + 1);
    }
}

console.log(`真实 owner 总数: ${realOwner.size}`);
console.log(`物理==owner: ${samePhys}  上浮(物理!=owner): ${promoted}  物理无(合成/无meta): ${physNull}`);
console.log(`冲突(被多bundle own): ${conflict.length}`, conflict.slice(0, 3));
console.log(`\n上浮去向(physBundle -> ownerBundle: 数量),按量排序:`);
for (const [k, n] of [...promoteTargets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n.toString().padStart(4)}  ${k}`);
