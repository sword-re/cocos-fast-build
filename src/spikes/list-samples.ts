/** 扫描 build 产物,按 __type__ 统计样本对,并示例打印非图集 SpriteFrame */
import { collectSamples, readJson } from "../samples.js";

const samples = collectSamples();
const byType = new Map<string, number>();
for (const s of samples) {
    const key = s.type ?? "(对象图: prefab/scene)";
    byType.set(key, (byType.get(key) ?? 0) + 1);
}
console.log(`共 ${samples.length} 个 import 产物,类型分布:`);
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(5)}  ${t}`);
}

// 示例:找第一个非图集 spriteframe(library rect == build instance rect)
for (const s of samples) {
    if (s.type !== "cc.SpriteFrame") continue;
    const lib = readJson(s.libraryPath);
    const bld = readJson(s.buildPath);
    if (JSON.stringify(lib.content?.rect) === JSON.stringify(bld?.[5]?.[0]?.rect)) {
        console.log(`\n非图集 SpriteFrame 样本: ${s.uuid}`);
        console.log(`  build: ${s.buildPath}`);
        break;
    }
}
