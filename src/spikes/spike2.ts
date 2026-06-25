/**
 * Spike 2:对象图(prefab)序列化。
 * 用法:tsx src/spikes/spike2.ts [uuid]
 * 默认用最小预制体 b439083f。输出我们的产物 + 真实产物,并把我们的产物写到 .out/ 供桥语义校验。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectSamples, readJson } from "../samples.js";
import { serializeAsset } from "../serialize/index.js";
import { stringify, byteDiff, printDiff } from "../verify.js";

const targetUuid = process.argv[2] ?? "b439083f-870a-4cd0-abba-79dd5d2ced7d";

const sample = collectSamples().find((s) => s.uuid === targetUuid);
if (!sample) {
    console.log(`找不到样本 ${targetUuid}`);
    process.exit(1);
}

const lib = readJson(sample.libraryPath);
const out = serializeAsset(lib);
const ourStr = stringify(out);

const outDir = resolve(process.cwd(), ".out");
mkdirSync(outDir, { recursive: true });
const ourFile = resolve(outDir, `${targetUuid}.ours.json`);
writeFileSync(ourFile, ourStr);

console.log(`样本: ${targetUuid}`);
console.log(`真实产物: ${sample.buildPath}`);
console.log(`我们的产物: ${ourFile}`);
console.log(`\n--- 我们的产物 ---\n${ourStr}`);
const d = byteDiff(out, sample.buildPath);
console.log("");
printDiff("byte-diff", d);
console.log(`\n（字节不一致是预期的;生死判据是语义等价 —— 用桥反序列化深比较 ${ourFile} 与真实产物）`);
