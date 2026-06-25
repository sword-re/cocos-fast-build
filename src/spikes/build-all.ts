/**
 * Spike:端到端完整构建到临时目录,对比真实 build/wechatgame 的目录结构。
 * main / internal 现已自装配(无需从真实 build 借用 bundleVers)。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWechatgame } from "../build.js";
import { BUILD_DIR } from "../paths.js";
import { resetAtlasCaches } from "../atlas.js";
import { packAllAtlases } from "../atlasPack/pack.js";
import { phase, log } from "../log.js";

const OUT = join(tmpdir(), "fast-build-all", "wechatgame");

async function main(): Promise<void> {
    phase("自研图集打包(脱离编辑器,装配前置)");
    await packAllAtlases({ onLog: log });
    resetAtlasCaches();

    const res = await buildWechatgame({ buildDir: OUT, copyFrom: BUILD_DIR });

    phase("产物结构检查(对照真实 build 关键文件)");
    const checks = [
        "game.js",
        "main.js",
        "ccRequire.js",
        "game.json",
        "src/settings.js",
        "assets/main/index.js",
        "assets/resources/index.js",
        "assets/internal/index.js",
        "subpackages/VoiceRoom/game.js",
        "subpackages/Common/game.js",
        "src/scripts/ActivityRemote/index.js",
        "cocos/cocos2d-js-min.js",
        "adapter-min.js",
        "src/assets/Proto/protobuf.js",
    ];
    let ok = 0;
    for (const c of checks) {
        const present = existsSync(join(OUT, c));
        if (present) ok++;
        log(`${present ? "✔" : "✗"} ${c}`);
    }
    log(`产物关键文件 ${ok}/${checks.length} 齐备`);

    phase("汇总");
    log(`装配成功 ${res.assembled.length} 个 bundle: ${res.assembled.join(", ")}`);
    if (res.skipped.length) log(`装配跳过 ${res.skipped.length} 个: ${res.skipped.join(", ")}`);
    log(`bundleVers 含 ${Object.keys(res.bundleVers).length} 个 bundle`);
    log(`输出目录: ${OUT}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
