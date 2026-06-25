/**
 * Bundle 发现校验:列出发现的 bundle,并对每个比较"物理成员(文件夹下所有资源 uuid)"
 * 与真实 config.uuids,量化 redirect(real有我无=依赖bundle里的)/ filtered(我有real无=未用被剔)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { discoverBundles, collectUuidsUnder } from "../bundles.js";
import { decompressUuid } from "../uuid.js";
import { BUILD_DIR } from "../paths.js";

// 读取真实 config.uuids(解压成标准 uuid)
function realConfigUuids(bundleName: string): Set<string> | null {
    for (const base of ["assets", "subpackages", "remote"]) {
        const dir = join(BUILD_DIR, base, bundleName);
        let files: string[];
        try {
            files = readdirSync(dir);
        } catch {
            continue;
        }
        const cfg = files.find((f) => f.startsWith("config."));
        if (!cfg) continue;
        const d = JSON.parse(readFileSync(join(dir, cfg), "utf8"));
        return new Set((d.uuids as string[]).map(decompressUuid));
    }
    return null;
}

const bundles = discoverBundles().sort((a, b) => b.priority - a.priority);
console.log(`发现 ${bundles.length} 个 bundle:\n`);
for (const b of bundles) {
    const phys = collectUuidsUnder(b.rootDir);
    const real = realConfigUuids(b.name);
    if (!real) {
        console.log(`  ${b.name.padEnd(16)} p${b.priority} ${b.compressionType}${b.isRemote ? " [remote]" : ""}  物理=${phys.size}  (无真实config对照)`);
        continue;
    }
    let inBoth = 0;
    for (const u of real) if (phys.has(u)) inBoth++;
    const realOnly = real.size - inBoth; // redirect:引用了但不在本文件夹(在依赖bundle)
    const physOnly = phys.size - inBoth; // 未被引用/被过滤,或在子bundle
    console.log(
        `  ${b.name.padEnd(16)} p${b.priority} ${b.compressionType.padEnd(14)}${b.isRemote ? "[remote] " : ""}` +
            `real=${real.size} 物理=${phys.size} 命中=${inBoth} redirect(real独有)=${realOnly} 物理独有=${physOnly}`
    );
}
