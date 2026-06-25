/**
 * 解析 cocos 项目根目录及关键子目录。
 *
 * 取值优先级:环境变量 CFB_PROJECT_ROOT(CLI 注入)> 从本模块位置向上 auto-detect。
 * auto-detect 判据通用化:同时含 assets/ 与 library/imports/ 的目录即 cocos 项目根
 * (不再写死 settings/wechatgame.json,以支持任意 cocos 2.x 项目)。
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 一个目录是否像 cocos 项目根 */
function isCocosProjectRoot(dir: string): boolean {
    return existsSync(resolve(dir, "assets")) && existsSync(resolve(dir, "library/imports"));
}

function findProjectRoot(): string {
    const env = process.env.CFB_PROJECT_ROOT;
    if (env) {
        const dir = resolve(env);
        if (!isCocosProjectRoot(dir)) throw new Error(`CFB_PROJECT_ROOT 不是 cocos 项目根(缺 assets/ 或 library/imports/): ${dir}`);
        return dir;
    }
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i++) {
        if (isCocosProjectRoot(dir)) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error("找不到 cocos 项目根目录(向上未找到同时含 assets/ 与 library/imports/ 的目录);可用 CFB_PROJECT_ROOT 指定");
}

export const PROJECT_ROOT = findProjectRoot();
export const LIBRARY_IMPORTS = resolve(PROJECT_ROOT, "library/imports");
export const TEMP_DIR = resolve(PROJECT_ROOT, "temp");
export const QUICK_SCRIPTS = resolve(PROJECT_ROOT, "temp/quick-scripts");
export const BUILD_DIR = resolve(PROJECT_ROOT, "build/wechatgame");

/** library 里某 uuid 的 import json 路径 */
export function libraryImportPath(uuid: string): string {
    return resolve(LIBRARY_IMPORTS, uuid.slice(0, 2), `${uuid}.json`);
}
