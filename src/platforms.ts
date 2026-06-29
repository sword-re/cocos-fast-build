/**
 * 平台描述表:把 game 样板里的平台差异(微信/抖音)收成有限枚举,供 game.ts 查表,
 * 而非写死微信。新增平台 = 在 PLATFORMS 里加一条 spec。
 *
 * 差异来源:对照参考项目 werewolf-minigame 的真实官方构建 build/wechatgame 与 build/bytedance。
 * 序列化/装配/脚本打包/压缩内核与平台无关,故这里只承载 game.js/main.js/game.json/
 * project.config.json/private config 的平台分歧。
 */
import type { ProjectConfig } from "./config.js";

export interface PlatformSpec {
    /** 平台 key(= settings/<key>.json、_CCSettings.platform、bundle meta 平台键、构建目录名) */
    key: string;
    /**
     * cc.sys 子上下文平台常量名(开放数据域)。
     * 微信 "WECHAT_GAME_SUB",抖音 "BYTEDANCE_GAME_SUB"。
     */
    subPlatformConst: string;
    /**
     * main.js 里"是否子上下文"的判定表达式(决定 showFPS)。
     * 微信用 cc.sys 平台常量比较;抖音用 __globalAdapter.isSubContext。
     */
    subContextExpr: string;
    /** game.json 里插在 deviceOrientation 之后、networkTimeout 之前的字段(抖音 showStatusBar) */
    gameJsonHead: Record<string, any>;
    /** game.json 里追加在 subpackages 之后的字段(微信 iOSHighPerformance*) */
    gameJsonTail: Record<string, any>;
    /** game.json networkTimeout(抖音 connectSocket 为 20000) */
    networkTimeout: Record<string, number>;
    /** project.config.json 内容(整体由平台决定) */
    projectConfig: (appid: string, cfg: ProjectConfig) => Record<string, any>;
    /** 是否写 project.private.config.json(微信有,抖音无) */
    hasPrivateConfig: boolean;
    /** game.js 是否带 "use strict" 前缀(微信有,抖音无——对照真实 build) */
    gameJsUseStrict: boolean;
}

const WECHATGAME: PlatformSpec = {
    key: "wechatgame",
    subPlatformConst: "WECHAT_GAME_SUB",
    subContextExpr: "cc.sys.platform===cc.sys.WECHAT_GAME_SUB",
    gameJsonHead: {},
    gameJsonTail: {
        iOSHighPerformance: false,
        "iOSHighPerformance+": false,
    },
    networkTimeout: { request: 5000, connectSocket: 5000, uploadFile: 5000, downloadFile: 5000 },
    projectConfig: (appid, cfg) => ({
        description: "项目配置文件。",
        miniprogramRoot: "",
        setting: {
            urlCheck: false,
            es6: false,
            postcss: true,
            minified: false,
            newFeature: false,
            nodeModules: false,
            autoAudits: true,
            uglifyFileName: false,
            checkInvalidKey: true,
            remoteDebugLogEnable: false,
            sourcemapDisabled: true,
            babelSetting: { ignore: [], disablePlugins: [], outputPath: "" },
        },
        compileType: "game",
        libVersion: cfg.libVersion,
        appid,
        projectname: cfg.projectName,
        condition: {},
        simulatorType: "wechat",
        packOptions: { ignore: [], include: [] },
        editorSetting: { tabIndent: "insertSpaces", tabSize: 2 },
        staticServerOptions: { servePath: "remote" },
    }),
    hasPrivateConfig: true,
    gameJsUseStrict: true,
};

const BYTEDANCE: PlatformSpec = {
    key: "bytedance",
    subPlatformConst: "BYTEDANCE_GAME_SUB",
    // 抖音 adapter 暴露 __globalAdapter.isSubContext(对照 build/bytedance/main.js)
    subContextExpr: "__globalAdapter.isSubContext",
    gameJsonHead: {
        showStatusBar: false,
    },
    gameJsonTail: {},
    networkTimeout: { request: 5000, connectSocket: 20000, uploadFile: 5000, downloadFile: 5000 },
    // 抖音开发者工具的 project.config.json 极简(对照 build/bytedance)
    projectConfig: (appid, cfg) => ({
        setting: {
            urlCheck: false,
            es6: true,
            postcss: true,
            minified: true,
            newFeature: true,
        },
        appid,
        projectname: cfg.projectName,
    }),
    hasPrivateConfig: false,
    gameJsUseStrict: false,
};

export const PLATFORMS: Record<string, PlatformSpec> = {
    [WECHATGAME.key]: WECHATGAME,
    [BYTEDANCE.key]: BYTEDANCE,
};

/** 取当前平台的 spec;未知平台报错(列出已支持平台) */
export function platformSpec(key: string): PlatformSpec {
    const spec = PLATFORMS[key];
    if (!spec) {
        throw new Error(`不支持的平台: ${key};已支持: ${Object.keys(PLATFORMS).join(", ")}`);
    }
    return spec;
}
