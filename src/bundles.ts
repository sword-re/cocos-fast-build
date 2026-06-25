/**
 * Bundle 发现:扫描 assets 下 isBundle=true 的文件夹 meta,得到 bundle 定义。
 * 以及收集资源 uuid(含 subMetas 子资源)。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { platform } from "./config.js";
import { rawMetaScan } from "./metaScan.js";

const ASSETS = join(PROJECT_ROOT, "assets");

export interface BundleDef {
    name: string; // bundleName 或文件夹名
    rootDir: string; // 绝对路径
    dbPath: string; // db://assets/...
    priority: number;
    compressionType: string; // subpackage / merge_all_json / default ...
    isRemote: boolean;
}

function readMeta(p: string): any {
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

/** 扫描所有 bundle 文件夹定义 */
export function discoverBundles(): BundleDef[] {
    const PLATFORM = platform();
    const out: BundleDef[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (!statSync(p).isDirectory()) continue;
            const meta = readMeta(p + ".meta");
            if (meta && meta.isBundle) {
                const rel = relative(ASSETS, p);
                out.push({
                    name: meta.bundleName || name,
                    rootDir: p,
                    dbPath: `db://assets/${rel}`,
                    priority: Number(meta.priority) || 0,
                    compressionType: (meta.compressionType && meta.compressionType[PLATFORM]) || "default",
                    isRemote: !!(meta.isRemoteBundle && meta.isRemoteBundle[PLATFORM]),
                });
            }
            walk(p); // bundle 可嵌套
        }
    };
    walk(ASSETS);
    return out;
}

/** 收集一个目录下所有资源 uuid(含 subMetas);派生自共享 .meta 扫描,不再重复遍历磁盘 */
export function collectUuidsUnder(dir: string): Set<string> {
    const set = new Set<string>();
    const prefix = dir + "/";
    for (const { dir: d, meta: m } of rawMetaScan()) {
        if (d !== dir && !d.startsWith(prefix)) continue;
        if (m.uuid) set.add(m.uuid);
        if (m.subMetas) for (const k in m.subMetas) if (m.subMetas[k]?.uuid) set.add(m.subMetas[k].uuid);
    }
    return set;
}
