/**
 * 引擎内置资源快照:把 library/imports 中**无项目 meta**(引擎内置:builtin effect/material/
 * 白纹理等,无源码可重新生成)的 import json + native 镜像到 data/builtin-imports/。
 *
 * 一次性执行(需编辑器产出的 library 在场);此后构建用快照 + import 模块,不再读 library/imports。
 * 引擎内置极少变,等同 vendor chunk 库。
 *
 * 运行:npm run snapshot:builtins
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, cpSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_IMPORTS } from "../paths.js";
import { hasPhysicalAsset } from "../assetGraph.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../data/builtin-imports");

function main() {
    if (existsSync(OUT)) rmSync(OUT, { recursive: true });
    mkdirSync(OUT, { recursive: true });
    let nObj = 0, nNat = 0;
    for (const sub of readdirSync(LIBRARY_IMPORTS)) {
        const dir = join(LIBRARY_IMPORTS, sub);
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const f of entries) {
            // uuid:json 去 .json;native 取首段;目录(dir 布局)即 uuid
            const uuid = f.endsWith(".json") ? f.slice(0, -5) : f.includes(".") ? f.slice(0, f.indexOf(".")) : f;
            if (hasPhysicalAsset(uuid)) continue; // 有项目 meta → 由 import 模块重新生成,不快照
            const src = join(dir, f);
            const dst = join(OUT, sub, f);
            mkdirSync(dirname(dst), { recursive: true });
            if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true });
            else writeFileSync(dst, readFileSync(src));
            if (f.endsWith(".json")) nObj++;
            else nNat++;
        }
    }
    console.log(`内置快照完成 → data/builtin-imports/`);
    console.log(`  import json: ${nObj} 个;native: ${nNat} 个`);
}

main();
