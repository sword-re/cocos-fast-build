/**
 * 共享资源归属爬取(crawl)。
 *
 * 复刻 cocos 构建器把"物理散落在各 bundle 文件夹的资源"分配成"每个 bundle 的
 * config.uuids / redirect / deps"的算法。核心是共享资源的上浮归属规则。
 *
 * 归属模型(已对照真实 config 反推 + 验证):
 *  1. membership(成员/根):bundle 文件夹下的物理资源 ∩ 有 library import ∩ 未被自动图集消耗。
 *     图集消耗掉的原始 Texture2D 被剔除;依赖图遍历时改指向合成的图集大图 uuid。
 *  2. closure(闭包):从每个 bundle 的物理根出发,沿(重写过的)forward 依赖图做传递闭包。
 *     这复刻了真实 config.uuids = 该 bundle 的完整传递依赖集。
 *  3. bundle 依赖图(用于"公共依赖"判定,破解归属与 deps 的循环):
 *     depEdge(A→B) 当且仅当 priority(B) > priority(A) 且 A 的闭包到达某个物理属 B 的资源。
 *     priority 门控是关键:它阻止共享资源的物理宿主(同/更低优先级的叶子 bundle)
 *     漏进引用者的依赖集 —— 否则会把共享资源错判成留在叶子。
 *  4. ownership(归属,混合规则):资源 R 的被覆盖集 covering(R) = {闭包含 R 的 bundle}。
 *     - 引擎内置(无物理 meta、非合成大图):属固定内置 effect/material 集 → 虚拟 internal;
 *       其余内置(default_sprite / default_panel 等)cocos 当普通共享资源,按 covering/优先级归属
 *       (被引用的物理 bundle 拷贝拥有,真实 config 确有列出)。
 *     - 散落 assets 根的非场景资源(loose,如 Proto/MSDF):有物理 meta 但无 bundle 宿主,按 covering
 *       优先级归属(被某 bundle 引用则归该 bundle;无人引用则不在 covering 中 → 被剪掉)。
 *     - 启动场景(散落根的场景)→ 虚拟主包 main 的根。
 *     - covering 中 priority 最高者唯一 → 它拥有(被它独占使用,或它是最基础引用者)。
 *     - 最高优先级并列(多个同级叶子共享)→ 下沉到公共可服务 bundle =
 *       ∩_{C∈covering}(depSet(C)∪{C}) 中 priority 最低者(就近、最不基础但仍共享),
 *       优先非 remote;公共集为空 → 并列叶子各自复制(无公共依赖)。
 *     物理宿主必是 covering 成员,故单引用资源原地不动;多引用上浮到公共依赖 bundle。
 *  5. redirect/deps(导出):bundle B 的 config.uuids = 闭包 ∪ 自身拥有(昇格进来的图集组等);
 *     闭包里 owner≠B 的资源 → redirect 到 owner;deps(B) = 这些 owner 的集合。
 *     健全性由构造保证:redirect 目标取 B 可服务(在 depSet(B) 内)者,B 一定能加载到 R。
 */
import { join } from "node:path";
import { collectUuidsUnder, discoverBundles, type BundleDef } from "./bundles.js";
import { bundleOf, directDeps, hasPhysicalAsset } from "./assetGraph.js";
import { assetExists } from "./assetExists.js";
import { assetMetaMap } from "./assetMeta.js";
import { atlasConsumption } from "./atlas.js";
import { importMap, primeLibraryIndex } from "./libraryIndex.js";
import { primeMetaScan } from "./metaScan.js";
import { PROJECT_ROOT } from "./paths.js";

const ASSETS = join(PROJECT_ROOT, "assets");

/**
 * 引擎内置 bundle:固定的内置 effect/material 集 + 它们引用的纹理(白纹理)。
 * 与项目是否引用无关(cocos 把整套 2D 内置管线打进 internal)。优先级最高(被依赖、自身 deps 为空)。
 */
const INTERNAL = "internal";
/**
 * 虚拟主包:**仅含启动场景(及散落 assets 根的其它场景)** 及其闭包。
 * priority 7(< resources 8 / Audio 10,> 多数业务包),启动最先加载。
 * 注意:散落在 assets 根的**非场景**资源(如 Proto/*.proto、Script/MSDF.mtl)不属 main——
 * 它们按引用归属(被某 bundle 引用则归该 bundle,无人引用则被 cocos 剪掉)。
 */
const MAIN = "main";
const MAIN_PRIORITY = 7;

/** internal 不收录的 3D-only 内置(2D 项目的 internal 不含 phong / toon / 3d-particle) */
const INTERNAL_EXCLUDE = /^builtin-(phong|toon|3d-particle)$/;

let _mainRoots: Set<string> | null = null;
/** main 的物理根:散落在 assets 根(不属任何物理 bundle)的场景 */
function mainRoots(consumed: Set<string>): Set<string> {
    if (_mainRoots) return _mainRoots;
    const out = new Set<string>();
    for (const [u, m] of assetMetaMap()) {
        if (m.type !== "cc.Scene") continue;
        if (bundleOf(u) !== null) continue; // 在某物理 bundle 内的场景不属 main
        if (consumed.has(u) || !assetExists(u)) continue;
        out.add(u);
    }
    return (_mainRoots = out);
}

let _internalSet: Set<string> | null = null;
/**
 * internal 的固定成员:扫描 library import,取所有内置 effect/material(_name 以 builtin- 开头,
 * 排除 3D-only),并纳入它们引用的内置 Texture2D(白纹理)。复刻真实 internal 的成员集。
 */
function internalBuiltins(): Set<string> {
    if (_internalSet) return _internalSet;
    const set = new Set<string>();
    const imports = importMap();
    for (const [uuid, rec] of imports) {
        const name = rec.name || "";
        if ((rec.type === "cc.EffectAsset" || rec.type === "cc.Material") && name.startsWith("builtin-") && !INTERNAL_EXCLUDE.test(name)) {
            set.add(uuid);
        }
    }
    // 纳入内置 effect/material 引用的内置 Texture2D(无物理 meta 者,如白纹理)
    for (const u of [...set]) {
        for (const d of directDeps(u)) {
            if (set.has(d) || hasPhysicalAsset(d)) continue;
            if (imports.get(d)?.type === "cc.Texture2D") set.add(d);
        }
    }
    return (_internalSet = set);
}

/**
 * 物理归属:真实 bundle | "main"(散落 assets 根的**场景**)| null。
 * null 涵盖两类:① 散落 assets 根的非场景资源(loose,按引用归属);② 引擎内置(无物理 meta)。
 * 二者由 hasPhysicalAsset 区分(loose 有物理 meta,内置没有)。
 */
function homeOf(uuid: string): string | null {
    const b = bundleOf(uuid);
    if (b) return b;
    return mainRoots(atlasConsumption().consumed).has(uuid) ? MAIN : null;
}

/** 物理 bundle + 虚拟 bundle(main/internal)的完整列表 */
function allBundles(): BundleDef[] {
    const physical = discoverBundles();
    const maxPrio = physical.reduce((m, b) => Math.max(m, b.priority), 0);
    const virtuals: BundleDef[] = [
        // internal:最高优先级基座(被依赖、自身无依赖)
        { name: INTERNAL, rootDir: ASSETS, dbPath: "db://internal", priority: maxPrio + 1, compressionType: "merge_all_json", isRemote: false },
        // main:启动主包,roots 仅取散落根的场景
        { name: MAIN, rootDir: ASSETS, dbPath: "db://assets", priority: MAIN_PRIORITY, compressionType: "merge_all_json", isRemote: false },
    ];
    return [...physical, ...virtuals];
}

/** 重写过的直接依赖:把被图集消耗的原始纹理换成合成大图 uuid */
const _depCache = new Map<string, Set<string>>();
function rwDeps(uuid: string): Set<string> {
    let c = _depCache.get(uuid);
    if (c) return c;
    const { rewrite, groupBigTex } = atlasConsumption();
    const memberBt = groupBigTex.get(uuid); // uuid 是图集成员 SF → 它的规范页(与序列化一致)
    const out = new Set<string>();
    for (const d of directDeps(uuid)) {
        // 成员 SF 的被消耗纹理统一指向自己的页(规范大图),避免 fallback 与序列化不一致
        if (memberBt && rewrite.has(d)) out.add(memberBt);
        else out.add(rewrite.get(d) ?? d);
    }
    out.delete(uuid);
    _depCache.set(uuid, out);
    return out;
}

export interface CrawlResult {
    bundles: BundleDef[];
    /** bundleName -> 物理根资源(成员候选) */
    roots: Map<string, Set<string>>;
    /** bundleName -> 完整传递闭包(= 真实 config.uuids 的目标集) */
    closures: Map<string, Set<string>>;
    /** uuid -> 归属 bundle 集(>1 表示并列优先级而复制) */
    ownerOf: Map<string, Set<string>>;
    /** bundleName -> 装配信息 */
    bundleInfo: Map<string, BundleInfo>;
}

export interface BundleInfo {
    /** 完整 config.uuids(owned ∪ redirected),稳定顺序 */
    uuids: string[];
    /** 本 bundle 实际拥有(需序列化进 import/native)的资源 */
    owned: string[];
    /** uuid -> 它真正归属的(外部)bundle */
    redirect: Map<string, string>;
    /** 依赖的其它 bundle(redirect 目标去重) */
    deps: string[];
    /** 合成图集大图(本 bundle 拥有的) */
    atlasTextures: string[];
}

/**
 * 一个 bundle 的物理根:文件夹下的物理资源 ∩ 存在 library ∩ 未被图集消耗。
 * 合成图集大图不在此(它们通过依赖重写在闭包里出现并被归属)。
 */
function rootsOf(b: BundleDef, consumed: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const u of collectUuidsUnder(b.rootDir)) {
        if (consumed.has(u)) continue; // 原始纹理被图集吞并
        if (!assetExists(u)) continue; // 无 library import(纯文件夹/脚本/悬空)
        out.add(u);
    }
    return out;
}

/** 从根集合做(重写依赖图上的)传递闭包;悬空引用按 assetExists 跳过 */
function closureOf(roots: Set<string>, synthetic: Set<string>): Set<string> {
    const seen = new Set<string>(roots);
    const stack = [...roots];
    while (stack.length) {
        const u = stack.pop()!;
        for (const d of rwDeps(u)) {
            if (seen.has(d)) continue;
            if (synthetic.has(d)) {
                seen.add(d); // 合成大图:计入,无下游
            } else if (assetExists(d)) {
                seen.add(d);
                stack.push(d);
            }
            // 否则悬空引用:编辑器会丢弃,不计入闭包
        }
    }
    return seen;
}

/**
 * 并行预热共享读盘缓存(.meta 扫描 + library import 索引)。
 * 在 crawl() 之前调用,把成千上万个小文件的 read syscall 摊到 worker 池;crawl() 本身保持同步。
 * 不调用也正确(各扫描首次访问时单线程回退),只是慢。
 */
export async function primeCrawl(): Promise<void> {
    // 顺序而非并发:两个预热各自起满 worker 池,并发会让 ~22 个 worker 争抢 ~12 核反而更慢
    // (实测并发 ~900ms vs 顺序 ~530ms)。
    await primeMetaScan();
    await primeLibraryIndex();
}

let _cached: CrawlResult | null = null;

/** 执行整套爬取归属;结果缓存。 */
export function crawl(): CrawlResult {
    if (_cached) return _cached;
    const bundles = allBundles();
    const prio = new Map(bundles.map((b) => [b.name, b.priority]));
    const { consumed, bigTextures: synthetic } = atlasConsumption();
    const internalSet = internalBuiltins(); // 固定内置 effect/material(+ 引用纹理)集

    // 1. roots + 2. closures(虚拟包特判:main 取散落根,internal 无物理根)
    const roots = new Map<string, Set<string>>();
    const closures = new Map<string, Set<string>>();
    for (const b of bundles) {
        const r = b.name === MAIN ? mainRoots(consumed) : b.name === INTERNAL ? new Set<string>() : rootsOf(b, consumed);
        roots.set(b.name, r);
        closures.set(b.name, closureOf(r, synthetic));
    }

    // 3. bundle 依赖图:depSet(A) = {B : prio(B)>prio(A) 且 A 闭包到达物理属 B 的资源}
    const isRemote = new Map(bundles.map((b) => [b.name, b.isRemote]));
    const depSet = new Map<string, Set<string>>();
    for (const b of bundles) {
        const pa = prio.get(b.name) ?? -1;
        const s = new Set<string>();
        for (const u of closures.get(b.name)!) {
            if (synthetic.has(u)) continue; // 合成大图:归属由 covering 决定,不入物理依赖
            if (!hasPhysicalAsset(u)) {
                if (internalSet.has(u)) s.add(INTERNAL); // 内置 effect/material → 依赖 internal
                continue; // 其它内置(default sprite 等):无物理宿主,归属由 covering 决定
            }
            const home = homeOf(u); // 物理 bundle | main(场景)| null(散落 loose 资源)
            if (home === null) continue; // 散落 loose 资源:无物理宿主,归属由 covering 决定
            if (home !== b.name && (prio.get(home) ?? -1) > pa) s.add(home);
        }
        depSet.set(b.name, s);
    }

    // covering: uuid -> 含它的 bundle 集
    const covering = new Map<string, Set<string>>();
    for (const b of bundles) {
        for (const u of closures.get(b.name)!) {
            let s = covering.get(u);
            if (!s) covering.set(u, (s = new Set()));
            s.add(b.name);
        }
    }

    // 4. owner:最高优先级 coverer 唯一 → 它;最高优先级并列(同级叶子)→ 下沉到公共依赖
    const ownerOf = new Map<string, Set<string>>();
    for (const [u, cov] of covering) {
        // 内置 effect/material(+ 白纹理)→ 虚拟 internal;其余内置(default_sprite 等)无物理宿主,
        // 但 cocos 把它们当普通共享资源,按下方 covering/优先级归属(被引用的物理 bundle 拷贝拥有)。
        if (!synthetic.has(u) && !hasPhysicalAsset(u) && internalSet.has(u)) {
            ownerOf.set(u, new Set([INTERNAL]));
            continue;
        }
        let maxP = -Infinity;
        for (const c of cov) maxP = Math.max(maxP, prio.get(c) ?? -1);
        const top = [...cov].filter((c) => (prio.get(c) ?? -1) === maxP);
        if (top.length === 1) {
            ownerOf.set(u, new Set(top)); // 唯一最高优先级 coverer 拥有
            continue;
        }
        // 并列(多个同级叶子共享)→ 各自复制(每个 coverer 拥有一份)。
        // 不下沉到公共依赖:公共依赖不是 coverer,其闭包不含该资源 → 也不含该资源的依赖,
        // 下沉会导致"拥有资源但缺其依赖"的断链(如 ec9f9055 下沉到 Common 但 812f2065 缺失)。
        // 复制到叶子则自洽:叶子的物理根闭包必含该资源及其传递依赖。真实 cocos 亦复制。
        ownerOf.set(u, new Set(top));
    }

    // 4b. internal 固定全集:即使项目闭包未引用(如 builtin-2d-label / clear-stencil),
    //     cocos 也会把整套 2D 内置 effect/material 打进 internal,故强制归属。
    for (const u of internalSet) ownerOf.set(u, new Set([INTERNAL]));

    // 4c. 反向:bundle -> 它拥有的资源(含被昇格进来、但不在自身闭包的图集成员)
    const ownedBy = new Map<string, Set<string>>(bundles.map((b) => [b.name, new Set<string>()]));
    for (const [u, owners] of ownerOf) for (const o of owners) ownedBy.get(o)?.add(u);

    // 5. 每个 bundle 的 uuids/redirect/deps
    //    uuids = 闭包 ∪ 自身拥有(昇格进来的);redirect = 闭包里 owner≠本 bundle 的
    const bundleInfo = new Map<string, BundleInfo>();
    for (const b of bundles) {
        const clo = closures.get(b.name)!;
        const mine = ownedBy.get(b.name)!;
        const owned: string[] = [];
        const atlasTextures: string[] = [];
        for (const u of mine) {
            owned.push(u);
            if (synthetic.has(u)) atlasTextures.push(u);
        }
        const redirect = new Map<string, string>();
        const depsSet = new Set<string>();
        const pruned = new Set<string>();
        for (const u of clo) {
            if (mine.has(u)) continue; // 自己拥有,非 redirect
            const owners = ownerOf.get(u);
            if (!owners) {
                pruned.add(u); // 无归属(引擎内嵌 default_* 等):cocos 不入 config,运行时引擎自带
                continue;
            }
            const target = pickRedirectTarget(owners, depSet.get(b.name)!, prio);
            redirect.set(u, target);
            depsSet.add(target);
        }
        const uuids = new Set<string>();
        for (const u of clo) if (!pruned.has(u)) uuids.add(u);
        for (const u of mine) uuids.add(u); // 昇格进来的资源也列入 config.uuids
        bundleInfo.set(b.name, {
            uuids: [...uuids],
            owned,
            redirect,
            deps: [...depsSet],
            atlasTextures,
        });
    }

    _cached = { bundles, roots, closures, ownerOf, bundleInfo };
    return _cached;
}

/** redirect 目标:优先选本 bundle 能服务(在其 depSet 内)的 owner;否则 priority 最高者兜底 */
function pickRedirectTarget(owners: Set<string>, serve: Set<string>, prio: Map<string, number>): string {
    let best: string | null = null;
    let bestP = -Infinity;
    for (const o of [...owners].sort()) {
        if (!serve.has(o)) continue; // 不可服务的跳过(保证健全)
        const p = prio.get(o) ?? -1;
        if (p > bestP) {
            bestP = p;
            best = o;
        }
    }
    if (best) return best;
    // 兜底:owner 都不可服务(罕见,复制冲突),取 priority 最高
    for (const o of [...owners].sort()) {
        const p = prio.get(o) ?? -1;
        if (p > bestP) {
            bestP = p;
            best = o;
        }
    }
    return best!;
}
