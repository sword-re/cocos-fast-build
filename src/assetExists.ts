/**
 * 资源存在性检查(用于剔除指向已删除资源的悬空引用)。
 *
 * 【脱离 library】原依据"library/imports/<uuid>.json 存在"。现改为等价的、不读 library 的判据:
 *   存在 = import 模块产出(含引擎内置快照)∪ auto-atlas 合成图集(.pac,有 meta、由 assemble 合成,
 *   不在 import 产出里但确为存在资源)。
 * 该集合与原 library import 集等价;悬空引用(无源、非内置、非图集)不在其中 → 正确剔除。
 * 合成图集大图(synthetic)由调用方单独处理,不经此函数。
 *
 * 注意:不能用 hasPhysicalAsset(有 .meta)替代 —— 它含未被编辑器 import 的 meta(子资源/失败项),
 * 比原 library 集更宽,会撑大闭包改变归属。
 */
import { importAll } from "./import/index.js";
import { rawMetaScan } from "./metaScan.js";

let _set: Set<string> | null = null;

function buildSet(): Set<string> {
    const s = new Set<string>(importAll().keys());
    for (const { meta } of rawMetaScan()) {
        if (meta?.importer === "auto-atlas" && meta.uuid) s.add(meta.uuid);
    }
    return s;
}

export function assetExists(uuid: string): boolean {
    if (!_set) _set = buildSet();
    return _set.has(uuid);
}
