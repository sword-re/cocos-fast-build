/**
 * Spike:game 样板生成验证。
 * 用真实 build 的 bundleVers 作输入,生成 settings.js/ccRequire.js/game.json,
 * 与真实 build/wechatgame 逐字段对比。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { writeGameTemplate, buildSettings, genCcRequireJs, genGameJson } from "../game.js";
import { BUILD_DIR } from "../paths.js";
import { phase, log } from "../log.js";

const OUT = join(tmpdir(), "fast-build-game");

/** eval 一个 `window._CCSettings={...}` 文件取对象 */
function loadCCSettings(content: string): any {
    const sandbox: any = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(content, sandbox);
    return sandbox.window._CCSettings;
}

/** eval ccRequire.js 取模块 key 列表(顺序) */
function loadCcRequireKeys(content: string): string[] {
    // 提取 let s={...}; 里的 key(它们都是被 JSON.stringify 的字符串字面量)
    const keys: string[] = [];
    const re = /"((?:[^"\\]|\\.)+)":\(\)=>require/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) keys.push(m[1]);
    return keys;
}

function cmp(label: string, ours: any, real: any): void {
    const a = JSON.stringify(ours);
    const b = JSON.stringify(real);
    if (a === b) log(`✔ ${label} 一致`);
    else log(`✗ ${label} 不一致\n    ours=${a}\n    real=${b}`);
}

function main(): void {
    phase("game 样板生成 spike");
    const realSettings = loadCCSettings(readFileSync(join(BUILD_DIR, "src/settings.js"), "utf8"));

    // 用真实 bundleVers 作输入(验证生成逻辑;端到端时改用 assemble 产出的 md5)
    writeGameTemplate(OUT, { bundleVers: realSettings.bundleVers });
    log(`输出目录: ${OUT}`);

    phase("settings.js 字段对比");
    const ours = buildSettings({ bundleVers: realSettings.bundleVers });
    for (const k of [
        "platform",
        "groupList",
        "collisionMatrix",
        "hasResourcesBundle",
        "hasStartSceneBundle",
        "remoteBundles",
        "subpackages",
        "launchScene",
        "orientation",
        "server",
        "jsList",
    ]) {
        cmp(k, ours[k], realSettings[k]);
    }

    phase("game.json 对比");
    const ourGame = JSON.parse(genGameJson());
    const realGame = JSON.parse(readFileSync(join(BUILD_DIR, "game.json"), "utf8"));
    cmp("deviceOrientation", ourGame.deviceOrientation, realGame.deviceOrientation);
    cmp("subpackages", ourGame.subpackages, realGame.subpackages);
    cmp("networkTimeout", ourGame.networkTimeout, realGame.networkTimeout);

    phase("ccRequire.js 模块列表对比");
    const ourKeys = loadCcRequireKeys(genCcRequireJs());
    const realKeys = loadCcRequireKeys(readFileSync(join(BUILD_DIR, "ccRequire.js"), "utf8"));
    cmp("ccRequire 模块列表", ourKeys, realKeys);

    phase("汇总");
    log(`真实 bundleVers 含 ${Object.keys(realSettings.bundleVers).length} 个 bundle`);
}

main();
