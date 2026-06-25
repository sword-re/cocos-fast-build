/**
 * 验证:自编译(compile.ts)产出的 CORE 与编辑器 quick-scripts 逐字节一致。
 * 已知环境性差异(非编译器问题):build-uploadwx.sh 会临时 stub 抖音/安卓平台文件、
 * 注入 GIT_COMMIT —— 这些文件的 quick-scripts 缓存与当前源不同,会被单独列出。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, QUICK_SCRIPTS } from "../paths.js";
import { stripWrapper } from "../scripts/wrapper.js";
import { compileProjectScripts } from "../scripts/compile.js";
import { log, phase } from "../log.js";

const DST = join(QUICK_SCRIPTS, "dst", "assets");

async function main() {
    phase("自编译脚本逐字节验证");
    const scripts = await compileProjectScripts(log);

    let exact = 0,
        diff = 0,
        noOracle = 0,
        samples = 0;
    const diffs: string[] = [];
    for (const s of scripts) {
        const oracle = join(DST, s.rel);
        if (!existsSync(oracle)) {
            noOracle++;
            continue;
        }
        let real: string;
        try {
            real = stripWrapper(readFileSync(oracle, "utf8")).core;
        } catch {
            noOracle++;
            continue;
        }
        if (s.core === real) {
            exact++;
        } else {
            diff++;
            diffs.push(s.rel);
            if (samples < 5) {
                samples++;
                const a = s.core.split("\n"),
                    b = real.split("\n");
                for (let i = 0; i < Math.max(a.length, b.length); i++)
                    if (a[i] !== b[i]) {
                        log(`DIFF ${s.rel} 行${i}:`);
                        log(`  mine = ${JSON.stringify(a[i])}`);
                        log(`  real = ${JSON.stringify(b[i])}`);
                        break;
                    }
            }
        }
    }
    phase("结果");
    log(`逐字节一致 ${exact} | 不一致 ${diff} | 无对照 ${noOracle} | 一致率 ${((exact / (exact + diff)) * 100).toFixed(2)}%`);
    if (diff) log(`不一致文件: ${diffs.join(", ")}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
