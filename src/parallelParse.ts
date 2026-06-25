/**
 * 并行读取 + JSON.parse 一批文件。
 *
 * crawl 阶段的真正瓶颈不是 CPU 也不是字节量(全部 library import 仅 ~2.6MB),而是
 * 触碰上万个小文件的 read syscall 开销。worker_threads 各自有独立 libuv 线程池,
 * 把 read 摊到多核可显著缩短墙钟时间。文件少时(< 阈值)直接同步读,避免 worker 启停开销。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";

const WORKER = fileURLToPath(new URL("./parallelParse.cjs", import.meta.url));

/** 低于此文件数直接同步解析(worker 启停不划算) */
const PARALLEL_THRESHOLD = 512;

/** 并行读取 + JSON.parse;返回与 paths 等长、同序的解析结果(失败位置为 null) */
export async function parseFiles(paths: string[]): Promise<any[]> {
    if (paths.length < PARALLEL_THRESHOLD) {
        return paths.map((p) => {
            try {
                return JSON.parse(readFileSync(p, "utf8"));
            } catch {
                return null;
            }
        });
    }
    const n = Math.max(1, Math.min(11, (cpus().length || 4) - 1));
    const chunk = Math.ceil(paths.length / n);
    const chunks: { start: number; paths: string[] }[] = [];
    for (let i = 0; i < paths.length; i += chunk) chunks.push({ start: i, paths: paths.slice(i, i + chunk) });

    const result = new Array(paths.length);
    const workers = chunks.map(() => new Worker(WORKER));
    await new Promise<void>((resolve, reject) => {
        let alive = workers.length;
        workers.forEach((w, ci) => {
            w.on("message", (m: { id: number; out: any[] }) => {
                const { start } = chunks[m.id];
                for (let i = 0; i < m.out.length; i++) result[start + i] = m.out[i];
                w.postMessage({ type: "exit" });
            });
            w.on("error", reject);
            w.on("exit", () => {
                if (--alive === 0) resolve();
            });
            w.postMessage({ id: ci, paths: chunks[ci].paths });
        });
    });
    return result;
}
