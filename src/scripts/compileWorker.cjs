/**
 * 脚本自编译 worker(纯 CommonJS,worker_threads;不经 tsx 加载器)。
 *
 * 用 cocos 同款 TypeScript 4.1.3(ts413 alias)做 transpileModule —— 与 cocos
 * QuickCompiler 逐字节一致。worker 只做纯 CPU 的 transpile,fs 读由 worker 自理。
 */
const { parentPort } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const ts = require("ts413");

// cocos 2.4.13 项目 tsconfig 的等效编译选项(target=es6/commonjs/装饰器)
const COMPILER = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2015,
    experimentalDecorators: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    sourceMap: false,
    inlineSourceMap: false,
};

parentPort.on("message", (msg) => {
    if (msg && msg.type === "exit") {
        parentPort.close();
        return;
    }
    const { id, tsPath } = msg;
    try {
        const src = readFileSync(tsPath, "utf8");
        const out = ts.transpileModule(src, { compilerOptions: COMPILER, fileName: tsPath }).outputText;
        parentPort.postMessage({ id, ok: true, output: out });
    } catch (e) {
        parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
    }
});
