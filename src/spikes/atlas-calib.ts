/** 图集 rect/offset/rotated 公式标定:对照缓存几何与真实 spriteframe 内容 */
import { readFileSync } from "node:fs";
import { collectSamples, readJson } from "../samples.js";
import { serializeAsset } from "../serialize/index.js";
import { stringify } from "../verify.js";
import { atlasFrameMap } from "../atlas.js";

const map = atlasFrameMap();
let shown = 0;
for (const s of collectSamples()) {
    if (s.type !== "cc.SpriteFrame") continue;
    const fr = map.get(s.uuid);
    if (!fr) continue;
    let lib: any;
    try {
        lib = readJson(s.libraryPath);
    } catch {
        continue;
    }
    if (stringify(serializeAsset(lib)) === readFileSync(s.buildPath, "utf8")) continue; // 跳过非图集
    const real = JSON.parse(readFileSync(s.buildPath, "utf8"));
    const content = real[5] && real[5][0];
    console.log(`\n#### ${s.uuid}  (${fr.atlasName})`);
    console.log(`  缓存: x=${fr.x} y=${fr.y} w=${fr.width} h=${fr.height} rotW=${fr.rotatedWidth} rotH=${fr.rotatedHeight} raw=${fr.rawWidth}x${fr.rawHeight} rotated=${fr.rotated}`);
    console.log(`  缓存.trim: ${JSON.stringify(fr.trim)}  atlas=${fr.atlasWidth}x${fr.atlasHeight}`);
    console.log(`  真实content: ${JSON.stringify(content)}`);
    if (++shown >= 6) break;
}
