/**
 * import 接线覆盖率报告:统计 libraryIndex 的资源对象有多少来自 import 主源、
 * 多少仍回退 library;并按"仍走 library 回退"的类型分桶,指引 M3/M4 优先级。
 *
 * 运行:npm run import:coverage
 */
import { importMap, importSourceCoverage } from "../libraryIndex.js";
import { importAll } from "../import/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_IMPORTS } from "../paths.js";

const cov = importSourceCoverage();
const total = cov.fromImport + cov.fromLibrary;
console.log("===== libraryIndex 数据来源 =====");
console.log(`  import 主源: ${cov.fromImport}`);
console.log(`  library 回退: ${cov.fromLibrary}`);
console.log(`  合计: ${total}  (import 覆盖率 ${((cov.fromImport / total) * 100).toFixed(1)}%)`);

// 仍走 library 回退的对象,按 __type__ 分桶
const covered = new Set(importAll().keys());
const map = importMap();
const byType = new Map<string, number>();
for (const uuid of map.keys()) {
    if (covered.has(uuid)) continue;
    let type = "?";
    try {
        const p = join(LIBRARY_IMPORTS, uuid.slice(0, 2), uuid + ".json");
        const d = JSON.parse(readFileSync(p, "utf8"));
        type = Array.isArray(d) ? d[0]?.__type__ ?? "[array]" : d.__type__ ?? "?";
    } catch {
        type = "(无 library json)";
    }
    byType.set(type, (byType.get(type) || 0) + 1);
}
console.log("\n===== 仍走 library 回退的类型(M3/M4 目标) =====");
for (const [t, c] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${t}`);
