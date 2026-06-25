/**
 * 图集缓存覆盖检查:找出所有"失败的图集 spriteframe"(我们的序列化与真实不同的 SpriteFrame),
 * 验证 temp/TexturePacker 缓存映射是否覆盖它们 —— 决定"复用缓存"路线是否可行。
 */
import { readFileSync } from "node:fs";
import { collectSamples, readJson } from "../samples.js";
import { serializeAsset } from "../serialize/index.js";
import { stringify } from "../verify.js";
import { atlasFrameMap } from "../atlas.js";

const map = atlasFrameMap();
console.log(`图集缓存:共 ${map.size} 个 spriteframe 几何记录`);

let atlasFail = 0;
let covered = 0;
const missing: string[] = [];

for (const s of collectSamples()) {
    if (s.type !== "cc.SpriteFrame") continue;
    let lib: any;
    try {
        lib = readJson(s.libraryPath);
    } catch {
        continue;
    }
    const ours = stringify(serializeAsset(lib));
    const real = readFileSync(s.buildPath, "utf8");
    if (ours === real) continue; // 非图集帧(字节一致)
    atlasFail++;
    if (map.has(s.uuid)) covered++;
    else if (missing.length < 10) missing.push(s.uuid);
}

console.log(`\n失败的图集 spriteframe: ${atlasFail}`);
console.log(`被缓存覆盖: ${covered}/${atlasFail} (${((covered / atlasFail) * 100).toFixed(1)}%)`);
if (missing.length) console.log(`未覆盖样例:\n  ${missing.join("\n  ")}`);
else console.log(`✅ 全部被缓存覆盖,"复用缓存"路线可行`);
