/**
 * Spike 1a:对所有「非图集 SpriteFrame」做序列化并与真实产物字节对齐。
 * 验收:全部 PASS 即证明自定义对象(packCustomObjData)路径理解正确。
 */
import { collectSamples, readJson } from "../samples.js";
import { serializeSpriteFrame } from "../serialize/spriteFrame.js";
import { byteDiff, printDiff } from "../verify.js";

const samples = collectSamples().filter((s) => s.type === "cc.SpriteFrame");

let pass = 0;
let fail = 0;
let skippedAtlas = 0;
const failures: string[] = [];

for (const s of samples) {
    const lib = readJson(s.libraryPath);
    const bld = readJson(s.buildPath);
    // 图集 spriteframe 的 rect 被改写为图集坐标,本 spike 跳过(见 spec §2.7 / §7)
    const isAtlas = JSON.stringify(lib.content?.rect) !== JSON.stringify(bld?.[5]?.[0]?.rect);
    if (isAtlas) {
        skippedAtlas++;
        continue;
    }
    const out = serializeSpriteFrame(lib);
    const d = byteDiff(out, s.buildPath);
    if (d.equal) {
        pass++;
    } else {
        fail++;
        if (failures.length < 5) {
            failures.push(s.uuid);
            printDiff(s.uuid, d);
        }
    }
}

console.log(`\n=== Spike 1a (SpriteFrame, 非图集) ===`);
console.log(`PASS=${pass}  FAIL=${fail}  跳过(图集)=${skippedAtlas}  总样本=${samples.length}`);
process.exit(fail === 0 ? 0 : 1);
