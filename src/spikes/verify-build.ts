/**
 * 就地验证:把我们重建的【对象图 + 字节一致的叶子资源】覆盖进一份真实 build 拷贝。
 * 文件名保持不变(运行时按 config 里的名字取文件、不校验 md5),图集帧/packs/脚本/样板保持真实。
 * 用法:tsx src/spikes/verify-build.ts <verifyBuildDir>
 * 之后用微信开发者工具打开 <verifyBuildDir> 加载整包,验证我们的序列化是否正确。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { libraryImportPath } from "../paths.js";
import { serializeAsset } from "../serialize/index.js";
import { stringify } from "../verify.js";

const verifyDir = process.argv[2];
if (!verifyDir) {
    console.log("用法: tsx src/spikes/verify-build.ts <verifyBuildDir>");
    process.exit(1);
}

function walkImports(root: string): string[] {
    const out: string[] = [];
    const rec = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) rec(p);
            else if (name.endsWith(".json") && p.includes(join("import"))) out.push(p);
        }
    };
    rec(root);
    return out;
}

const files = walkImports(verifyDir);
let overwriteGraph = 0,
    overwriteByte = 0,
    skipAtlasLeaf = 0,
    skipPack = 0,
    skipNoLib = 0,
    skipErr = 0;

for (const f of files) {
    const uuid = basename(f).split(".")[0];
    if (!uuid.includes("-")) {
        skipPack++;
        continue;
    } // pack 文件
    let lib: any;
    try {
        lib = JSON.parse(readFileSync(libraryImportPath(uuid), "utf8"));
    } catch {
        skipNoLib++;
        continue;
    }
    let ours: string;
    try {
        ours = stringify(serializeAsset(lib));
    } catch {
        skipErr++;
        continue;
    }
    const isGraph = Array.isArray(lib);
    const real = readFileSync(f, "utf8");
    if (isGraph) {
        writeFileSync(f, ours); // 对象图:语义等价,覆盖
        overwriteGraph++;
    } else if (ours === real) {
        overwriteByte++; // 叶子:字节一致,覆盖(等同原样)
    } else {
        skipAtlasLeaf++; // 图集 spriteframe 等:我们的输出与真实不同,保留真实
    }
}

console.log(`=== 就地验证覆盖(${verifyDir})===`);
console.log(`覆盖-对象图(语义等价): ${overwriteGraph}`);
console.log(`覆盖-叶子(字节一致):   ${overwriteByte}`);
console.log(`保留-图集叶子/其它差异: ${skipAtlasLeaf}`);
console.log(`跳过-pack: ${skipPack}  无library: ${skipNoLib}  序列化失败(deferred等): ${skipErr}`);
console.log(`\n现在用微信开发者工具打开 ${verifyDir} 加载整包验证。`);
