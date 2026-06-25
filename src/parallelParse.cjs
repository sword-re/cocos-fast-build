/**
 * parseFilesWorker:读 + JSON.parse 一批文件路径,回传解析结果(失败为 null)。
 * 用于把 crawl 阶段成千上万个小文件(.meta / library import)的读取 syscall 摊到多线程。
 * 数据量小(全部 library import 仅 ~2.6MB),CPU 占比低,真正的收益来自并行 read syscall。
 */
const { parentPort } = require("node:worker_threads");
const { readFileSync } = require("node:fs");

parentPort.on("message", (msg) => {
    if (msg && msg.type === "exit") {
        parentPort.close();
        return;
    }
    const { id, paths } = msg;
    const out = new Array(paths.length);
    for (let i = 0; i < paths.length; i++) {
        try {
            out[i] = JSON.parse(readFileSync(paths[i], "utf8"));
        } catch {
            out[i] = null;
        }
    }
    parentPort.postMessage({ id, out });
});
