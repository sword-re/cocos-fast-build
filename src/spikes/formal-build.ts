/**
 * 正式打包:产出到 build/fast-wechatgame(保留 build/wechatgame 作 oracle),
 * 并逐 bundle 结构自检 + 与 oracle 对照(config uuids / import / native / deps / scenes / paths)。
 *
 * terser 压缩由外层 bash(formal-build.sh)在本脚本后执行,复刻 build-uploadwx.sh 参数。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildWechatgame } from "../build.js";
import { BUILD_DIR, PROJECT_ROOT } from "../paths.js";
import { decompressUuid } from "../uuid.js";
import { atlasConsumption, resetAtlasCaches } from "../atlas.js";
import { packAllAtlases } from "../atlasPack/pack.js";
import { phase, log, phaseSummary } from "../log.js";

const OUT = join(PROJECT_ROOT, "build/fast-wechatgame");

function findConfig(dir: string): any | null {
    if (!existsSync(dir)) return null;
    const f = readdirSync(dir).find((x) => /^config\..+\.json$/.test(x));
    return f ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null;
}

/** 在 oracle(真实 build)里按 bundle 名找 config(assets/subpackages/remote 三处) */
function oracleConfig(name: string): any | null {
    for (const base of ["assets", "subpackages", "remote"]) {
        const c = findConfig(join(BUILD_DIR, base, name));
        if (c) return c;
    }
    return null;
}

/** 在产物里按 bundle 名找 config */
function outConfig(name: string): any | null {
    for (const base of ["assets", "subpackages", "remote"]) {
        const c = findConfig(join(OUT, base, name));
        if (c) return c;
    }
    return null;
}

function importCount(cfg: any): number {
    return Math.floor((cfg.versions?.import?.length ?? 0) / 2);
}
function nativeCount(cfg: any): number {
    return Math.floor((cfg.versions?.native?.length ?? 0) / 2);
}

async function main(): Promise<void> {
    phase("自研图集打包(脱离编辑器,装配前置)");
    const ps = await packAllAtlases({ onLog: log });
    resetAtlasCaches(); // 打包后重置 atlas 记忆化,使后续读取新 manifest
    log(`图集: ${ps.frames}帧/${ps.pages}页 (${ps.packed}重打/${ps.cached}缓存/${ps.unpacked}散图) ${ps.ms}ms`);

    // 合成大图 uuid 与 cocos 必然不同,从 uuids 对照里排除(设计如此,运行时填充)
    const SYNTH = new Set<string>(atlasConsumption().bigTextures);

    phase("清理输出目录");
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    log(`输出: ${OUT}`);

    const res = await buildWechatgame({ buildDir: OUT, copyFrom: BUILD_DIR });

    phase("逐 bundle 与 oracle 对照");
    const pad = (s: string | number, n: number) => String(s).padEnd(n);
    console.log(
        pad("bundle", 16) + pad("uuids 我/真", 14) + pad("漏/多", 10) + pad("import 我/真", 14) + pad("native 我/真", 14) + pad("deps", 6) + "scenes"
    );
    let totMiss = 0;
    let totExtra = 0;
    for (const name of res.assembled) {
        const mine = outConfig(name);
        const real = oracleConfig(name);
        if (!mine) continue;
        if (!real) {
            console.log(pad(name, 16) + "(oracle 无对照)");
            continue;
        }
        const realU = new Set((real.uuids as string[]).map(decompressUuid).filter((u) => !SYNTH.has(u)));
        const myU = new Set((mine.uuids as string[]).map(decompressUuid).filter((u) => !SYNTH.has(u)));
        const miss = [...realU].filter((u) => !myU.has(u)).length;
        const extra = [...myU].filter((u) => !realU.has(u)).length;
        totMiss += miss;
        totExtra += extra;
        const depsEq = JSON.stringify([...(mine.deps || [])].sort()) === JSON.stringify([...(real.deps || [])].sort());
        const scenesEq = Object.keys(mine.scenes || {}).length === Object.keys(real.scenes || {}).length;
        console.log(
            pad(name, 16) +
                pad(`${mine.uuids.length}/${real.uuids.length}`, 14) +
                pad(`${miss}/${extra}`, 10) +
                pad(`${importCount(mine)}/${importCount(real)}`, 14) +
                pad(`${nativeCount(mine)}/${nativeCount(real)}`, 14) +
                pad(depsEq ? "✓" : "✗", 6) +
                (scenesEq ? "✓" : "✗")
        );
    }
    console.log(`\n合计(排除合成大图)uuid 漏=${totMiss} 多=${totExtra}`);

    phase("关键文件齐备性");
    const keyFiles = [
        "game.js",
        "main.js",
        "ccRequire.js",
        "game.json",
        "src/settings.js",
        "assets/main/config.*",
        "assets/internal/config.*",
        "assets/main/index.js",
        "assets/internal/index.js",
        "assets/resources/index.js",
        "adapter-min.js",
        "cocos/cocos2d-js-min.js",
    ];
    let ok = 0;
    for (const rel of keyFiles) {
        let present: boolean;
        if (rel.endsWith("*")) {
            const dir = join(OUT, rel.slice(0, rel.lastIndexOf("/")));
            const prefix = rel.slice(rel.lastIndexOf("/") + 1, -1);
            present = existsSync(dir) && readdirSync(dir).some((f) => f.startsWith(prefix));
        } else {
            present = existsSync(join(OUT, rel));
        }
        if (present) ok++;
        log(`${present ? "✔" : "✗"} ${rel}`);
    }
    log(`关键文件 ${ok}/${keyFiles.length}`);

    phase("汇总");
    log(`装配成功 ${res.assembled.length} 个 bundle`);
    if (res.skipped.length) log(`装配失败 ${res.skipped.length} 个: ${res.skipped.join(", ")}`);
    log(`产物: ${OUT}(terser 压缩见 formal-build.sh)`);

    phaseSummary();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
