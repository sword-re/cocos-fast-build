/**
 * node_modules 打包子系统(已脱离编辑器:直接从项目真实 node_modules 解析)。
 *
 * 项目脚本引用的 npm 包(buffer/crypto-js/jpeg-js/upng-js/@aliyun-sls...)及其传递依赖,
 * 在 cocos browserify 产物里用**数字 ID** 作模块 key(避免与项目脚本 basename 冲突,仅在
 * main 内部自洽)。cocos 把它们复制到 temp/quick-scripts/dst/__node_modules;我们改为直接读
 * 项目 node_modules —— 内容同源(cocos 即从此复制),core = 文件原始内容(本就是 CommonJS)。
 *
 * node 解析:package.json main / **browser 字段**(cocos 用浏览器解析,如 process 用 browser.js)
 * / index.js / .js/.json 扩展 / node_modules 上溯。浏览器无且无 polyfill 的 Node 内置 → 空 stub。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import { extractRequires, isRelative } from "./requires.js";

/** 解析上溯边界:项目根(其下 node_modules 为顶层包来源) */
const ROOT_BOUNDARY = PROJECT_ROOT;
const NM_ROOT = join(PROJECT_ROOT, "node_modules");

export interface NodeModuleEntry {
    id: number;
    /** 纯 CommonJS 核心 */
    core: string;
    /** require 字符串 -> 目标数字 ID */
    deps: Map<string, number>;
    /** 调试用:绝对路径 */
    abs: string;
}

function isFile(p: string): boolean {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}
function isDir(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** 浏览器环境无、且无 polyfill 包的 Node 内置模块 → 打成空 stub(与真实 build 一致) */
const NODE_BUILTINS = new Set([
    "crypto",
    "fs",
    "path",
    "os",
    "tls",
    "net",
    "http",
    "https",
    "zlib",
    "stream",
    "util",
    "events",
    "assert",
    "child_process",
    "dns",
    "vm",
]);

/** 从含 node_modules 的(绝对/超长相对)路径提取顶层包名:.../node_modules/process/browser.js → process */
export function extractNodeModulePkg(req: string): string | null {
    const i = req.lastIndexOf("node_modules/");
    if (i < 0) return null;
    const rest = req.slice(i + "node_modules/".length);
    const parts = rest.split("/");
    if (parts[0].startsWith("@")) return parts.slice(0, 2).join("/"); // 作用域包
    return parts[0];
}

export class NodeModulesBundler {
    private ids = new Map<string, number>();
    private entries: NodeModuleEntry[] = [];
    private next = 1;
    private stubIdCache: number | null = null;
    /** 解析失败的 (来源文件, require) 记录,供日志 */
    readonly unresolved: Array<{ from: string; req: string }> = [];

    /** 从某文件解析一个 require 并确保被收集,返回其数字 ID。失败返回 null。 */
    requireFrom(fromFile: string, req: string): number | null {
        // Node 内置(无 polyfill)→ 空 stub
        if (NODE_BUILTINS.has(req)) return this.stubId();
        // 指向 Cocos/系统 node_modules 的绝对/超长相对路径 → 提取包名重解析
        let target = req;
        if (req.includes("node_modules/")) {
            const pkg = extractNodeModulePkg(req);
            if (pkg) target = pkg;
        }
        const abs = this.resolve(fromFile, target);
        if (!abs) {
            this.unresolved.push({ from: fromFile, req });
            return null;
        }
        return this.ensure(abs);
    }

    /** 惰性创建一个共享空 stub 模块(function(){}) */
    private stubId(): number {
        if (this.stubIdCache !== null) return this.stubIdCache;
        const id = this.next++;
        this.entries.push({ id, core: "", deps: new Map(), abs: "<stub>" });
        this.stubIdCache = id;
        return id;
    }

    /** 已收集的全部 node_modules 模块条目 */
    emit(): NodeModuleEntry[] {
        return this.entries;
    }

    get count(): number {
        return this.entries.length;
    }

    /** 收集一个文件(若未收集):分配 ID -> 剥壳 -> 递归解析其 require */
    private ensure(abs: string): number {
        const existing = this.ids.get(abs);
        if (existing !== undefined) return existing;
        const id = this.next++;
        this.ids.set(abs, id); // 先登记,防循环依赖
        // 真实 node_modules 文件本就是 CommonJS,直接用原始内容作 core;.json 包成 module.exports
        const raw = readFileSync(abs, "utf8");
        const core = abs.endsWith(".json") ? `module.exports = ${raw}` : raw;
        const deps = new Map<string, number>();
        // 包内部 require 也要走完整逻辑(builtin stub / node_modules 路径提取 / resolve)
        for (const r of extractRequires(core)) {
            const childId = this.requireFrom(abs, r);
            if (childId !== null) deps.set(r, childId);
        }
        this.entries.push({ id, core, deps, abs });
        return id;
    }

    /** node 解析:相对路径 or 包名(node_modules 上溯)。返回规范绝对路径或 null。 */
    private resolve(fromFile: string, req: string): string | null {
        if (isRelative(req)) {
            return this.loadAsFileOrDir(pathResolve(dirname(fromFile), req));
        }
        // 包名:从 fromFile 目录逐级上溯找 node_modules/<req>,根是 __node_modules
        let dir = dirname(fromFile);
        for (;;) {
            const cand = this.loadAsFileOrDir(join(dir, "node_modules", req));
            if (cand) return cand;
            if (dir === ROOT_BOUNDARY || dir === "/" || dirname(dir) === dir) break;
            dir = dirname(dir);
        }
        // 顶层 node_modules 兜底
        return this.loadAsFileOrDir(join(NM_ROOT, req));
    }

    private loadAsFileOrDir(p: string): string | null {
        // as file
        if (isFile(p)) return p;
        if (isFile(p + ".js")) return p + ".js";
        if (isFile(p + ".json")) return p + ".json";
        // as dir
        if (isDir(p)) return this.loadAsDir(p);
        return null;
    }

    /** 目录入口解析:package.json browser(字符串)→ main → index.js → dist/<name>.js → 目录内唯一 .js */
    private loadAsDir(p: string): string | null {
        const pkgJson = join(p, "package.json");
        if (isFile(pkgJson)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
                // cocos 走浏览器解析:browser 为字符串时优先于 main(如 process → ./browser.js)。
                // browser 为对象(如 crypto-js {"crypto":false})是按需 require 重映射,入口仍用 main。
                const entry = typeof pkg.browser === "string" ? pkg.browser : pkg.main;
                if (typeof entry === "string") {
                    const r = this.loadAsFileOrDir(pathResolve(p, entry));
                    if (r) return r;
                }
            } catch {
                /* ignore */
            }
        }
        if (isFile(join(p, "index.js"))) return join(p, "index.js");
        if (isFile(join(p, "index.json"))) return join(p, "index.json");
        // dist/<dirname>.js(@aliyun-sls/web-track-browser 等)
        const base = basename(p);
        const distMain = join(p, "dist", base + ".js");
        if (isFile(distMain)) return distMain;
        // 目录内唯一 .js(upng-js/UPNG.js 等)
        let dirJs: string[] = [];
        try {
            dirJs = readdirSync(p).filter((f) => f.endsWith(".js"));
        } catch {
            /* ignore */
        }
        if (dirJs.length === 1) return join(p, dirJs[0]);
        return null;
    }
}

export { NM_ROOT };
