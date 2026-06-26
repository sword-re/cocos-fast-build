/**
 * 资源 import 入口:从 assets/** 源 + .meta 生成各 uuid 的反序列化中间对象(+ native)。
 *
 * 这是"脱离编辑器"的核心模块 —— 替代 libraryIndex.rawImport(读 library/imports)。
 * 详见 docs/fast-build/09-asset-import.md。
 *
 * 现阶段(M1)按需调用 importAll() 跑全量校验;接线切换(M2)再把 libraryIndex 三出口改由此供数。
 */
import { rawMetaScan, type MetaRecord } from "../metaScan.js";
import { importerFor } from "./registry.js";
import { builtinImports } from "./builtin.js";
import type { ImportResult } from "./types.js";

let _cache: Map<string, ImportResult> | null = null;
/** uuid -> 它来自哪条主 meta(调试/归属用) */
let _origin: Map<string, MetaRecord> | null = null;

/**
 * 跑全部已注册 importer,产出 uuid -> ImportResult。结果缓存。
 * 未实现的 importer 跳过(覆盖率由 spike 统计)。
 */
export function importAll(): Map<string, ImportResult> {
    if (_cache) return _cache;
    const out = new Map<string, ImportResult>();
    const origin = new Map<string, MetaRecord>();
    for (const rec of rawMetaScan()) {
        const m = rec.meta;
        if (!m?.uuid || !m.importer) continue;
        const imp = importerFor(m.importer);
        if (!imp) continue;
        let results: Map<string, ImportResult>;
        try {
            results = imp.import({ uuid: m.uuid, meta: m, srcPath: rec.assetFile, importer: m.importer, record: rec });
        } catch {
            continue; // 单资源失败不拖垮全量;校验台会显示缺口
        }
        for (const [u, r] of results) {
            out.set(u, r);
            origin.set(u, rec);
        }
    }
    // 引擎内置(无项目 meta)从快照补入(不覆盖已由 importer 生成的)
    for (const [u, r] of builtinImports()) if (!out.has(u)) out.set(u, r);
    _cache = out;
    _origin = origin;
    return out;
}

/** 单个 uuid 的 import 产物(命中全量缓存) */
export function importAsset(uuid: string): ImportResult | undefined {
    return importAll().get(uuid);
}

export function importOrigin(uuid: string): MetaRecord | undefined {
    importAll();
    return _origin!.get(uuid);
}
