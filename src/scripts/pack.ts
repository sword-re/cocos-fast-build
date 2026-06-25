/**
 * 脚本打包器:把 temp/quick-scripts/dst 下的项目脚本 + node_modules 打成各 bundle 的
 * index.js(cocos browserify 格式)。
 *
 * 关键事实(均已对真实 build/wechatgame 产物验证):
 *  - cocos 2.x 强制脚本 basename(去扩展)全局唯一 → 项目脚本用 basename 作模块 key。
 *  - 模块 key 是**跨 bundle 协议**:bundle 本地表找不到时 fallback 到 window.__require
 *    (主包 main 的表),所以 resources 脚本能引用 main 里的 Logger 等。
 *  - node_modules 用**数字 ID** 作 key(避免与 basename 冲突),全部并入 main 表;
 *    其它 bundle 引用时 depMap 值是同一数字,靠 fallback 命中 main 表。
 *  - 脚本归属:resources 文件夹下的脚本 → resources bundle;其余全部 → main
 *    (本项目实测 main 514 个 entry / resources 5 个 / 其它 bundle 无 index.js)。
 *  - entry 列出该 bundle 全部脚本 basename,确保每个脚本被执行以 cc._RF.push 注册类。
 */
import { statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as pathResolve, basename } from "node:path";
import { extractRequires, isRelative } from "./requires.js";
import { NodeModulesBundler, extractNodeModulePkg } from "./nodeModules.js";
import { compileProjectScripts } from "./compile.js";
import type { CompiledScript } from "./compile.js";
import { discoverBundles } from "../bundles.js";
import { PROJECT_ROOT } from "../paths.js";
import { log, timer, humanBytes } from "../log.js";

const ASSETS = join(PROJECT_ROOT, "assets");
/** 主包(启动场景包):不在任何 asset bundle 文件夹内的脚本归此处 */
const MAIN = "main";

/** cocos 标准 browserify prelude(window.__require);参数 (modules, cache, entry)。 */
const PRELUDE =
    'window.__require=function e(t,i,o){function r(s,a){if(!i[s]){if(!t[s]){var l=s.split("/");if(l=l[l.length-1],!t[l]){var c="function"==typeof __require&&__require;if(!a&&c)return c(l,!0);if(n)return n(l,!0);throw new Error("Cannot find module \'"+s+"\'")}s=l}var d=i[s]={exports:{}};t[s][0].call(d.exports,function(e){return r(t[s][1][e]||e)},d,d.exports,e,t,i,o)}return i[s].exports}for(var n="function"==typeof __require&&__require,s=0;s<o.length;s++)r(o[s]);return r}';

/** 解析项目脚本内的相对 require → 目标源文件绝对路径(.ts/.js / index.ts/index.js) */
function resolveProjectFile(fromAbs: string, req: string): string | null {
    const base = pathResolve(dirname(fromAbs), req);
    const cands = [base, base + ".ts", base + ".js", join(base, "index.ts"), join(base, "index.js")];
    for (const c of cands) {
        try {
            if (statSync(c).isFile()) return c;
        } catch {
            /* ignore */
        }
    }
    return null;
}

interface ModuleEntry {
    key: string | number;
    core: string;
    depMap: Record<string, string | number>;
}

/** 渲染单个 browserify 模块条目 */
function renderModule(e: ModuleEntry): string {
    const keyStr = JSON.stringify(String(e.key));
    return `${keyStr}:[function(require,module,exports){${e.core}\n},${JSON.stringify(e.depMap)}]`;
}

/** 渲染整个 index.js */
function renderIndex(modules: ModuleEntry[], entry: (string | number)[]): string {
    const table = "{" + modules.map(renderModule).join(",") + "}";
    return `${PRELUDE}(${table},{},${JSON.stringify(entry.map(String))});`;
}

export interface PackResult {
    /** bundle -> 产物 index.js 路径 */
    outputs: Map<string, string>;
    scriptCount: number;
    nodeModuleCount: number;
    /** 相对 require 解析失败(脚本) */
    unresolvedScript: Array<{ from: string; req: string }>;
    /** main 反向引用 resources 专属脚本(顶层表无法 fallback) */
    badCrossRefs: Array<{ from: string; targetKey: string }>;
}

/** 执行脚本打包,写出各 bundle 的 index.js 到 outRoot/<bundle>/index.js */
export async function packScripts(outRoot: string): Promise<PackResult> {
    const done = timer("脚本打包");

    log("自编译项目脚本(脱离编辑器)...");
    const scripts = await compileProjectScripts(log);
    log(`发现 ${scripts.length} 个项目脚本`);

    // basename 全局唯一性校验(cocos 2.x 约束;违反会导致模块覆盖)
    const byKey = new Map<string, CompiledScript>();
    for (const s of scripts) {
        const prev = byKey.get(s.key);
        if (prev) {
            log(`⚠ basename 冲突: "${s.key}" → ${prev.rel} vs ${s.rel}(后者覆盖)`);
        }
        byKey.set(s.key, s);
    }

    const byBundle = new Map<string, CompiledScript[]>();
    for (const s of scripts) {
        let arr = byBundle.get(s.bundle);
        if (!arr) byBundle.set(s.bundle, (arr = []));
        arr.push(s);
    }
    for (const [b, arr] of byBundle) log(`归属 ${b}: ${arr.length} 个脚本`);

    const nm = new NodeModulesBundler();
    const unresolvedScript: Array<{ from: string; req: string }> = [];
    // main 是 fallback 链最底层,若它引用分包/resources 脚本会运行时崩溃(无处 fallback)
    const badCrossRefs: Array<{ from: string; targetKey: string; targetBundle: string }> = [];

    // 各 bundle 的项目脚本模块条目
    const bundleModules = new Map<string, ModuleEntry[]>();
    const bundleEntry = new Map<string, string[]>();

    log("解析依赖 + 构建 depMap ...");
    let nmReqCount = 0;
    for (const s of scripts) {
        const core = s.core;
        const depMap: Record<string, string | number> = {};
        for (const req of extractRequires(core)) {
            if (isRelative(req) && !req.includes("node_modules/")) {
                const tgt = resolveProjectFile(s.abs, req);
                if (tgt) {
                    const tgtKey = basename(tgt).replace(/\.(ts|js)$/, "");
                    depMap[req] = tgtKey;
                    // main 是 fallback 链最底层,不能引用任何分包/resources 脚本
                    const tgtBundle = byKey.get(tgtKey)?.bundle ?? MAIN;
                    if (s.bundle === MAIN && tgtBundle !== MAIN) {
                        badCrossRefs.push({ from: s.abs, targetKey: tgtKey, targetBundle: tgtBundle });
                    }
                } else {
                    unresolvedScript.push({ from: s.abs, req });
                }
            } else if (req.includes("node_modules/")) {
                // 指向 Cocos/系统 node_modules 的绝对/超长相对路径 → 提取包名走 nm
                const pkg = extractNodeModulePkg(req) ?? req;
                const id = nm.requireFrom(s.abs, pkg);
                if (id !== null) {
                    depMap[req] = id;
                    nmReqCount++;
                } else {
                    unresolvedScript.push({ from: s.abs, req });
                }
            } else {
                // node_modules 包名
                const id = nm.requireFrom(s.abs, req);
                if (id !== null) {
                    depMap[req] = id;
                    nmReqCount++;
                } else {
                    unresolvedScript.push({ from: s.abs, req });
                }
            }
        }
        let mods = bundleModules.get(s.bundle);
        if (!mods) bundleModules.set(s.bundle, (mods = []));
        mods.push({ key: s.key, core, depMap });
        let ent = bundleEntry.get(s.bundle);
        if (!ent) bundleEntry.set(s.bundle, (ent = []));
        ent.push(s.key);
    }
    log(`项目脚本 → node_modules 引用 ${nmReqCount} 处,解析失败(脚本相对) ${unresolvedScript.length} 处`);
    if (badCrossRefs.length) {
        log(`⚠ main 引用分包/resources 脚本 ${badCrossRefs.length} 处(运行时无法 fallback):`);
        for (const r of badCrossRefs.slice(0, 10))
            log(`    ${r.targetKey}(${r.targetBundle}) ← ${r.from.split("/dst/")[1] || r.from}`);
    } else {
        log(`✔ main 自包含(不引用任何分包/resources 脚本)`);
    }

    // node_modules 模块全部并入 main 表(数字 ID,跨 bundle 靠 fallback 命中)
    const nmEntries = nm.emit();
    log(`node_modules 收集 ${nmEntries.length} 个文件,解析失败(node) ${nm.unresolved.length} 处`);
    for (const u of nm.unresolved.slice(0, 10)) {
        log(`    node 未解析: ${u.req}  ← ${u.from.split("/__node_modules/")[1] || u.from}`);
    }
    const mainMods = bundleModules.get("main") ?? [];
    for (const e of nmEntries) {
        const depMap: Record<string, string | number> = {};
        for (const [req, id] of e.deps) depMap[req] = id;
        mainMods.push({ key: e.id, core: e.core, depMap });
    }
    bundleModules.set("main", mainMods);

    // 渲染 + 写出(布局贴近真实产物:主包/resources/internal 用 index.js,分包/remote 用 game.js)
    const remoteOf = new Map(discoverBundles().map((b) => [b.name, b.isRemote]));
    // scriptDest 布局(对照真实 build):主包/内置 → assets/<b>/index.js;微信分包 → subpackages/<b>/game.js;
    // remote → src/scripts/<b>/index.js(脚本与资源 dest=remote/<b> 分离)
    const outRel = (b: string): string => {
        if (b === MAIN) return "assets/main/index.js";
        if (b === "resources") return "assets/resources/index.js";
        if (b === "internal") return "assets/internal/index.js";
        return remoteOf.get(b) ? `src/scripts/${b}/index.js` : `subpackages/${b}/game.js`;
    };

    const outputs = new Map<string, string>();
    for (const [b, mods] of bundleModules) {
        const entry = bundleEntry.get(b) ?? [];
        const content = renderIndex(mods, entry);
        const rel = outRel(b);
        const p = join(outRoot, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        outputs.set(b, p);
        log(`写出 ${rel}: ${mods.length} 模块, entry ${entry.length}, ${humanBytes(content.length)}`);
    }

    // 空脚本包:每个需要入口脚本的 bundle 都必须有产物文件(微信分包要求每个 subpackage root
    // 都有 game.js,无脚本的分包如 Entry/Audio 也要空壳;internal/remote 同理)。
    // 与真实产物一致:无项目脚本的 bundle 写空 browserify 壳 ({},{},[])。
    const emptyContent = `${PRELUDE}({},{},[]);`;
    const needEntry = new Set<string>([MAIN, "resources", "internal", ...discoverBundles().map((b) => b.name)]);
    for (const b of needEntry) {
        if (bundleModules.has(b)) continue; // 已写出脚本则不覆盖
        const p = join(outRoot, outRel(b));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, emptyContent);
        outputs.set(b, p);
        log(`写出 ${outRel(b)}(空脚本包)`);
    }

    done();
    return {
        outputs,
        scriptCount: scripts.length,
        nodeModuleCount: nmEntries.length,
        unresolvedScript,
        badCrossRefs,
    };
}
