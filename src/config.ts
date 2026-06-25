/**
 * 构建配置(脱离单一项目的关键)。
 *
 * 取值优先级:CLI 注入的环境变量 CFB_* > 项目根 cfb.config.json > 内置默认。
 * 设计成单进程单项目:CLI 解析参数后先 setenv 再(动态)import 构建模块,故 paths.ts 等
 * 模块级常量在加载时即可读到正确的 projectRoot/platform;不经 CLI(spike/测试)则回退 auto-detect。
 *
 * projectRoot 的解析在 paths.ts(被广泛依赖,放最底层避免环依赖);本模块只承载"富配置"
 * (platform / projectName / bootExtras / enginePack 等),供 game 模板与编排层使用。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";

/** game.js 启动时注入的项目级全局(如 RTC 等 plugin),复刻原 GAME_JS 里写死的那行 */
export interface BootExtra {
    /** 挂到 window 的全局名;省略则仅 require 不赋值 */
    global?: string;
    /** require 的模块路径(相对产物根,如 "./src/assets/Script/Lib/RTC/minigame-rtc.min.js") */
    module: string;
}

export interface ProjectConfig {
    /** 目标平台(目前仅 wechatgame);决定 settings/<platform>.json 与 bundle meta 的平台 key */
    platform: string;
    /** 写入 project.config.json 的 projectname;默认取项目根目录名 */
    projectName: string;
    /** 微信开发者工具 libVersion */
    libVersion: string;
    /** game.js 启动注入(项目特定 plugin 全局) */
    bootExtras: BootExtra[];
    /** 远程 bundle 上传命令(CI);CLI --remote-upload-cmd 优先。详见 orchestrate.RunOptions */
    remoteUploadCmd?: string;
}

const DEFAULTS: Omit<ProjectConfig, "projectName"> = {
    platform: "wechatgame",
    libVersion: "3.8.9",
    bootExtras: [],
};

let _cfg: ProjectConfig | null = null;

/** 懒加载并缓存项目配置(项目根 cfb.config.json 覆盖默认,CFB_* 环境变量再覆盖) */
export function projectConfig(): ProjectConfig {
    if (_cfg) return _cfg;
    let fileCfg: Partial<ProjectConfig> = {};
    const cfgPath = join(PROJECT_ROOT, "cfb.config.json");
    if (existsSync(cfgPath)) {
        try {
            fileCfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        } catch {
            /* 配置损坏:用默认 */
        }
    }
    const projectName = process.env.CFB_PROJECT_NAME || fileCfg.projectName || PROJECT_ROOT.split("/").pop() || "cocos-game";
    _cfg = {
        platform: process.env.CFB_PLATFORM || fileCfg.platform || DEFAULTS.platform,
        projectName,
        libVersion: fileCfg.libVersion || DEFAULTS.libVersion,
        bootExtras: fileCfg.bootExtras || DEFAULTS.bootExtras,
        remoteUploadCmd: fileCfg.remoteUploadCmd,
    };
    return _cfg;
}

/** 目标平台(bundle meta 平台 key、settings/<platform>.json) */
export function platform(): string {
    return projectConfig().platform;
}
