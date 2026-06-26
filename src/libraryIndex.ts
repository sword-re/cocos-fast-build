/**
 * 资源对象的统一索引(import 模块为主源,library/imports 为回退)。
 *
 * 【M2 接线切换】本模块的三个出口(rawImport / importMap / nativeExtMap)原先全部从
 * cocos 编辑器预导入的 library/imports 取数。现改为:
 *  - 主源:import 模块(src/import,从 assets 源 + .meta 自生成,见 docs/09)覆盖的 uuid;
 *  - 回退:import 尚未实现的类型(effect/spine/bitmap-font/plist 图集/引擎内置无 meta 资源)
 *    才读 library/imports —— 且**只解析未被 import 覆盖的那部分** json(减少 library 读盘)。
 * import 覆盖率随 M3/M4 推进而升,library 回退趋零;全部覆盖后即可彻底删除 library 读。
 *
 * toRec() 从对象抽 { type, name, deps },对 import 对象与 library 对象同构,故 crawl/assetGraph
 * 的依赖图/类型查询逻辑零改动。
 *
 * 同步/异步双模:primeLibraryIndex() 构建前并行预热;importMap()/nativeExtMap() 同步取,
 * 未预热则单线程回退,保证任何调用路径都正确。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_IMPORTS, libraryImportPath } from "./paths.js";
import { parseFiles } from "./parallelParse.js";
import { importAll } from "./import/index.js";

export interface ImportRec {
    /** library import 的 __type__(无则 null) */
    type: string | null;
    /** _name(内置 effect/material 判定用,无则 null) */
    name: string | null;
    /** 直接依赖:递归出现的所有 __uuid__ + SpriteFrame 的 content.texture(已去自身,未含图集成员) */
    deps: Set<string>;
}

/** 桶 readdir:import json 路径(+ 其 uuid) 与 native 扩展名表 */
function scanBuckets(): { uuids: string[]; paths: string[]; nativeExt: Map<string, string> } {
    const uuids: string[] = [];
    const paths: string[] = [];
    const nativeExt = new Map<string, string>();
    let buckets: string[] = [];
    try {
        buckets = readdirSync(LIBRARY_IMPORTS);
    } catch {
        return { uuids, paths, nativeExt };
    }
    for (const b of buckets) {
        let files: string[];
        try {
            files = readdirSync(join(LIBRARY_IMPORTS, b));
        } catch {
            continue;
        }
        for (const f of files) {
            if (f.endsWith(".json")) {
                uuids.push(f.slice(0, -".json".length));
                paths.push(join(LIBRARY_IMPORTS, b, f));
            } else {
                // native 文件 <uuid>.<ext>;uuid 不含 '.',首个 '.' 即分界
                const dot = f.indexOf(".");
                if (dot <= 0) continue;
                const u = f.slice(0, dot);
                if (!nativeExt.has(u)) nativeExt.set(u, f.slice(dot)); // 含前导点,与旧 nativeExtOf 一致
            }
        }
    }
    return { uuids, paths, nativeExt };
}

/** 从解析后的 import json 抽出 ImportRec(复刻 directDeps 的依赖收集语义) */
function toRec(uuid: string, data: any): ImportRec {
    const deps = new Set<string>();
    if (data && typeof data === "object") {
        const visit = (v: any) => {
            if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v === "object") {
                if (typeof v.__uuid__ === "string") deps.add(v.__uuid__);
                else for (const k in v) visit(v[k]);
            }
        };
        visit(data);
        // SpriteFrame 的纹理引用是 content.texture(裸 uuid 字符串,非 __uuid__)
        if (data.__type__ === "cc.SpriteFrame" && typeof data.content?.texture === "string" && data.content.texture) {
            deps.add(data.content.texture);
        }
    }
    deps.delete(uuid);
    const type = data && typeof data === "object" && !Array.isArray(data) && typeof data.__type__ === "string" ? data.__type__ : null;
    const name = data && typeof data === "object" && typeof data._name === "string" ? data._name : null;
    return { type, name, deps };
}

let _importMap: Map<string, ImportRec> | null = null;
let _nativeExt: Map<string, string> | null = null;
/** 原始解析后的资源对象(import 为主 + library 回退;供 assemble 序列化复用) */
let _raw: Map<string, any> | null = null;
/** 数据来源统计(供 import:coverage 报告) */
let _coverage: { fromImport: number; fromLibrary: number } = { fromImport: 0, fromLibrary: 0 };

/**
 * 合并 import 模块(主源)与已解析的 library 回退对象,装配最终三表。
 * @param libParsed 已解析的 library 回退对象(只含未被 import 覆盖的 uuid)
 * @param libNativeExt scanBuckets 得到的 native 扩展名表(覆盖全部 library native)
 */
function assembleMaps(libParsed: Map<string, any>, libNativeExt: Map<string, string>): void {
    const map = new Map<string, ImportRec>();
    const raw = new Map<string, any>();
    const nativeExt = new Map(libNativeExt);

    // 主源:import 模块产出的中间对象
    let fromImport = 0;
    for (const [uuid, res] of importAll()) {
        raw.set(uuid, res.object);
        map.set(uuid, toRec(uuid, res.object));
        if (res.native?.kind === "flat") nativeExt.set(uuid, res.native.ext);
        fromImport++;
    }
    // 回退:import 未覆盖的 library 对象
    let fromLibrary = 0;
    for (const [uuid, data] of libParsed) {
        if (raw.has(uuid)) continue;
        raw.set(uuid, data);
        map.set(uuid, toRec(uuid, data));
        fromLibrary++;
    }
    _importMap = map;
    _nativeExt = nativeExt;
    _raw = raw;
    _coverage = { fromImport, fromLibrary };
}

/** import 覆盖的 uuid 集(用于跳过 library 中已覆盖部分的解析) */
function coveredUuids(): Set<string> {
    return new Set(importAll().keys());
}

function buildSync(): void {
    const { uuids, paths, nativeExt } = scanBuckets();
    const covered = coveredUuids();
    const libParsed = new Map<string, any>();
    for (let i = 0; i < paths.length; i++) {
        if (covered.has(uuids[i])) continue; // import 已覆盖:不读 library
        try {
            libParsed.set(uuids[i], JSON.parse(readFileSync(paths[i], "utf8")));
        } catch {
            /* 跳过坏 json */
        }
    }
    assembleMaps(libParsed, nativeExt);
}

/** 预热:并行 read+parse library 回退 json(仅未被 import 覆盖的部分) */
export async function primeLibraryIndex(): Promise<void> {
    if (_importMap) return;
    const { uuids, paths, nativeExt } = scanBuckets();
    const covered = coveredUuids();
    const idx: number[] = [];
    const toParse: string[] = [];
    for (let i = 0; i < paths.length; i++) {
        if (covered.has(uuids[i])) continue;
        idx.push(i);
        toParse.push(paths[i]);
    }
    const parsed = await parseFiles(toParse);
    const libParsed = new Map<string, any>();
    for (let j = 0; j < toParse.length; j++) {
        if (parsed[j] == null) continue;
        libParsed.set(uuids[idx[j]], parsed[j]);
    }
    assembleMaps(libParsed, nativeExt);
}

/** 数据来源统计:import 主源命中数 vs library 回退数 */
export function importSourceCoverage(): { fromImport: number; fromLibrary: number } {
    if (!_importMap) buildSync();
    return _coverage;
}

/**
 * 原始 import json(已解析)。命中预热缓存则免去再次读盘;未缓存(合成/缺失)则回退到读文件,
 * 与旧 readJson(libraryImportPath(uuid)) 行为一致(缺失时抛错,供调用方走 skip 分支)。
 */
export function rawImport(uuid: string): any {
    const r = _raw ?? (buildSync(), _raw)!;
    if (r.has(uuid)) return r.get(uuid);
    return JSON.parse(readFileSync(libraryImportPath(uuid), "utf8"));
}

/** uuid -> ImportRec(无 import 返回 undefined);未预热则单线程回退构建 */
export function importMap(): Map<string, ImportRec> {
    if (!_importMap) buildSync();
    return _importMap!;
}

/** uuid -> native 扩展名(含前导点;无则 undefined) */
export function nativeExtMap(): Map<string, string> {
    if (!_nativeExt) buildSync();
    return _nativeExt!;
}
