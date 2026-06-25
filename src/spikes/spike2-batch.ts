/**
 * Spike 2 批量覆盖扫描:对全部对象图(prefab/scene)跑序列化,
 * 统计成功数 + 按 GraphUnsupported 原因归类未覆盖项,并把成功产物写入 .out/<uuid>.ours.json
 * 供桥端语义校验(spike2-verify)。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectSamples, readJson } from "../samples.js";
import { serializeAsset } from "../serialize/index.js";
import { GraphUnsupported } from "../serialize/objectGraph.js";
import { stringify } from "../verify.js";

const outDir = resolve(process.cwd(), ".out");
mkdirSync(outDir, { recursive: true });

const graphs = collectSamples().filter((s) => !s.type); // 顶层数组=对象图
let ok = 0;
const unsupported = new Map<string, number>();
const errors = new Map<string, number>();
const okList: string[] = [];

for (const s of graphs) {
    let lib: any;
    try {
        lib = readJson(s.libraryPath);
    } catch {
        continue; // library 源缺失(少数生成类资源)
    }
    try {
        const out = serializeAsset(lib);
        writeFileSync(resolve(outDir, `${s.uuid}.ours.json`), stringify(out));
        ok++;
        okList.push(`${s.uuid}\t${s.buildPath}`);
    } catch (e) {
        if (e instanceof GraphUnsupported) {
            const key = (e.message || "").replace(/: .*/, "");
            unsupported.set(key, (unsupported.get(key) ?? 0) + 1);
        } else {
            const key = (e as Error).message.split("\n")[0];
            errors.set(key, (errors.get(key) ?? 0) + 1);
        }
    }
}

writeFileSync(resolve(outDir, "_ok-list.tsv"), okList.join("\n"));

console.log(`=== Spike 2 批量覆盖(对象图 ${graphs.length} 个)===`);
console.log(`序列化成功: ${ok}`);
console.log(`\n未覆盖(GraphUnsupported):`);
for (const [k, n] of [...unsupported.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${k}`);
if (errors.size) {
    console.log(`\n其它错误:`);
    for (const [k, n] of [...errors.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${k}`);
}
console.log(`\n成功产物已写入 .out/(${ok} 个),清单 .out/_ok-list.tsv,供桥端语义校验。`);
