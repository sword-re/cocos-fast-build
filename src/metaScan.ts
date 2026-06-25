/**
 * assets/ 下 .meta 的统一扫描(一趟读盘,可并行解析)。
 *
 * 原先 assetMetaMap / uuidDirMap / atlasMembersMap / collectUuidsUnder 各自全量遍历
 * assets/ 并重复 read+parse 同一批 ~5000 个 .meta(实测 ~3 趟以上)。此模块只扫一次,
 * 把解析结果缓存,各消费者从内存派生自己的映射。
 *
 * 同步/异步双模:
 *  - primeMetaScan():构建前预热,用 worker 池并行 read+parse(crawl 阶段的并行优化入口)。
 *  - rawMetaScan():同步取;未预热时回退到单线程扫描(保证任何调用路径都正确)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { parseFiles } from "./parallelParse.js";

const ASSETS = join(PROJECT_ROOT, "assets");

export interface MetaRecord {
    /** .meta 所在目录绝对路径 */
    dir: string;
    /** 资源文件绝对路径(.meta 去掉 .meta 后缀) */
    assetFile: string;
    /** 解析后的 .meta 对象 */
    meta: any;
}

/** 递归收集 assets 下所有 .meta 的绝对路径 + 所在目录 */
function enumerateMetaPaths(): { path: string; dir: string }[] {
    const out: { path: string; dir: string }[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) walk(join(dir, e.name));
            else if (e.name.endsWith(".meta")) out.push({ path: join(dir, e.name), dir });
        }
    };
    walk(ASSETS);
    return out;
}

let _records: MetaRecord[] | null = null;

/** 预热:并行 read+parse 全部 .meta(构建前调用) */
export async function primeMetaScan(): Promise<void> {
    if (_records) return;
    const entries = enumerateMetaPaths();
    const parsed = await parseFiles(entries.map((e) => e.path));
    const recs: MetaRecord[] = [];
    for (let i = 0; i < entries.length; i++) {
        const meta = parsed[i];
        if (!meta) continue;
        recs.push({ dir: entries[i].dir, assetFile: entries[i].path.slice(0, -".meta".length), meta });
    }
    _records = recs;
}

/** 同步取全部 .meta 记录;未预热则单线程回退扫描 */
export function rawMetaScan(): MetaRecord[] {
    if (_records) return _records;
    const recs: MetaRecord[] = [];
    for (const { path, dir } of enumerateMetaPaths()) {
        let meta: any;
        try {
            meta = JSON.parse(readFileSync(path, "utf8"));
        } catch {
            continue;
        }
        recs.push({ dir, assetFile: path.slice(0, -".meta".length), meta });
    }
    return (_records = recs);
}
