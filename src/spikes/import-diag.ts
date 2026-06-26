/** 临时诊断:归类某 importer 的 object 失败原因(对象图按元素/key 定位差异) */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importAll, importOrigin } from "../import/index.js";
import { LIBRARY_IMPORTS } from "../paths.js";
import { deepEqual } from "../util/deepEqual.js";

const TARGET = process.argv[2] || "prefab";
const all = importAll();
let shown = 0;
const reasons = new Map<string, number>();

for (const [uuid, res] of all) {
    const o = importOrigin(uuid);
    if (o?.meta?.importer !== TARGET) continue;
    const p = join(LIBRARY_IMPORTS, uuid.slice(0, 2), uuid + ".json");
    let ref: any;
    try {
        ref = JSON.parse(readFileSync(p, "utf8"));
    } catch {
        continue;
    }
    if (deepEqual(res.object, ref)) continue;
    const a = res.object, b = ref;
    let reason = "?";
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) reason = `数组长度 ${a.length} vs ${b.length}`;
        else {
            for (let i = 0; i < a.length; i++) {
                if (!deepEqual(a[i], b[i])) {
                    const keys = new Set([...Object.keys(a[i] || {}), ...Object.keys(b[i] || {})]);
                    const diffKeys = [...keys].filter((k) => !deepEqual(a[i]?.[k], b[i]?.[k]));
                    reason = `元素__type__=${a[i]?.__type__} 差异key=${diffKeys.join(",")}`;
                    if (shown < 5) {
                        console.log(`\n${o!.assetFile.replace(/.*assets./, "")}  元素[${i}] ${a[i]?.__type__}`);
                        for (const k of diffKeys) console.log(`   ${k}: mine=${JSON.stringify(a[i]?.[k])?.slice(0, 140)}  ref=${JSON.stringify(b[i]?.[k])?.slice(0, 140)}`);
                        shown++;
                    }
                    break;
                }
            }
        }
    } else {
        const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
        reason = "顶层差异key=" + [...keys].filter((k) => !deepEqual(a?.[k], b?.[k])).join(",");
    }
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
}
console.log("\n===== 失败原因归类 =====");
for (const [r, c] of [...reasons].sort((x, y) => y[1] - x[1])) console.log(`  ×${c}  ${r}`);
