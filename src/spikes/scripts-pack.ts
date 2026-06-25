/**
 * Spike:脚本打包端到端验证。
 *
 * 1. 运行 packScripts → 临时目录(带时间戳日志)
 * 2. 语法校验:生成的 index.js 能否被 JS 引擎解析
 * 3. 解析自洽:所有 require 是否解析成功(unresolved 应为 0)
 * 4. 与真实 build/wechatgame 产物对比规模(模块数/entry 数/字节)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { packScripts } from "../scripts/pack.js";
import { BUILD_DIR } from "../paths.js";
import { phase, log } from "../log.js";

const OUT = join(tmpdir(), "fast-build-scripts");

/** 数模块条目数(通用正则,兼容 terser mangle 后参数名) */
function countModules(file: string): number {
    if (!existsSync(file)) return -1;
    const s = readFileSync(file, "utf8");
    return (s.match(/:\[function\(/g) || []).length;
}

/** 真实 build 里某 bundle 脚本包的路径(主包/resources index.js,分包 subpackages,remote build/remote) */
function realPathOf(b: string): string {
    if (b === "main") return join(BUILD_DIR, "assets/main/index.js");
    if (b === "resources") return join(BUILD_DIR, "assets/resources/index.js");
    if (b === "internal") return join(BUILD_DIR, "assets/internal/index.js");
    const sub = join(BUILD_DIR, "subpackages", b, "game.js");
    if (existsSync(sub)) return sub;
    return join(BUILD_DIR, "..", "remote", b, "game.js");
}

async function main(): Promise<void> {
    phase("脚本打包 spike");
    log(`输出目录: ${OUT}`);

    const res = await packScripts(OUT);

    phase("语法校验");
    for (const [b, p] of res.outputs) {
        const content = readFileSync(p, "utf8");
        const rel = p.split("/fast-build-scripts/")[1] || p;
        try {
            // 包成函数体只做 parse,不执行
            new Function("window", "cc", "__require", content);
            log(`✔ ${rel} 语法合法 (${b})`);
        } catch (e) {
            log(`✗ ${rel} 语法错误: ${(e as Error).message}`);
        }
    }

    phase("解析自洽");
    if (res.unresolvedScript.length === 0) {
        log(`✔ 项目脚本相对 require 全部解析成功`);
    } else {
        log(`✗ 项目脚本未解析 ${res.unresolvedScript.length} 处:`);
        for (const u of res.unresolvedScript.slice(0, 20)) log(`    ${u.req}  ← ${u.from.split("/dst/")[1] || u.from}`);
    }

    phase("与真实 build 各 bundle 模块数对比");
    let match = 0;
    let total = 0;
    for (const [b, ourFile] of [...res.outputs.entries()].sort()) {
        const ours = countModules(ourFile);
        const real = countModules(realPathOf(b));
        total++;
        const tag = ours === real ? "✔" : real < 0 ? "—(真实无)" : `Δ${ours - real}`;
        if (ours === real) match++;
        log(`${tag.padEnd(8)} ${b.padEnd(16)} ours=${ours} real=${real}`);
    }
    log(`精确匹配 ${match}/${total} 个 bundle(差异多为 6/24 新增活动脚本,真实 build 为 6/23)`);

    phase("运行时铁证(执行模块系统)");
    // 清空 entry(避免执行业务脚本的副作用),只验证 prelude + require + 纯算法模块完整性
    try {
        let s = readFileSync(res.outputs.get("resources")!, "utf8").replace(/,\[[^\]]*\]\);$/, ",[]);");
        const sandbox: any = { window: {}, cc: { _RF: { push() {}, pop() {} } } };
        vm.createContext(sandbox);
        vm.runInContext(s, sandbox);
        const require = sandbox.window.__require;
        const Md5 = require("Md5").Md5;
        const got = Md5.digest("abc");
        const want = "900150983cd24fb0d6963f7d28e17f72";
        if (got === want) log(`✔ resources/index.js 真实执行: Md5.digest("abc")=${got} 正确`);
        else log(`✗ Md5 输出 ${got} ≠ ${want}`);
    } catch (e) {
        log(`✗ 运行时执行失败: ${(e as Error).message}`);
    }

    phase("汇总");
    log(`项目脚本 ${res.scriptCount}, node_modules ${res.nodeModuleCount}`);
    log(`产物: ${[...res.outputs.values()].join(", ")}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
