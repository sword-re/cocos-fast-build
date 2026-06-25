/**
 * 项目脚本自编译(脱离编辑器 quick-scripts)。
 *
 * 用 cocos 同款 TypeScript 4.1.3 的 transpileModule 把 assets 下所有 .ts 编成 CommonJS,
 * 再套 cocos 的 cc._RF 包装,产出与 quick-scripts CORE 逐字节一致的代码。
 *
 *   CORE = `"use strict";\ncc._RF.push(module, '<RF压缩uuid>', '<名>');\n// <相对assets路径>\n\n`
 *        + (tsc输出 || "\n")        // 纯 interface 文件 tsc 输出空,cocos 仍留一个换行
 *        + `\ncc._RF.pop();`
 *
 * 性能:worker_threads 池并行 transpile(纯 JS CPU 密集,worker 真划算)+ 内容哈希增量缓存
 * (仅重编改动的 .ts)。已对 1342 文件逐字节验证(详见 spikes/scripts-selfcompile-verify)。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { PROJECT_ROOT } from "../paths.js";
import { compressUuidRF } from "../uuid.js";
import { discoverBundles } from "../bundles.js";

/** 编译选项变更时 +1,使缓存整体失效 */
const COMPILE_VERSION = 1;

const ASSETS = join(PROJECT_ROOT, "assets");
const CACHE_DIR = join(PROJECT_ROOT, "tools/fast-build/.script-cache");
const WORKER = fileURLToPath(new URL("./compileWorker.cjs", import.meta.url));
const MAIN = "main";

export interface CompiledScript {
    /** 源文件绝对路径(.ts 或预编译 .js 库) */
    abs: string;
    /** basename(去扩展)= 模块 key */
    key: string;
    /** 相对 assets,带 .js 扩展(与旧 enumerateScripts 的 rel 对齐) */
    rel: string;
    /** 归属 bundle(物理位置最深的 bundle;无则 main) */
    bundle: string;
    remote: boolean;
    /** 源是否为预编译 .js 库(非 .ts) */
    isJs: boolean;
    /** cc._RF 包装后的 CommonJS 核心(= quick-scripts 的 CORE) */
    core: string;
}

interface BundleDir {
    name: string;
    relDir: string; // 相对 assets,带尾斜杠
    remote: boolean;
}
function bundleDirs(): BundleDir[] {
    return discoverBundles()
        .map((b) => ({ name: b.name, relDir: relative(ASSETS, b.rootDir) + "/", remote: b.isRemote }))
        .sort((a, b) => b.relDir.length - a.relDir.length);
}

/** 枚举 assets 下所有项目脚本:.ts(排除 .d.ts)+ 预编译 .js 库,按物理位置归属 bundle */
function enumerateTs(): Omit<CompiledScript, "core">[] {
    const dirs = bundleDirs();
    const out: Omit<CompiledScript, "core">[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) {
                walk(p);
            } else {
                const isTs = name.endsWith(".ts") && !name.endsWith(".d.ts");
                const isJs = name.endsWith(".js");
                if (!isTs && !isJs) continue;
                // isPlugin:true 的脚本(如 protobuf/minigame-rtc)由 cocos 走 jsList 插件加载,
                // 不编进 bundle index.js —— 跳过(否则会重复/冲突)。
                try {
                    if (JSON.parse(readFileSync(p + ".meta", "utf8")).isPlugin === true) continue;
                } catch {
                    /* 无 meta:按非插件处理 */
                }
                const rel = relative(ASSETS, p).split("\\").join("/");
                const owner = dirs.find((d) => (rel + "/").startsWith(d.relDir));
                out.push({
                    abs: p,
                    key: basename(name, isTs ? ".ts" : ".js"),
                    rel: isTs ? rel.replace(/\.ts$/, ".js") : rel,
                    bundle: owner ? owner.name : MAIN,
                    remote: owner ? owner.remote : false,
                    isJs,
                });
            }
        }
    };
    walk(ASSETS);
    return out;
}

/** .ts 的 cc._RF 包装(= quick-scripts CORE) */
function wrapCoreTs(tsOut: string, uuid: string, name: string, rel: string): string {
    const body = tsOut === "" ? "\n" : tsOut;
    return `"use strict";\ncc._RF.push(module, '${compressUuidRF(uuid)}', '${name}');\n// ${rel}\n\n${body}\ncc._RF.pop();`;
}

/**
 * .js 库的 cc._RF 包装。复刻 cocos(browserify insert-module-globals)的行为:
 * **只对真正用到 process/global 的库注入对应全局**,且只注入用到的那个。
 *  - 都不用 → 纯 cc._RF 包装(无 IIFE,不产生 process 依赖!)
 *  - 用 process → (function(process){...}).call(this, require("process"))
 *  - 用 global  → (function(global){...}).call(this, <globalExpr>)(纯表达式,无 require)
 *
 * 之前无条件给所有 .js 套 require("process") 会凭空造出 node_module 依赖:分包里不用
 * process 的库(如 Common 的 pinyin-pro)被强加 process(数字 id 在 main),跨 bundle
 * 回退时 prelude `数字.split()` 崩溃,冲垮整个分包加载。
 */
function wrapCoreJs(jsOut: string, uuid: string, name: string, rel: string): string {
    const needP = /\bprocess\b/.test(jsOut);
    const needG = /\bglobal\b/.test(jsOut);
    const inner = `"use strict";\ncc._RF.push(module, '${compressUuidRF(uuid)}', '${name}');\n// ${rel}\n\n${jsOut}\ncc._RF.pop();`;
    if (!needP && !needG) return inner;
    const params: string[] = [];
    const args: string[] = [];
    if (needP) {
        params.push("process");
        args.push(`require("process")`);
    }
    if (needG) {
        params.push("global");
        args.push(`typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {}`);
    }
    return `(function (${params.join(",")}){\n${inner}\n}).call(this,${args.join(",")})`;
}

function cacheKey(tsContent: string): string {
    return createHash("md5").update(`v${COMPILE_VERSION}\0`).update(tsContent).digest("hex");
}

/** worker 池:并行 transpile 一批 .ts,返回 tsPath -> tsc 输出 */
async function transpilePool(files: string[], onProgress?: (done: number, total: number) => void): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!files.length) return result;
    // 每个 worker 都要加载 ~8MB 的 TS(ts413),worker 数过多反被加载开销吃掉收益。
    // 实测 ~4 个最优(1342 文件:4w≈2.7s vs 单线程≈5.5s vs 8w≈3.2s)。
    const n = Math.max(1, Math.min(4, (cpus().length || 4) - 1, files.length));
    const workers = Array.from({ length: n }, () => new Worker(WORKER));
    let next = 0;
    let done = 0;
    const total = files.length;

    await new Promise<void>((resolve, reject) => {
        let alive = workers.length;
        const assign = (w: Worker) => {
            if (next >= files.length) {
                w.postMessage({ type: "exit" });
                return;
            }
            const id = next++;
            w.postMessage({ id, tsPath: files[id] });
        };
        for (const w of workers) {
            w.on("message", (m: { id: number; ok: boolean; output?: string; error?: string }) => {
                if (!m.ok) {
                    reject(new Error(`transpile 失败 ${files[m.id]}: ${m.error}`));
                    return;
                }
                result.set(files[m.id], m.output!);
                done++;
                if (onProgress) onProgress(done, total);
                assign(w);
            });
            w.on("error", reject);
            w.on("exit", () => {
                if (--alive === 0) resolve();
            });
            assign(w); // 初始派一个
        }
    });
    return result;
}

export interface CompileStats {
    total: number;
    compiled: number; // 实际 transpile 的(未命中缓存)
    cached: number;
    ms: number;
}

let _cache: CompiledScript[] | null = null;
let _stats: CompileStats | null = null;

/**
 * 编译全部项目脚本,返回 CompiledScript[](含 cc._RF CORE)。结果在进程内 memoize。
 * 增量:按内容哈希命中 .script-cache 的跳过 transpile。
 */
export async function compileProjectScripts(onLog?: (m: string) => void): Promise<CompiledScript[]> {
    if (_cache) return _cache;
    const t0 = Date.now();
    const log = onLog ?? (() => {});
    mkdirSync(CACHE_DIR, { recursive: true });

    const metas = enumerateTs();
    // 读内容 + 算缓存键;.ts 必转译,.js 仅当含 ESM(import/export)才转译,纯 CJS .js 原样
    const need: string[] = [];
    const keyOf = new Map<string, string>();
    const contentOf = new Map<string, string>();
    const transpileOf = new Map<string, boolean>();
    for (const m of metas) {
        const content = readFileSync(m.abs, "utf8");
        contentOf.set(m.abs, content);
        const needsTranspile = !m.isJs || /(^|\n)\s*(import|export)\s/.test(content);
        transpileOf.set(m.abs, needsTranspile);
        if (!needsTranspile) continue; // 纯 CJS .js:原样用,不进缓存/worker
        const key = cacheKey(content);
        keyOf.set(m.abs, key);
        if (!existsSync(join(CACHE_DIR, key + ".js"))) need.push(m.abs);
    }

    log(`项目脚本 ${metas.length} 个,需编译 ${need.length},命中缓存 ${[...transpileOf.values()].filter(Boolean).length - need.length}`);
    if (need.length) {
        const fresh = await transpilePool(need, (d, t) => {
            if (d % 100 === 0 || d === t) log(`  transpile 进度 ${d}/${t}`);
        });
        for (const [abs, out] of fresh) writeFileSync(join(CACHE_DIR, keyOf.get(abs)! + ".js"), out);
    }

    // 组装 CORE
    const scripts: CompiledScript[] = [];
    for (const m of metas) {
        const out = transpileOf.get(m.abs) ? readFileSync(join(CACHE_DIR, keyOf.get(m.abs)! + ".js"), "utf8") : contentOf.get(m.abs)!;
        let uuid = "";
        try {
            uuid = JSON.parse(readFileSync(m.abs + ".meta", "utf8")).uuid ?? "";
        } catch {
            /* 无 meta:仍编译,但 cc._RF uuid 为空(理论不该发生) */
        }
        const core = m.isJs ? wrapCoreJs(out, uuid, m.key, m.rel) : wrapCoreTs(out, uuid, m.key, m.rel.replace(/\.js$/, ".ts"));
        scripts.push({ ...m, core });
    }

    _stats = { total: metas.length, compiled: need.length, cached: metas.length - need.length, ms: Date.now() - t0 };
    log(`项目脚本编译完成: ${_stats.total} 个 (${_stats.compiled} 编译 / ${_stats.cached} 缓存), 耗时 ${_stats.ms}ms`);
    _cache = scripts;
    return scripts;
}

export function compileStats(): CompileStats | null {
    return _stats;
}

export function resetCompileCache(): void {
    _cache = null;
    _stats = null;
}
