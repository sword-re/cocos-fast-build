/**
 * 样本工具:在 build 产物里定位资源,并配对其 library 源。
 * 所有 spike 的字节对齐都依赖它找「(library 源, 真实产物)」对。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { BUILD_DIR, libraryImportPath } from "./paths.js";

export interface SamplePair {
    uuid: string;
    /** build 产物 import json 的绝对路径 */
    buildPath: string;
    /** library 源 import json 的绝对路径 */
    libraryPath: string;
    /** library 顶层 __type__(自定义对象有;预制体/场景为 undefined) */
    type: string | undefined;
}

/** 递归列出 build 产物里所有 import json */
export function listBuildImportFiles(root = BUILD_DIR): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            const st = statSync(p);
            if (st.isDirectory()) walk(p);
            else if (/\.json$/.test(name) && p.includes(`${join("import")}`)) out.push(p);
        }
    };
    walk(root);
    return out;
}

/** 从产物文件名 <uuid>.<md5>.json 提取 uuid */
export function uuidFromBuildFile(file: string): string {
    return basename(file).split(".")[0];
}

/** 配对一个 uuid 的 library 源与 build 产物 */
export function pairFor(uuid: string, buildPath: string): SamplePair {
    const libraryPath = libraryImportPath(uuid);
    let type: string | undefined;
    try {
        const lib = JSON.parse(readFileSync(libraryPath, "utf8"));
        type = lib && typeof lib === "object" ? lib.__type__ : undefined;
    } catch {
        /* library 源可能不存在(合并/生成类资源) */
    }
    return { uuid, buildPath, libraryPath, type };
}

/** 扫描所有产物,按 __type__ 归类返回样本对 */
export function collectSamples(limit = Infinity): SamplePair[] {
    const files = listBuildImportFiles();
    const out: SamplePair[] = [];
    for (const f of files) {
        out.push(pairFor(uuidFromBuildFile(f), f));
        if (out.length >= limit) break;
    }
    return out;
}

export function readJson(path: string): any {
    return JSON.parse(readFileSync(path, "utf8"));
}
