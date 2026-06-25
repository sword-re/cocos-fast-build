/**
 * 带时间戳的分阶段日志。
 *
 * 格式:`[HH:MM:SS.mmm] [+Δms] [scope] message`
 *  - 绝对时钟时间(墙钟)
 *  - 距上一条日志的增量耗时(Δ),用于一眼看出每步耗时
 *  - 可选 scope(阶段/子系统名)
 *
 * 另提供 timer():打点计时,在结束时打印总耗时。
 */

function pad(n: number, w = 2): string {
    return String(n).padStart(w, "0");
}

function clock(d: Date): string {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

let _last = Date.now();
let _scope = "";

/** 设置当前日志 scope(阶段名),后续 log() 自动带上 */
export function setScope(scope: string): void {
    _scope = scope;
}

/** 打印一条带时间戳 + 增量耗时的日志 */
export function log(msg: string, scope?: string): void {
    const now = Date.now();
    const delta = now - _last;
    _last = now;
    const s = scope ?? _scope;
    const scopeStr = s ? ` [${s}]` : "";
    const deltaStr = `+${String(delta).padStart(5)}ms`;
    process.stdout.write(`[${clock(new Date(now))}] [${deltaStr}]${scopeStr} ${msg}\n`);
}

/** 阶段计时累计 */
interface PhaseRec {
    title: string;
    ms: number;
}
let _phases: PhaseRec[] = [];
let _curPhase: { title: string; start: number } | null = null;

/** 阶段分隔标题(同时为上一阶段计时) */
export function phase(title: string): void {
    const now = Date.now();
    if (_curPhase) _phases.push({ title: _curPhase.title, ms: now - _curPhase.start });
    _curPhase = { title, start: now };
    setScope(title);
    log(`━━━ ${title} ━━━`, "");
}

/** 打印各阶段耗时 + 总耗时,并清空累计 */
export function phaseSummary(): void {
    const now = Date.now();
    if (_curPhase) {
        _phases.push({ title: _curPhase.title, ms: now - _curPhase.start });
        _curPhase = null;
    }
    if (!_phases.length) return;
    const total = _phases.reduce((a, p) => a + p.ms, 0);
    log("━━━ 阶段耗时汇总 ━━━", "");
    for (const p of _phases) log(`  ${p.title.padEnd(30)}${String(p.ms).padStart(7)}ms`, "");
    log(`  ${"总计".padEnd(29)}${String(total).padStart(7)}ms`, "");
    _phases = [];
}

/** 计时器:start 返回一个 end 函数,end(label) 打印该段总耗时 */
export function timer(label: string): () => void {
    const t0 = Date.now();
    log(`▶ ${label} ...`);
    return () => {
        const dt = Date.now() - t0;
        log(`✔ ${label} 完成 (耗时 ${dt}ms)`);
    };
}

/** 把字节数格式化为人类可读 */
export function humanBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(2)}MB`;
}
