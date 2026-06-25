/**
 * library/imports 的统一索引(一趟读盘,可并行解析)。
 *
 * 原先 typeFromImport(每个 asset 一次)与 directDeps(图遍历每个可达资源一次)各自
 * read+parse 同一批 library import;nativeExtOf 还对每个 uuid 做一次 readdirSync(实际只有
 * ~258 个桶)。此模块:
 *  - 把 258 个桶 readdir 一次,得到 import json 路径表 + native 扩展名表;
 *  - 并行 read+parse 全部 import json,抽出 { type, name, deps },供图遍历/类型查询内存命中。
 *
 * 同步/异步双模:primeLibraryIndex() 构建前并行预热;importMap()/nativeExtMap() 同步取,
 * 未预热则单线程回退,保证任何调用路径都正确。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_IMPORTS, libraryImportPath } from "./paths.js";
import { parseFiles } from "./parallelParse.js";

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
/** 原始解析后的 import json(供 assemble 序列化复用,免去第三次读盘) */
let _raw: Map<string, any> | null = null;

function buildSync(): void {
    const { uuids, paths, nativeExt } = scanBuckets();
    const map = new Map<string, ImportRec>();
    const raw = new Map<string, any>();
    for (let i = 0; i < paths.length; i++) {
        let data: any;
        try {
            data = JSON.parse(readFileSync(paths[i], "utf8"));
        } catch {
            continue;
        }
        map.set(uuids[i], toRec(uuids[i], data));
        raw.set(uuids[i], data);
    }
    _importMap = map;
    _nativeExt = nativeExt;
    _raw = raw;
}

/** 预热:并行 read+parse 全部 import json(构建前调用) */
export async function primeLibraryIndex(): Promise<void> {
    if (_importMap) return;
    const { uuids, paths, nativeExt } = scanBuckets();
    const parsed = await parseFiles(paths);
    const map = new Map<string, ImportRec>();
    const raw = new Map<string, any>();
    for (let i = 0; i < paths.length; i++) {
        if (parsed[i] == null) continue;
        map.set(uuids[i], toRec(uuids[i], parsed[i]));
        raw.set(uuids[i], parsed[i]);
    }
    _importMap = map;
    _nativeExt = nativeExt;
    _raw = raw;
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
