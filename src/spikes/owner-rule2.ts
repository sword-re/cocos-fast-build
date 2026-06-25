/**
 * 验证归属假设:owner = 直接引用该资源的所有 bundle(含其物理 bundle)中"优先级最高"的。
 * 建全局反向引用图(谁直接引用 X),对照真实 owner。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverBundles } from "../bundles.js";
import { bundleOf, directDeps } from "../assetGraph.js";
import { decompressUuid } from "../uuid.js";
import { BUILD_DIR, PROJECT_ROOT, libraryImportPath } from "../paths.js";

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

const bundles = discoverBundles();
const prio = new Map(bundles.map((b) => [b.name, b.priority]));

// 真实 owner
const realOwner = new Map<string, string>();
for (const b of bundles) {
    const cfg = loadConfig(b.name);
    if (!cfg) continue;
    const redir = new Set<number>();
    for (let i = 0; i < (cfg.redirect || []).length; i += 2) redir.add(cfg.redirect[i]);
    (cfg.uuids as string[]).forEach((cu, i) => {
        if (!redir.has(i)) realOwner.set(decompressUuid(cu), b.name);
    });
}

// 全局反向引用:X -> 直接引用它的 bundle 集合(用所有 library 资源的 directDeps)
const LIB = join(PROJECT_ROOT, "library/imports");
const allUuids: string[] = [];
for (const sub of readdirSync(LIB)) {
    const d = join(LIB, sub);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".json")) allUuids.push(f.slice(0, -5));
}
const refBundles = new Map<string, Set<string>>(); // X -> 引用它的 bundle 集
const noteRef = (x: string, b: string | null) => {
    if (!b) return;
    let s = refBundles.get(x);
    if (!s) refBundles.set(x, (s = new Set()));
    s.add(b);
};
for (const u of allUuids) {
    const ub = bundleOf(u);
    for (const d of directDeps(u)) noteRef(d, ub);
}

// 预测 owner = 引用 bundle ∪ {物理} 中 priority 最高
function predict(u: string): string | null {
    const cands = new Set(refBundles.get(u) || []);
    const phys = bundleOf(u);
    if (phys) cands.add(phys);
    let best: string | null = null;
    let bestP = -1;
    for (const b of cands) {
        const p = prio.get(b) ?? -1;
        if (p > bestP) {
            bestP = p;
            best = b;
        }
    }
    return best;
}

let ok = 0,
    bad = 0;
const mism: string[] = [];
for (const [u, owner] of realOwner) {
    if (bundleOf(u) === null) continue; // 合成/无 meta 跳过
    const p = predict(u);
    if (p === owner) ok++;
    else {
        bad++;
        if (mism.length < 12) mism.push(`${u.slice(0, 8)} real=${owner} pred=${p} phys=${bundleOf(u)} refs=[${[...(refBundles.get(u) || [])].join(",")}]`);
    }
}
console.log(`归属预测命中: ${ok}  不命中: ${bad}`);
console.log(mism.join("\n"));
