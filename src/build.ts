/**
 * 端到端构建编排:把 bundle 资源装配 + 脚本打包 + game 样板 + 引擎/plugin 拷贝
 * 串成一个完整的 build/wechatgame 目录。
 *
 * 构建顺序复刻 cocos:按 bundle priority 降序(internal>Audio>resources>main>...>priority1)。
 * 产物布局(对照真实 build):
 *   - 资源 config/import/native: 内置→assets/<b>,微信分包→subpackages/<b>,remote→remote/<b>
 *   - 脚本包: 内置→assets/<b>/index.js,分包→subpackages/<b>/game.js,remote→src/scripts/<b>/index.js
 *   - game 样板: game.js/main.js/src/settings.js/ccRequire.js/game.json/...
 *   - 拷贝: adapter-min.js / cocos/ / src/assets(plugin)
 *
 * 虚拟主包 main(启动场景 Startup)与引擎内置 internal 现已纳入资源装配(crawl 的 allBundles)。
 * 已知缺口:cc.EffectAsset 序列化延后(spike2),internal 的内置 effect 会被跳过(见装配 skipped)。
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BundleDef } from "./bundles.js";
import { assembleBundle } from "./assemble.js";
import { crawl, primeCrawl } from "./crawl.js";
import { packScripts } from "./scripts/pack.js";
import { writeGameTemplate } from "./game.js";
import { buildStart, buildAsset, buildProgress, buildWarning, buildSuccess } from "./buildLog.js";
import { phase, log, timer } from "./log.js";

export interface BuildOptions {
    /** 输出目录(完整 build/wechatgame 结构) */
    buildDir: string;
    /** 引擎/plugin 拷贝来源(现有 build/wechatgame);省略则跳过拷贝 */
    copyFrom?: string;
    /** 兜底:某 bundle 装配失败时用的 config md5 占位(bundleName->md5) */
    builtinVers?: Record<string, string>;
}

/** 资源 dest 的父目录(assembleBundle 的 outRoot,使其 outRoot/<name> == dest) */
function resourceParent(b: BundleDef, buildDir: string): string {
    if (b.isRemote) return join(buildDir, "remote");
    // 内置 bundle(resources / 虚拟主包 main / 引擎内置 internal)落 assets/<name>
    if (b.name === "resources" || b.name === "main" || b.name === "internal") return join(buildDir, "assets");
    return join(buildDir, "subpackages");
}

/** build-asset 日志信息(贴近 cocos 字段) */
function assetInfo(b: BundleDef, buildDir: string): Record<string, unknown> {
    const dest = join(resourceParent(b, buildDir), b.name);
    const scriptDest = b.isRemote ? join(buildDir, "src/scripts", b.name) : dest;
    return {
        root: b.dbPath,
        name: b.name,
        dest,
        scriptDest,
        priority: b.priority,
        compressionType: b.compressionType,
        isRemote: b.isRemote,
    };
}

/** 拷贝引擎/plugin 稳定产物 */
function copyEngineAndPlugins(buildDir: string, from: string): void {
    for (const rel of ["adapter-min.js", "cocos", "src/assets", "hook.js"]) {
        const src = join(from, rel);
        if (!existsSync(src)) {
            buildWarning(`拷贝源缺失,跳过: ${rel}`);
            continue;
        }
        const dst = join(buildDir, rel);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst, { recursive: true });
        log(`拷贝 ${rel}`);
    }
}

export interface BuildResult {
    bundleVers: Record<string, string>;
    assembled: string[];
    skipped: string[];
}

/** 执行完整 wechatgame 构建 */
export async function buildWechatgame(opts: BuildOptions): Promise<BuildResult> {
    const done = timer("完整构建");
    buildStart("wechatgame");
    const { buildDir } = opts;
    mkdirSync(buildDir, { recursive: true });

    // ── 0. 扫描资源依赖图(crawl 较重,单独成阶段,避免"无输出卡顿"观感)──
    phase("扫描资源依赖图(crawl)");
    // 先并行预热共享读盘缓存(.meta + library import),再做(同步的)依赖图爬取
    await primeCrawl();
    // 按 priority 降序(复刻 cocos 构建顺序);含虚拟主包 main / 引擎内置 internal
    const bundles = [...crawl().bundles].sort((a, b) => b.priority - a.priority);
    log(`依赖图扫描完成: ${bundles.length} 个 bundle`);

    // ── 1. 装配各 bundle 资源 ──
    phase("装配 bundle 资源");
    const bundleVers: Record<string, string> = {};
    const assembled: string[] = [];
    const skipped: string[] = [];
    // bundle 间有界并发:各 bundle 写自己的 outDir、共享只读的 crawl/meta 索引,互不干扰;
    // 并发让 A 的写盘 IO 与 B 的序列化 CPU 重叠。
    let next = 0;
    const assembleOne = async () => {
        while (next < bundles.length) {
            const i = next++;
            const b = bundles[i];
            buildProgress(b.name, i + 1, bundles.length);
            buildAsset(assetInfo(b, buildDir));
            try {
                const r = await assembleBundle(b.name, resourceParent(b, buildDir));
                if (r.configMd5) bundleVers[b.name] = r.configMd5;
                assembled.push(b.name);
                if (r.skipped.length) buildWarning(`${b.name}: ${r.skipped.length} 个资源跳过(无 library import / temp 未缓存)`);
            } catch (e) {
                skipped.push(b.name);
                buildWarning(`${b.name} 装配失败: ${(e as Error).message}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, bundles.length) }, assembleOne));
    log(`资源装配完成: ${assembled.length} 成功, ${skipped.length} 跳过`);

    // ── 2. 打包脚本(主包/内置/分包/remote 的 index.js / game.js) ──
    phase("打包脚本");
    await packScripts(buildDir);

    // ── 3. 兜底:若某 bundle(含 main/internal)装配失败,用外部传入的 bundleVers 占位 ──
    for (const [k, v] of Object.entries(opts.builtinVers ?? {})) {
        if (!(k in bundleVers)) {
            bundleVers[k] = v;
            buildWarning(`bundleVers[${k}] 用外部占位 ${v}(该 bundle 装配失败)`);
        }
    }

    // ── 4. game 样板 ──
    phase("生成 game 样板");
    writeGameTemplate(buildDir, { bundleVers });

    // ── 5. 拷贝引擎/plugin ──
    if (opts.copyFrom) {
        phase("拷贝引擎/plugin");
        copyEngineAndPlugins(buildDir, opts.copyFrom);
    } else {
        buildWarning("未提供 copyFrom,跳过引擎/plugin 拷贝(产物不可直接运行)");
    }

    buildSuccess("wechatgame");
    done();
    return { bundleVers, assembled, skipped };
}
