/**
 * 资源存在性检查。
 * 编辑器构建会丢弃指向已删除资源的悬空引用(dangling reference);
 * 我们据此跳过 library 中不存在的 uuid。
 *
 * 依据:library/imports/<2hex>/<uuid>.json 存在即资源存在。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_IMPORTS } from "./paths.js";

let _set: Set<string> | null = null;

function buildSet(): Set<string> {
    const set = new Set<string>();
    let subdirs: string[] = [];
    try {
        subdirs = readdirSync(LIBRARY_IMPORTS);
    } catch {
        return set;
    }
    for (const sub of subdirs) {
        const dir = join(LIBRARY_IMPORTS, sub);
        let files: string[];
        try {
            files = readdirSync(dir);
        } catch {
            continue;
        }
        for (const f of files) {
            if (f.endsWith(".json")) set.add(f.slice(0, -5)); // 去掉 .json,得到 uuid
        }
    }
    return set;
}

export function assetExists(uuid: string): boolean {
    if (!_set) _set = buildSet();
    if (_set.has(uuid)) return true;
    // 兜底:个别资源可能不在内存集合里时按需查盘
    return existsSync(join(LIBRARY_IMPORTS, uuid.slice(0, 2), `${uuid}.json`));
}
