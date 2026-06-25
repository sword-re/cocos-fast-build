/**
 * game 样板生成器:产出微信小游戏启动所需的 game.js / main.js / settings.js /
 * ccRequire.js / hook.js / game.json / project.config.json 等。
 *
 * 文件分三类(均对照真实 build/wechatgame 验证):
 *  1. 生成(依赖项目数据):src/settings.js、ccRequire.js、game.json
 *  2. 模板(基本固定,少量变量):game.js、main.js、hook.js、project*.json
 *  3. 拷贝(引擎/平台/plugin,稳定中间产物):adapter-min.js、cocos/、src/assets/、src/scripts/
 *     —— 由编排层从现有 build 或引擎安装目录拷贝,本模块只负责 1、2。
 *
 * 数据源:
 *  - settings/project.json: group-list / collision-matrix / start-scene
 *  - settings/wechatgame.json: appid / orientation / startSceneAssetBundle / REMOTE_SERVER_ROOT
 *  - discoverBundles(): subpackages(非 remote asset bundle)/ remoteBundles(remote)
 *  - 扫描 *.js.meta(isPlugin): jsList
 *  - bundleVers: 各 bundle config.<md5>.json 的 md5(由编排层装配后传入)
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { platform, projectConfig } from "./config.js";
import { discoverBundles } from "./bundles.js";
import { assetMetaMap } from "./assetMeta.js";
import { log } from "./log.js";

const ASSETS = join(PROJECT_ROOT, "assets");

function readJson(p: string): any {
    return JSON.parse(readFileSync(p, "utf8"));
}

/** 平台 settings 文件(settings/<platform>.json,如 settings/wechatgame.json) */
function platformSettings(): any {
    return readJson(join(PROJECT_ROOT, `settings/${platform()}.json`));
}

/** 扫描 assets 下所有 isPlugin 的 .js,返回 jsList(相对 db,带 assets/ 前缀,含 RTC .min 变体) */
export function scanPluginJsList(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) {
                walk(p);
            } else if (name.endsWith(".js")) {
                const metaP = p + ".meta";
                if (!existsSync(metaP)) continue;
                let meta: any;
                try {
                    meta = readJson(metaP);
                } catch {
                    continue;
                }
                if (meta.isPlugin && (meta.loadPluginInWeb ?? true)) {
                    out.push("assets/" + relative(ASSETS, p));
                }
            }
        }
    };
    walk(ASSETS);
    return out;
}

/** bundle 分类:subpackages(非 remote、非 resources 的 asset bundle,Entry 优先其余字母序)/ remoteBundles(字母序) */
export function classifyBundles(): { subpackages: string[]; remoteBundles: string[]; hasResources: boolean } {
    const bundles = discoverBundles();
    const subpackages = bundles
        .filter((b) => !b.isRemote && b.name !== "resources")
        .map((b) => b.name)
        .sort((a, b) => (a === "Entry" ? -1 : b === "Entry" ? 1 : a.localeCompare(b)));
    const remoteBundles = bundles
        .filter((b) => b.isRemote)
        .map((b) => b.name)
        .sort();
    const hasResources = bundles.some((b) => b.name === "resources");
    return { subpackages, remoteBundles, hasResources };
}

/** 从 start-scene uuid 反查 launchScene 的 db url */
export function launchSceneUrl(startSceneUuid: string): string {
    const meta = assetMetaMap().get(startSceneUuid);
    if (!meta) throw new Error(`找不到 start-scene 资源: ${startSceneUuid}`);
    return `db://assets/${meta.path}.fire`;
}

export interface GameTemplateOptions {
    /** bundleName -> config.<md5> 的 md5(含 internal/resources/main 及各 bundle) */
    bundleVers: Record<string, string>;
}

/** 生成 _CCSettings 对象(字段顺序贴近真实 build) */
export function buildSettings(opts: GameTemplateOptions): Record<string, any> {
    const proj = readJson(join(PROJECT_ROOT, "settings/project.json"));
    const wx = platformSettings();
    const { subpackages, remoteBundles, hasResources } = classifyBundles();
    return {
        platform: platform(),
        groupList: proj["group-list"] ?? ["default"],
        collisionMatrix: proj["collision-matrix"] ?? [[true]],
        hasResourcesBundle: hasResources,
        hasStartSceneBundle: !!wx.startSceneAssetBundle,
        remoteBundles,
        subpackages,
        launchScene: launchSceneUrl(proj["start-scene"]),
        orientation: wx.orientation ?? "portrait",
        server: wx.REMOTE_SERVER_ROOT ?? "",
        jsList: scanPluginJsList(),
        bundleVers: opts.bundleVers,
    };
}

/** src/settings.js */
export function genSettingsJs(opts: GameTemplateOptions): string {
    return `window._CCSettings=${JSON.stringify(buildSettings(opts))};`;
}

/** ccRequire.js:强制 require 所有 plugin/内置 bundle/remote bundle 脚本 */
export function genCcRequireJs(): string {
    const { remoteBundles, hasResources } = classifyBundles();
    const jsList = scanPluginJsList();
    const mods: string[] = [];
    for (const js of jsList) mods.push("src/" + js); // plugin 脚本(src/ 前缀)
    mods.push("assets/internal/index.js");
    if (hasResources) mods.push("assets/resources/index.js");
    for (const r of remoteBundles) mods.push(`src/scripts/${r}/index.js`);
    mods.push("assets/main/index.js");
    const entries = mods.map((m) => `${JSON.stringify(m)}:()=>require(${JSON.stringify(m)})`).join(",");
    return (
        `let s={${entries}};` +
        `window.__cocos_require__=function(e){let r=s[e];if(!r)throw new Error("cannot find module "+e);return r()};`
    );
}

/** game.json */
export function genGameJson(): string {
    const wx = platformSettings();
    const { subpackages } = classifyBundles();
    const obj = {
        deviceOrientation: wx.orientation ?? "portrait",
        networkTimeout: { request: 5000, connectSocket: 5000, uploadFile: 5000, downloadFile: 5000 },
        subpackages: subpackages.map((name) => ({ name, root: `subpackages/${name}` })),
        iOSHighPerformance: false,
        "iOSHighPerformance+": false,
    };
    return JSON.stringify(obj, null, 4);
}

// ───────────────────── 模板(基本固定) ─────────────────────

/**
 * game.js:小游戏入口,加载顺序固定。项目特定的 plugin 全局注入(原写死的 MinigameRtc)
 * 抽成 config.bootExtras,在 require("./src/settings") 之后、require("./main") 之前注入。
 */
function genGameJs(): string {
    const extras = projectConfig()
        .bootExtras.map((e) => (e.global ? `window.${e.global}=require(${JSON.stringify(e.module)})` : `require(${JSON.stringify(e.module)})`))
        .join(",");
    const extrasPart = extras ? extras + "," : "";
    return (
        `"use strict";require("adapter-min.js"),__globalAdapter.init(),require("cocos/cocos2d-js-min.js"),` +
        `__globalAdapter.adaptEngine(),require("./ccRequire"),require("./src/settings"),` +
        `${extrasPart}require("./main"),` +
        `cc.view._maxPixelRatio=4,cc.sys.platform!==cc.sys.WECHAT_GAME_SUB&&(cc.macro.CLEANUP_IMAGE_CACHE=!0),` +
        `require("hook.js"),window.boot();`
    );
}

/** main.js:window.boot —— assetManager.init + loadScript(jsList) + loadBundle(internal/resources/main) */
const MAIN_JS =
    `"use strict";window.boot=function(){var e=window._CCSettings;window._CCSettings=void 0;` +
    `var n=function(){cc.view.enableRetina(!0),cc.view.resizeWithBrowserSize(!0);var n=e.launchScene;` +
    `cc.director.loadScene(n,null,function(){console.log("Success to load scene: "+n)})},` +
    `s=cc.sys.platform===cc.sys.WECHAT_GAME_SUB,a={id:"GameCanvas",debugMode:e.debug?cc.debug.DebugMode.INFO:cc.debug.DebugMode.ERROR,` +
    `showFPS:!s&&e.debug,frameRate:60,groupList:e.groupList,collisionMatrix:e.collisionMatrix};` +
    `cc.assetManager.init({bundleVers:e.bundleVers,subpackages:e.subpackages,remoteBundles:e.remoteBundles,server:e.server,subContextRoot:e.subContextRoot});` +
    `var c=cc.AssetManager.BuiltinBundleName.RESOURCES,t=cc.AssetManager.BuiltinBundleName.INTERNAL,r=cc.AssetManager.BuiltinBundleName.MAIN,o=cc.AssetManager.BuiltinBundleName.START_SCENE,u=[t];` +
    `e.hasResourcesBundle&&u.push(c),e.hasStartSceneBundle&&u.push(r);var i=0;` +
    `function l(s){if(s)return console.error(s.message,s.stack);++i===u.length+1&&cc.assetManager.loadBundle(e.hasStartSceneBundle?o:r,function(e){e||cc.game.run(a,n)})}` +
    `cc.assetManager.loadScript(e.jsList.map(function(e){return"src/"+e}),l);for(var d=0;d<u.length;d++)cc.assetManager.loadBundle(u[d],l)};`;

/** hook.js:暴露 bundleVers/remoteBundles;remoteBundleUrlDev 由发布脚本按本机 IP 改写 */
const HOOK_JS =
    `window.bundleVers=window._CCSettings.bundleVers,window.remoteBundles=window._CCSettings.remoteBundles;\n` +
    `window.remoteBundleUrlDev = "";\n`;

function genProjectConfigJson(appid: string): string {
    const cfg = projectConfig();
    const obj = {
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
    };
    return JSON.stringify(obj, null, 4);
}

const PROJECT_PRIVATE_JSON = JSON.stringify(
    { setting: { bigPackageSizeSupport: true, useStaticServer: true } },
    null,
    2,
);

/** 写出 game 样板全部生成+模板文件到 outRoot(不含引擎/plugin 拷贝) */
export function writeGameTemplate(outRoot: string, opts: GameTemplateOptions): void {
    const wx = platformSettings();
    mkdirSync(join(outRoot, "src"), { recursive: true });

    const files: Array<[string, string]> = [
        ["game.js", genGameJs()],
        ["main.js", MAIN_JS],
        ["hook.js", HOOK_JS],
        ["ccRequire.js", genCcRequireJs()],
        ["game.json", genGameJson()],
        ["project.config.json", genProjectConfigJson(wx.appid)],
        ["project.private.config.json", PROJECT_PRIVATE_JSON],
        ["src/settings.js", genSettingsJs(opts)],
    ];
    for (const [rel, content] of files) {
        writeFileSync(join(outRoot, rel), content);
        log(`写出 ${rel} (${content.length}B)`);
    }
}
