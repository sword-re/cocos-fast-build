/**
 * 全量序列化覆盖扫描:对 build 里所有 import 文件尝试用我们的序列化器重建,
 * 统计覆盖面并把成功产物写入 .out/all/<uuid>.ours.json + 清单 _all-ok.tsv 供桥端语义校验。
 *
 * 分类:ok / pack(合并文件,暂不支持) / nolib(无 library 源) / deferred(SpriteAtlas) / error
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolve } from "node:path";
import { listBuildImportFiles, pairFor, uuidFromBuildFile, readJson } from "../samples.js";
import { serializeAsset, UnsupportedAsset } from "../serialize/index.js";
import { GraphUnsupported } from "../serialize/objectGraph.js";
import { stringify } from "../verify.js";

const outDir = resolve(process.cwd(), ".out/all");
mkdirSync(outDir, { recursive: true });

const files = listBuildImportFiles();
let ok = 0,
    pack = 0,
    nolib = 0,
    deferred = 0,
    error = 0,
    byteMatch = 0;
const errs = new Map<string, number>();
const okList: string[] = [];
const byteDiffList: string[] = []; // 非字节一致,需桥端语义校验

const isPack = (file: string) => !basename(file).split(".")[0].includes("-"); // uuid 含连字符,pack 不含

for (const f of files) {
    if (isPack(f)) {
        pack++;
        continue;
    }
    const uuid = uuidFromBuildFile(f);
    const s = pairFor(uuid, f);
    if (!existsSync(s.libraryPath)) {
        nolib++;
        continue;
    }
    let lib: any;
    try {
        lib = readJson(s.libraryPath);
    } catch {
        nolib++;
        continue;
    }
    try {
        const out = serializeAsset(lib);
        const content = stringify(out);
        writeFileSync(resolve(outDir, `${uuid}.ours.json`), content);
        ok++;
        okList.push(`${uuid}\t${f}`);
        if (content === readFileSync(f, "utf8")) byteMatch++;
        else byteDiffList.push(`${uuid}\t${f}`);
    } catch (e) {
        if (e instanceof UnsupportedAsset) deferred++;
        else if (e instanceof GraphUnsupported) {
            error++;
            const k = (e.message || "").replace(/: .*/, "");
            errs.set(k, (errs.get(k) ?? 0) + 1);
        } else {
            error++;
            const k = (e as Error).message.split("\n")[0];
            errs.set(k, (errs.get(k) ?? 0) + 1);
        }
    }
}

writeFileSync(resolve(outDir, "_all-ok.tsv"), okList.join("\n"));
writeFileSync(resolve(outDir, "_all-bytediff.tsv"), byteDiffList.join("\n"));

console.log(`=== 全量 import 覆盖(共 ${files.length} 文件)===`);
console.log(`ok=${ok}  pack=${pack}  nolib=${nolib}  deferred(SpriteAtlas)=${deferred}  error=${error}`);
console.log(`其中字节一致=${byteMatch}  需语义校验(非字节一致)=${byteDiffList.length}`);
if (errs.size) {
    console.log(`错误明细:`);
    for (const [k, n] of [...errs.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`);
}
console.log(`成功产物 .out/all/,清单 _all-ok.tsv`);
