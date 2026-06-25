/**
 * 自研 auto-atlas 打包:发现全工程 .pac → bin-pack → sharp 合成大图 → 写 manifest。
 * 完全脱离编辑器 temp/TexturePacker。增量缓存:成员未变的 .pac 跳过合成。
 */
import { packAllAtlases } from "../atlasPack/pack.js";
import { log, phase } from "../log.js";

async function main(): Promise<void> {
    phase("自研图集打包(脱离编辑器)");
    const s = await packAllAtlases({ onLog: log });
    phase("汇总");
    log(`.pac 总数 ${s.pacs} | 重打 ${s.packed} | 命中缓存 ${s.cached} | 帧 ${s.frames} | 页 ${s.pages} | 耗时 ${s.ms}ms`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
