/**
 * Spike 3:端到端组装一个最小自洽 bundle 并验证。
 * 选取已字节对齐的叶子资源(Texture2D/SpriteFrame/Material),生成 import+native+config,
 * 校验:① 我们的 import 与真实产物逐字节一致 ② md5 命名正确 ③ config.versions 引用的文件都存在。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { collectSamples, readJson } from "../samples.js";
import { serializeAsset } from "../serialize/index.js";
import { stringify } from "../verify.js";
import { generateBundle, md5hex5 } from "../bundle.js";

// 选取若干字节对齐的叶子资源作为成员
const wanted: Record<string, number> = { "cc.Texture2D": 2, "cc.SpriteFrame": 2, "cc.Material": 1 };
const picked: string[] = [];
const realByUuid = new Map<string, string>();

for (const s of collectSamples()) {
    if (!s.type || !(s.type in wanted) || wanted[s.type] <= 0) continue;
    let lib: any;
    try {
        lib = readJson(s.libraryPath);
    } catch {
        continue;
    }
    // 仅选我们能字节对齐的(与真实产物一致)
    let ours: string;
    try {
        ours = stringify(serializeAsset(lib));
    } catch {
        continue;
    }
    const real = readFileSync(s.buildPath, "utf8");
    if (ours !== real) continue;
    picked.push(s.uuid);
    realByUuid.set(s.uuid, s.buildPath);
    wanted[s.type]--;
}

console.log(`选中 ${picked.length} 个字节对齐叶子资源组装 bundle`);

const outRoot = resolve(process.cwd(), ".out/bundles");
const res = generateBundle("MiniBundle", picked, outRoot);

// 校验
let byteOk = 0;
for (const f of res.importFiles) {
    const ours = readFileSync(f.path, "utf8");
    const real = readFileSync(realByUuid.get(f.uuid)!, "utf8");
    if (ours === real) byteOk++;
    // md5 命名自校验
    if (md5hex5(ours) !== f.md5) console.log(`✗ md5 不符: ${f.uuid}`);
}

// config.versions 引用的文件存在性
let refOk = true;
const imp = res.config.versions.import as (string | number)[];
for (let i = 0; i < imp.length; i += 2) {
    const idx = imp[i] as number;
    const md5 = imp[i + 1] as string;
    const uuid = picked[idx];
    const p = join(res.outDir, "import", uuid.slice(0, 2), `${uuid}.${md5}.json`);
    if (!existsSync(p)) {
        refOk = false;
        console.log(`✗ versions.import 引用缺失: ${p}`);
    }
}

console.log(`\n=== Spike 3 结果 ===`);
console.log(`bundle 目录: ${res.outDir}`);
console.log(`config: ${res.configPath.replace(dirname(res.outDir) + "/", "")}`);
console.log(`import 文件: ${res.importFiles.length}(与真实逐字节一致: ${byteOk}/${res.importFiles.length})`);
console.log(`native 文件: ${res.nativeFiles.length}`);
console.log(`config.versions 引用文件齐全: ${refOk ? "✅" : "❌"}`);
console.log(`config.md5 自校验: ${md5hex5(stringify(res.config)) === res.configPath.match(/config\.(\w+)\.json/)![1] ? "✅" : "❌"}`);
console.log(`\nconfig 内容:\n${JSON.stringify(res.config, null, 1)}`);
