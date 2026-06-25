/**
 * 脚本层 JS 压缩(替代 terser)。
 *
 * 用 @swc/core(Rust)替代 terser:同档压缩设置(compress passes=2 + mangle toplevel),
 * 实测体积与 terser 持平/略小,速度 ~14×(9.4s→~0.7s)。swc.minify 异步且在 Rust 线程
 * 跑,这里再加并发池把多文件铺满多核。
 *
 * 复刻 terser 阶段的过滤:OUT 下所有 .js,排除 *min.js 与 minigame-rtc.js;
 * 单文件压缩失败则保留原文件(与旧 shell 的 if/else 一致),不中断整体。
 */
import { minify, type JsMinifyOptions } from "@swc/core";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cpus } from "node:os";

const MINIFY_OPTS: JsMinifyOptions = {
    compress: { passes: 2 },
    mangle: { toplevel: true },
    format: { comments: false },
    sourceMap: false,
};

/** 大文件阈值(字节):超过则单独报一行"压缩大文件" */
const BIG = 512 * 1024;

function listJs(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".js") && !e.name.endsWith("min.js") && e.name !== "minigame-rtc.js") out.push(p);
        }
    };
    walk(root);
    return out;
}

export interface MinifyResult {
    total: number;
    ok: number;
    failed: string[];
    beforeBytes: number;
    afterBytes: number;
    ms: number;
}

/** 压缩 buildDir 下全部脚本 JS(就地覆盖);log 实时输出进度 */
export async function minifyBuild(buildDir: string, log: (m: string) => void = () => {}): Promise<MinifyResult> {
    const t0 = Date.now();
    const files = listJs(buildDir).sort((a, b) => statSync(b).size - statSync(a).size); // 大文件优先,缩短尾延迟
    log(`共 ${files.length} 个 js 待压缩…`);

    let beforeBytes = 0;
    let afterBytes = 0;
    let ok = 0;
    let done = 0;
    const failed: string[] = [];
    const total = files.length;
    const n = Math.max(1, Math.min(cpus().length || 4, files.length));

    let next = 0;
    const worker = async () => {
        while (next < files.length) {
            const f = files[next++];
            const rel = relative(buildDir, f);
            const code = readFileSync(f, "utf8");
            const before = Buffer.byteLength(code);
            if (before > BIG) log(`  ⏳ 压缩大文件 ${rel} (${(before / 1024) | 0}KB)…`);
            try {
                const out = await minify(code, MINIFY_OPTS);
                writeFileSync(f, out.code);
                const after = Buffer.byteLength(out.code);
                beforeBytes += before;
                afterBytes += after;
                ok++;
                done++;
                log(`  ✓ [${done}/${total}] ${rel}  ${(before / 1024) | 0}KB→${(after / 1024) | 0}KB`);
            } catch (e) {
                failed.push(rel);
                done++;
                log(`  ✗ 压缩失败(保留原文件): ${rel} — ${(e as Error).message.split("\n")[0]}`);
            }
        }
    };
    await Promise.all(Array.from({ length: n }, worker));

    return { total, ok, failed, beforeBytes, afterBytes, ms: Date.now() - t0 };
}
