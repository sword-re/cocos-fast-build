/**
 * Spike 1b:对所有叶子资源(含 __type__)走分发器序列化,按类型统计字节对齐。
 * 覆盖通用 CCClass 路径(TextAsset/AudioClip/Material/...)+ 自定义路径(Texture2D/SpriteFrame)。
 * 图集 SpriteFrame(rect 被改写)单独计入 skip。
 */
import { collectSamples, readJson } from "../samples.js";
import { serializeAsset, UnsupportedAsset } from "../serialize/index.js";
import { byteDiff } from "../verify.js";

interface Stat {
    pass: number;
    fail: number;
    skipAtlas: number;
    unsupported: number;
    failSamples: string[];
}
const stats = new Map<string, Stat>();
const stat = (t: string) => {
    let s = stats.get(t);
    if (!s) stats.set(t, (s = { pass: 0, fail: 0, skipAtlas: 0, unsupported: 0, failSamples: [] }));
    return s;
};

for (const sample of collectSamples()) {
    const type = sample.type ?? "(对象图)";
    const s = stat(type);
    if (!sample.type) {
        s.unsupported++;
        continue;
    }
    const lib = readJson(sample.libraryPath);
    const bld = readJson(sample.buildPath);

    // 图集 spriteframe:rect 被改写为图集坐标,本轮跳过
    if (sample.type === "cc.SpriteFrame") {
        const isAtlas = JSON.stringify(lib.content?.rect) !== JSON.stringify(bld?.[5]?.[0]?.rect);
        if (isAtlas) {
            s.skipAtlas++;
            continue;
        }
    }

    try {
        const out = serializeAsset(lib);
        const d = byteDiff(out, sample.buildPath);
        if (d.equal) s.pass++;
        else {
            s.fail++;
            if (s.failSamples.length < 3) s.failSamples.push(sample.uuid);
        }
    } catch (e) {
        if (e instanceof UnsupportedAsset) s.unsupported++;
        else {
            s.fail++;
            if (s.failSamples.length < 3) s.failSamples.push(`${sample.uuid} (${(e as Error).message})`);
        }
    }
}

console.log("=== Spike 1b 按类型字节对齐 ===");
let totalPass = 0;
let totalFail = 0;
for (const [type, s] of [...stats.entries()].sort()) {
    totalPass += s.pass;
    totalFail += s.fail;
    const flag = s.fail > 0 ? "❌" : s.pass > 0 ? "✅" : "  ";
    console.log(
        `${flag} ${type.padEnd(18)} pass=${s.pass} fail=${s.fail} skipAtlas=${s.skipAtlas} unsupported=${s.unsupported}`
    );
    for (const f of s.failSamples) console.log(`      fail: ${f}`);
}
console.log(`\n合计 PASS=${totalPass} FAIL=${totalFail}`);
process.exit(totalFail === 0 ? 0 : 1);
