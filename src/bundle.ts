/**
 * 最小 bundle 组装器(spike 3)。
 * 给定资源成员列表,生成 import/ + native/ + config.<md5>.json,md5 命名正确。
 *
 * 简化范围(自洽 bundle):不做 packs 合并 / 依赖爬取 / paths 推导 / 脚本打包,
 * 这些是独立子系统(见 docs/fast-build/04-bundle-config.md)。
 *
 * md5 规则:文件名 hash = md5(文件内容) 前 5 位(import/native/config 同)。
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_IMPORTS, libraryImportPath } from "./paths.js";
import { compressUuid } from "./uuid.js";
import { serializeAsset } from "./serialize/index.js";
import { readJson } from "./samples.js";
import { stringify } from "./verify.js";

export function md5hex5(content: string | Buffer): string {
    return createHash("md5").update(content).digest("hex").slice(0, 5);
}

/** library 中某 uuid 的 native 原始文件(与 import json 同目录的非 .json 同名文件) */
function findNative(uuid: string): { ext: string; path: string } | null {
    const dir = join(LIBRARY_IMPORTS, uuid.slice(0, 2));
    let files: string[];
    try {
        files = readdirSync(dir);
    } catch {
        return null;
    }
    for (const f of files) {
        if (f.startsWith(uuid + ".") && !f.endsWith(".json")) {
            return { ext: f.slice(uuid.length + 1), path: join(dir, f) };
        }
    }
    return null;
}

export interface BundleResult {
    name: string;
    outDir: string;
    importFiles: Array<{ uuid: string; md5: string; path: string; bytes: number }>;
    nativeFiles: Array<{ uuid: string; md5: string; path: string }>;
    configPath: string;
    config: any;
}

/** 生成一个自洽 bundle(无 packs/deps/scenes/paths) */
export function generateBundle(name: string, uuids: string[], outRoot: string): BundleResult {
    const outDir = join(outRoot, name);
    const importDir = join(outDir, "import");
    const nativeDir = join(outDir, "native");
    mkdirSync(importDir, { recursive: true });

    const importVersions: (string | number)[] = [];
    const nativeVersions: (string | number)[] = [];
    const importFiles: BundleResult["importFiles"] = [];
    const nativeFiles: BundleResult["nativeFiles"] = [];

    uuids.forEach((uuid, idx) => {
        // import
        const lib = readJson(libraryImportPath(uuid));
        const content = stringify(serializeAsset(lib));
        const md5 = md5hex5(content);
        const sub = uuid.slice(0, 2);
        mkdirSync(join(importDir, sub), { recursive: true });
        const p = join(importDir, sub, `${uuid}.${md5}.json`);
        writeFileSync(p, content);
        importVersions.push(idx, md5);
        importFiles.push({ uuid, md5, path: p, bytes: content.length });

        // native
        const nat = findNative(uuid);
        if (nat) {
            const buf = readFileSync(nat.path);
            const nmd5 = md5hex5(buf);
            mkdirSync(join(nativeDir, sub), { recursive: true });
            const np = join(nativeDir, sub, `${uuid}.${nmd5}.${nat.ext}`);
            copyFileSync(nat.path, np);
            nativeVersions.push(idx, nmd5);
            nativeFiles.push({ uuid, md5: nmd5, path: np });
        }
    });

    const config = {
        paths: {},
        types: [],
        uuids: uuids.map(compressUuid),
        scenes: {},
        redirect: [],
        packs: {},
        name,
        importBase: "import",
        nativeBase: "native",
        debug: false,
        isZip: false,
        encrypted: false,
        versions: { import: importVersions, native: nativeVersions },
    };
    const configStr = stringify(config);
    const configMd5 = md5hex5(configStr);
    const configPath = join(outDir, `config.${configMd5}.json`);
    writeFileSync(configPath, configStr);

    return { name, outDir, importFiles, nativeFiles, configPath, config };
}
