/**
 * 端到端编排(脱离 formal-build.sh 的跨平台 Node 版本)。
 * 图集打包 → 清理输出 → 构建(装配/脚本/game 模板/引擎拷贝)→ swc 压缩。
 * oracle 对照等开发自检不在此(那是验证工具,见 spikes/formal-build.ts)。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { platform } from "./config.js";
import { buildWechatgame } from "./build.js";
import { packAllAtlases } from "./atlasPack/pack.js";
import { resetAtlasCaches } from "./atlas.js";
import { minifyBuild } from "./minify.js";
import { phase, log, phaseSummary } from "./log.js";

export interface RunOptions {
    /** 产物目录;默认 <project>/build/fast-<platform> */
    out?: string;
    /** 引擎/plugin 拷贝来源(一份现成官方 build);省略则产物缺引擎包不可直接运行 */
    enginePack?: string;
    /** 是否 swc 压缩(默认 true) */
    minify?: boolean;
}

export async function runBuild(opts: RunOptions = {}): Promise<{ out: string; assembled: number; skipped: number }> {
    const out = opts.out || join(PROJECT_ROOT, `build/fast-${platform()}`);

    phase("图集打包");
    const ps = await packAllAtlases({ onLog: log });
    resetAtlasCaches(); // 打包后重置 atlas 记忆化,使后续读取新 manifest
    log(`图集: ${ps.frames}帧/${ps.pages}页 (${ps.packed}重打/${ps.cached}缓存/${ps.unpacked}散图) ${ps.ms}ms`);

    phase("清理输出目录");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    log(`输出: ${out}`);

    phase("构建 (装配/脚本/game 模板)");
    const res = await buildWechatgame({ buildDir: out, copyFrom: opts.enginePack });
    log(`装配 ${res.assembled.length} 成功${res.skipped.length ? `, ${res.skipped.length} 失败: ${res.skipped.join(", ")}` : ""}`);

    if (opts.minify !== false) {
        phase("swc 压缩");
        const m = await minifyBuild(out, log);
        log(`压缩 ${m.ok}/${m.total}${m.failed.length ? `(${m.failed.length} 失败)` : ""}, ${(m.beforeBytes / 1048576).toFixed(1)}MB→${(m.afterBytes / 1048576).toFixed(1)}MB, ${m.ms}ms`);
    }

    phase("汇总");
    log(`产物: ${out}`);
    if (!opts.enginePack) log("⚠ 未提供 enginePack:产物缺引擎/plugin 包,不能直接运行(用 --engine-pack 指定一份官方 build)");
    phaseSummary();
    return { out, assembled: res.assembled.length, skipped: res.skipped.length };
}
