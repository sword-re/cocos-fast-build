/**
 * 端到端编排(脱离 formal-build.sh 的跨平台 Node 版本)。
 * 图集打包 → 清理输出 → 构建(装配/脚本/game 模板/引擎拷贝)→ swc 压缩。
 * oracle 对照等开发自检不在此(那是验证工具,见 spikes/formal-build.ts)。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { platform, projectConfig } from "./config.js";
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
    /**
     * 远程 bundle 上传命令(CI 用)。设置后,构建末尾若 out/remote 非空则执行该命令上传,
     * 调用时注入环境变量 CFB_REMOTE_DIR(remote 目录)/ CFB_OUT(产物根)/ CFB_PLATFORM。
     * 上传成功后默认从产物移除 remote/(与官方一致),除非 keepRemote。
     * OSS/CDN 细节由该命令(项目自带,如 upload-remote-bundle.sh)负责,CLI 保持通用。
     * 本地开发不传此项 → remote/ 留在产物里,由 formal-build.sh 起本地服务器。
     */
    remoteUploadCmd?: string;
    /** 上传后保留 out/remote(默认上传成功即移除) */
    keepRemote?: boolean;
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

    // 远程 bundle:CI 上传(委托项目命令),本地不传则留在产物里由 formal-build.sh 起服务器
    const uploadCmd = opts.remoteUploadCmd ?? projectConfig().remoteUploadCmd;
    const remoteDir = join(out, "remote");
    const hasRemote = existsSync(remoteDir) && readdirSync(remoteDir).length > 0;
    if (uploadCmd && hasRemote) {
        phase("上传远程 bundle");
        log(`远程目录: ${remoteDir}`);
        execSync(uploadCmd, {
            stdio: "inherit",
            env: { ...process.env, CFB_REMOTE_DIR: remoteDir, CFB_OUT: out, CFB_PLATFORM: platform() },
        });
        if (!opts.keepRemote) {
            rmSync(remoteDir, { recursive: true, force: true });
            log("远程 bundle 上传完成,已从产物移除 remote/");
        } else {
            log("远程 bundle 上传完成(保留 remote/)");
        }
    } else if (hasRemote && !uploadCmd) {
        log(`提示: 产物含 remote/(${readdirSync(remoteDir).length} 项),未配置上传命令 → 留在产物里(本地可由 formal-build.sh 起服务器)`);
    }

    phase("汇总");
    log(`产物: ${out}`);
    if (!opts.enginePack) log("⚠ 未提供 enginePack:产物缺引擎/plugin 包,不能直接运行(用 --engine-pack 指定一份官方 build)");
    phaseSummary();
    return { out, assembled: res.assembled.length, skipped: res.skipped.length };
}
