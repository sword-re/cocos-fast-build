/** swc 压缩入口:压缩 build/fast-wechatgame 下全部脚本 JS。 */
import { performance } from "node:perf_hooks";
import { minifyBuild } from "../minify.js";
import { BUILD_DIR } from "../paths.js";

const dir = process.argv[2] || BUILD_DIR.replace(/wechatgame$/, "fast-wechatgame");
const t0 = performance.now();
const r = await minifyBuild(dir, (m) => console.log(m));
console.log(
    `✓ 压缩完成: ${r.ok}/${r.total} 成功${r.failed.length ? `, ${r.failed.length} 失败` : ""}, ` +
        `${(r.beforeBytes / 1024 / 1024).toFixed(1)}MB→${(r.afterBytes / 1024 / 1024).toFixed(1)}MB, 耗时 ${((performance.now() - t0) / 1000).toFixed(2)}s`,
);
if (r.failed.length) console.log("失败文件:", r.failed.join(", "));
