/**
 * 图集帧几何校验:对每个被缓存覆盖的图集 spriteframe,比较我们与真实产物的 content
 * (name/rect/offset/originalSize/rotated/capInsets)。texture 在依赖表、不在 content,
 * 故 content 相等 = 几何完全正确(texture id 自洽、与 cocos 不同属预期)。
 */
import { readFileSync } from "node:fs";
import { collectSamples, readJson } from "../samples.js";
import { serializeAsset } from "../serialize/index.js";
import { atlasFrameMap } from "../atlas.js";

const map = atlasFrameMap();
let pass = 0,
    fail = 0;
const fails: string[] = [];

for (const s of collectSamples()) {
    if (s.type !== "cc.SpriteFrame" || !map.has(s.uuid)) continue;
    let lib: any;
    try {
        lib = readJson(s.libraryPath);
    } catch {
        continue;
    }
    const ourContent = serializeAsset(lib, s.uuid)[5][0];
    const realContent = JSON.parse(readFileSync(s.buildPath, "utf8"))[5][0];
    if (JSON.stringify(ourContent) === JSON.stringify(realContent)) pass++;
    else {
        fail++;
        if (fails.length < 8) fails.push(`${s.uuid}\n    ours: ${JSON.stringify(ourContent)}\n    real: ${JSON.stringify(realContent)}`);
    }
}

console.log(`=== 图集帧几何校验 ===`);
console.log(`content 完全一致: ${pass}  不一致: ${fail}`);
for (const f of fails) console.log("  " + f);
process.exit(fail === 0 ? 0 : 1);
