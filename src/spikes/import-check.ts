/**
 * import 校验台:把 import 模块产出的中间对象 + native,与 cocos 编辑器现成的
 * library/imports/<uuid> 逐一比对(免费的正确性 oracle)。
 *
 * 报告:按 importer 类型分桶的 object 通过率(deepEqual)、native 字节通过率、
 * 以及前若干条 mismatch 详情(供逐字段收敛)。
 *
 * 运行:npm run import:check        # 全量
 *       npm run import:check -- -v  # 打印 mismatch 详情
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { importAll, importOrigin } from "../import/index.js";
import { LIBRARY_IMPORTS } from "../paths.js";
import { deepEqual } from "../util/deepEqual.js";

const VERBOSE = process.argv.includes("-v");
const MAX_DETAIL = 12;

function libImportJson(uuid: string): any | undefined {
    const p = join(LIBRARY_IMPORTS, uuid.slice(0, 2), `${uuid}.json`);
    if (!existsSync(p)) return undefined;
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return undefined;
    }
}

/** library 里某 uuid 的 native 文件(扁平 <uuid>.<ext> 或目录 <uuid>/<file>) */
function libNative(uuid: string): Buffer | undefined {
    const dir = join(LIBRARY_IMPORTS, uuid.slice(0, 2));
    if (!existsSync(dir)) return undefined;
    for (const f of readdirSync(dir)) {
        if (f === `${uuid}.json`) continue;
        if (f === uuid) {
            // 目录布局
            const sub = join(dir, uuid);
            try {
                const inner = readdirSync(sub);
                if (inner[0]) return readFileSync(join(sub, inner[0]));
            } catch {
                /* ignore */
            }
            continue;
        }
        if (f.startsWith(`${uuid}.`)) return readFileSync(join(dir, f));
    }
    return undefined;
}

function md5(b: Buffer): string {
    return createHash("md5").update(b).digest("hex");
}

interface Bucket {
    total: number;
    objPass: number;
    objFail: number;
    noRef: number; // library 无此 import(合成/未导出)
    nativePass: number;
    nativeFail: number;
    nativeNoRef: number;
    details: string[];
}

function bucket(): Bucket {
    return { total: 0, objPass: 0, objFail: 0, noRef: 0, nativePass: 0, nativeFail: 0, nativeNoRef: 0, details: [] };
}

function importerOf(uuid: string): string {
    const o = importOrigin(uuid);
    return o?.meta?.importer ?? "?";
}

function main() {
    const all = importAll();
    console.log(`import 模块产出 ${all.size} 个资源对象,开始与 library/imports 比对…\n`);

    const buckets = new Map<string, Bucket>();
    const get = (k: string) => {
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = bucket()));
        return b;
    };

    for (const [uuid, res] of all) {
        const type = importerOf(uuid);
        const b = get(type);
        b.total++;

        // object 比对
        const ref = libImportJson(uuid);
        if (ref === undefined) {
            b.noRef++;
        } else if (deepEqual(res.object, ref)) {
            b.objPass++;
        } else {
            b.objFail++;
            if (b.details.length < MAX_DETAIL) {
                b.details.push(`OBJ ${uuid}\n   mine=${JSON.stringify(res.object)}\n   ref =${JSON.stringify(ref)}`);
            }
        }

        // native 比对
        if (res.native) {
            const refNat = libNative(uuid);
            if (!refNat) {
                b.nativeNoRef++;
            } else {
                const src = res.native.source;
                const mine = Buffer.isBuffer(src) ? src : readFileSync(src);
                if (md5(mine) === md5(refNat)) b.nativePass++;
                else {
                    b.nativeFail++;
                    if (b.details.length < MAX_DETAIL) {
                        b.details.push(`NATIVE ${uuid} 字节不一致 (mine ${mine.length}B vs ref ${refNat.length}B)`);
                    }
                }
            }
        }
    }

    // 汇总
    const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
    console.log(pad("importer", 16) + pad("总数", 8) + pad("obj✓", 8) + pad("obj✗", 8) + pad("无ref", 8) + pad("nat✓", 8) + pad("nat✗", 8));
    console.log("-".repeat(64));
    let tObj = 0, tFail = 0;
    for (const [k, b] of [...buckets].sort()) {
        console.log(pad(k, 16) + pad(String(b.total), 8) + pad(String(b.objPass), 8) + pad(String(b.objFail), 8) + pad(String(b.noRef), 8) + pad(String(b.nativePass), 8) + pad(String(b.nativeFail), 8));
        tObj += b.objPass;
        tFail += b.objFail;
    }
    console.log("-".repeat(64));
    console.log(`object 通过 ${tObj}, 失败 ${tFail}`);

    if (VERBOSE) {
        for (const [k, b] of buckets) {
            if (!b.details.length) continue;
            console.log(`\n===== [${k}] mismatch 详情(前 ${MAX_DETAIL}) =====`);
            for (const d of b.details) console.log(d);
        }
    } else if (tFail > 0) {
        console.log("\n加 -v 看 mismatch 详情");
    }
}

main();
