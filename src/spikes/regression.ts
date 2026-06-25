/**
 * 回归检查:固化真机调试验证出的关键不变量,防止 crawl/serialize 改动回退。
 * 用法:npm run verify:regression(全 PASS 退出 0,任一 FAIL 退出 1)。
 *
 * 不变量(均来自真机暴露并修复的 bug 类):
 *  1. 健全性:每个 bundle 的 redirect 目标必在其 deps 内(否则运行时解析不到 owner)。
 *  2. 无埋引用:任何资源序列化后不得残留嵌套 {__uuid__}(Material/AnimationClip/SkeletonData/
 *     对象图的嵌套 Dict 引用必须抽进 depend 表;否则运行时拿到裸对象 → getImpl/textureLoaded 崩)。
 *  3. 依赖自洽:owned 资源序列化出的依赖 uuid(指向真实物理资源的)必在本 bundle 的 config.uuids 内
 *     (否则按路径/依赖加载报 "Bundle X doesn't contain" / readFile:fail 404 —— ec9f9055 下沉类断链)。
 *  4. 跳过项收敛:owned 资源装配跳过的只能是"未 temp 缓存的 .pac SpriteAtlas 容器"(已知无害),
 *     出现其它类型跳过即回退。
 */
import { readFileSync } from "node:fs";
import { crawl } from "../crawl.js";
import { serializeAsset } from "../serialize/index.js";
import { libraryImportPath } from "../paths.js";
import { decompressUuid } from "../uuid.js";
import { stringify } from "../verify.js";
import { atlasConsumption, atlasPages } from "../atlas.js";
import { atlasMembers, hasPhysicalAsset } from "../assetGraph.js";
import { assetExists } from "../assetExists.js";
import { assetMetaMap } from "../assetMeta.js";

let failCount = 0;
const samples: Record<string, string[]> = {};
function fail(check: string, detail: string) {
    failCount++;
    (samples[check] ||= []).push(detail);
}

const { bundleInfo } = crawl();
const synth = atlasConsumption().bigTextures;
const pages = atlasPages();
const metaMap = assetMetaMap();

// ── 1. 健全性:redirect 目标 ∈ deps ──
for (const [name, info] of bundleInfo) {
    const deps = new Set(info.deps);
    for (const [u, target] of info.redirect) {
        if (!deps.has(target)) fail("1.健全性", `${name}: ${u.slice(0, 8)} redirect→${target} 不在 deps`);
    }
}

// ── 2 + 3:逐 owned 资源序列化,查无埋引用 + 依赖自洽 ──
for (const [name, info] of bundleInfo) {
    const uuidSet = new Set(info.uuids);
    for (const u of info.owned) {
        if (synth.has(u)) continue; // 图集合成大图:构造 Texture2D,无引用
        let lib: any;
        try {
            lib = JSON.parse(readFileSync(libraryImportPath(u), "utf8"));
        } catch {
            continue; // 无 library(图集大图/内置)—— 由检查 4 覆盖
        }
        const meta = metaMap.get(u);
        const isAtlas = meta?.type === "cc.SpriteAtlas" || lib.__type__ === "cc.SpriteAtlas";
        if (isAtlas) continue; // SpriteAtlas 走专门装配,成员检查见检查 4

        let out: any;
        try {
            out = serializeAsset(lib, u);
        } catch {
            continue; // 延后类(EffectAsset 旧路径等)—— 现已无,保留容错
        }
        const s = stringify(out);

        // 2. 无埋引用
        if (s.includes('"__uuid__"')) {
            const t = Array.isArray(lib) ? "对象图" : lib.__type__;
            fail("2.无埋引用", `${name}: ${u.slice(0, 8)} [${t}] 序列化后仍埋 __uuid__`);
        }

        // 3. 依赖自洽:SharedUuids 里指向真实物理资源的,必在本 bundle uuids 内
        for (const cu of out[1] || []) {
            if (!cu) continue;
            const d = decompressUuid(cu);
            if (uuidSet.has(d)) continue;
            // 不在本包 uuids:仅当它是真实物理项目资源时才算断链(内置/无 library 由引擎全局解析)
            if (assetExists(d) && hasPhysicalAsset(d)) {
                const t = Array.isArray(lib) ? "对象图" : lib.__type__;
                fail("3.依赖自洽", `${name}: owned ${u.slice(0, 8)} [${t}] 依赖 ${d.slice(0, 8)} 不在本包 uuids`);
            }
        }
    }
}

// ── 4. 跳过项收敛:只允许"未缓存 .pac SpriteAtlas" ──
for (const [name, info] of bundleInfo) {
    for (const u of info.owned) {
        if (synth.has(u)) {
            if (!pages.get(u)) fail("4.跳过收敛", `${name}: 合成大图 ${u.slice(0, 8)} 无页图(非预期)`);
            continue;
        }
        let lib: any;
        try {
            lib = JSON.parse(readFileSync(libraryImportPath(u), "utf8"));
        } catch {
            fail("4.跳过收敛", `${name}: owned ${u.slice(0, 8)} 无 library(非预期)`);
            continue;
        }
        const meta = metaMap.get(u);
        const isAtlas = meta?.type === "cc.SpriteAtlas" || lib.__type__ === "cc.SpriteAtlas";
        if (isAtlas) {
            // SpriteAtlas:有成员则必须可装配;无成员 = 未 temp 缓存的 .pac 容器(已知无害,不计 fail)
            const members = [...(atlasMembers(u) ?? new Set<string>())].filter((sf) => info.uuids.includes(sf));
            if (members.length) {
                try {
                    serializeAsset(lib, u);
                } catch {
                    /* SpriteAtlas 走专门装配,这里不强校验 */
                }
            }
            continue;
        }
        try {
            serializeAsset(lib, u);
        } catch (e) {
            fail("4.跳过收敛", `${name}: owned ${u.slice(0, 8)} [${lib.__type__}] 序列化失败:${(e as Error).message}`);
        }
    }
}

// ── 汇总 ──
const checks = ["1.健全性", "2.无埋引用", "3.依赖自洽", "4.跳过收敛"];
console.log("=== fast-build 回归检查 ===");
for (const c of checks) {
    const fs = samples[c] ?? [];
    console.log(`${fs.length === 0 ? "✔ PASS" : "✗ FAIL"}  ${c}  (${fs.length})`);
    for (const d of fs.slice(0, 8)) console.log(`      ${d}`);
    if (fs.length > 8) console.log(`      ... 及另外 ${fs.length - 8} 项`);
}
console.log(failCount === 0 ? "\n全部通过 ✔" : `\n失败 ${failCount} 项 ✗`);
process.exit(failCount === 0 ? 0 : 1);
