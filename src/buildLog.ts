/**
 * cocos 风格的构建日志(在 log.ts 的带时间戳行内复刻 cocos 构建器的文案/进度条)。
 *
 * 复刻真实 `CocosCreator --build` 控制台输出:
 *   Start to build platform [mini-game]
 *   [  building [Common] assets [======...        ] 61% 19.2s  ][61208]
 *   --- build-asset: {json}
 *   [61208] Warning: ... has not been packed into AutoAtlas.
 *   Built wechatgame successfully
 *
 * 与 cocos 的差异(有意保留,便于做耗时分析):每行仍带我们 log() 的
 * `[HH:MM:SS.mmm] [+Δms]` 前缀 —— Δ 即"该 bundle 装配耗时",比 cocos 的 ETA 更直接。
 */
import { log } from "./log.js";

const PID = process.pid;
let _platform = "mini-game";
let _t0 = Date.now();

/** wechatgame 平台在 cocos 里显示为 [mini-game] */
export function buildStart(platform: string): void {
    _platform = platform === "wechatgame" ? "mini-game" : platform;
    _t0 = Date.now();
    log(`Start to build platform [${_platform}]`, "");
}

function bar(pct: number, w = 40): string {
    const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
    return "[" + "=".repeat(n) + " ".repeat(w - n) + "]";
}

/** 由已用时与百分比估算剩余秒(复刻 cocos 的 ETA 显示) */
function etaSec(pct: number): string {
    const elapsed = (Date.now() - _t0) / 1000;
    const remain = pct > 0 ? (elapsed / pct) * (100 - pct) : 0;
    return remain.toFixed(1) + "s";
}

/** cocos 进度行:`[  building [name] assets [===...] NN% ETAs  ][pid]` */
export function buildProgress(label: string, cur: number, total: number): void {
    const pct = total > 0 ? Math.round((cur / total) * 100) : 100;
    log(`[  building [${label}] assets ${bar(pct)} ${pct}% ${etaSec(pct)}  ][${PID}]`, "");
}

/** 任意阶段进度行(compile / init build-worker 等),pct 自定 */
export function buildPhase(label: string, pct: number, msg = ""): void {
    log(`[  ${label} ${bar(pct)} ${pct}% ${etaSec(pct)}  ][${PID}]${msg ? " " + msg : ""}`, "");
}

/** cocos 的 `--- build-asset: {...}` 行 */
export function buildAsset(info: Record<string, unknown>): void {
    log(`--- build-asset: ${JSON.stringify(info)}`, "");
}

export function buildWarning(msg: string): void {
    log(`[${PID}] Warning: ${msg}`, "");
}

export function buildSuccess(platform: string): void {
    const name = platform === "mini-game" ? "wechatgame" : platform;
    log(`Built ${name} successfully`, "");
}
