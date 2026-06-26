/**
 * cocos-effect 风格 GLSL 预处理器(编译期):
 *  - 递归 #include(chunk 库)
 *  - 剥注释(// 与 /* *​/)
 *  - #define 宏(对象宏 + 函数宏,含 ## token 粘贴、\ 续行)展开,#define 行消费
 *  - #pragma 行消费
 *  - **#if/#ifdef/#elif/#else/#endif 原样保留**(留到运行时按 defines 编译)
 *  - 折叠空行(连续换行→单个,保留 1 个前导 \n,trimEnd)
 *
 * 规则由 gray-sprite 等 glsl3 产物反推,逐 effect 对 oracle 校验。
 */
import { expandIncludes } from "./chunks.js";

interface Macro {
    params: string[] | null; // null = 对象宏
    body: string;
}

/** 剥块注释 + 行注释(GLSL 无字符串字面量,直接删) */
function stripComments(s: string): string {
    return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 收集并移除 #define(处理 \ 续行:删反斜杠及其前导空白,保留换行) */
function collectDefines(text: string): { macros: Map<string, Macro>; text: string } {
    const macros = new Map<string, Macro>();
    const lines = text.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*#define\b/.test(lines[i])) {
            out.push(lines[i]);
            continue;
        }
        // 聚合续行:当前行去尾随 "空白+\" 后若原本有 \,继续并入下一行(保留 \n)
        let raw = "";
        let cur = lines[i];
        for (;;) {
            const cont = /\\\s*$/.test(cur);
            raw += cur.replace(/\s*\\\s*$/, "");
            if (cont && i + 1 < lines.length) {
                raw += "\n";
                cur = lines[++i];
            } else break;
        }
        parseDefine(raw, macros);
    }
    return { macros, text: out.join("\n") };
}

function parseDefine(raw: string, macros: Map<string, Macro>): void {
    const m = /^\s*#define\s+([A-Za-z_]\w*)(\([^)]*\))?/.exec(raw);
    if (!m) return;
    const name = m[1];
    const params = m[2] ? m[2].slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : null;
    let body = raw.slice(m[0].length);
    body = body.replace(/^[ \t]/, ""); // 去名/参后的单个分隔空白
    macros.set(name, { params, body });
}

/** 一次性把所有宏调用展开(迭代至稳定);函数宏匹配 name(args),对象宏匹配 name */
function expandMacros(text: string, macros: Map<string, Macro>): string {
    if (!macros.size) return text;
    const names = [...macros.keys()];
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (const name of names) {
            const macro = macros.get(name)!;
            const re = new RegExp(`\\b${name}\\b`, "g");
            let m: RegExpExecArray | null;
            let result = "";
            let last = 0;
            re.lastIndex = 0;
            while ((m = re.exec(text))) {
                const start = m.index;
                if (macro.params) {
                    // 函数宏:其后须紧跟 (args)
                    const open = skipSpace(text, re.lastIndex);
                    if (text[open] !== "(") continue;
                    const { args, end } = readArgs(text, open);
                    result += text.slice(last, start) + substitute(macro, args);
                    last = end;
                    re.lastIndex = end;
                } else {
                    result += text.slice(last, start) + macro.body;
                    last = re.lastIndex;
                }
                changed = true;
            }
            if (last > 0) text = result + text.slice(last);
        }
        if (!changed) break;
    }
    return text;
}

function skipSpace(s: string, i: number): number {
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
    return i;
}

/** 从 '(' 读到匹配 ')',按顶层逗号切分参数 */
function readArgs(s: string, open: number): { args: string[]; end: number } {
    const args: string[] = [];
    let depth = 0;
    let cur = "";
    let i = open;
    for (; i < s.length; i++) {
        const c = s[i];
        if (c === "(") {
            depth++;
            if (depth === 1) continue;
        } else if (c === ")") {
            depth--;
            if (depth === 0) {
                args.push(cur.trim());
                i++;
                break;
            }
        } else if (c === "," && depth === 1) {
            args.push(cur.trim());
            cur = "";
            continue;
        }
        cur += c;
    }
    return { args, end: i };
}

/** 参数代入 body + ## token 粘贴 */
function substitute(macro: Macro, args: string[]): string {
    let body = macro.body;
    const params = macro.params!;
    for (let i = 0; i < params.length; i++) {
        body = body.replace(new RegExp(`\\b${escapeRe(params[i])}\\b`, "g"), args[i] ?? "");
    }
    body = body.replace(/\s*##\s*/g, ""); // token 粘贴
    return body;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 删 #pragma 整行 */
function stripPragmas(text: string): string {
    return text
        .split("\n")
        .filter((l) => !/^\s*#pragma\b/.test(l))
        .join("\n");
}

/** 每行 trimEnd、删空行,'\n' + 非空行 join('\n')(保留 1 个前导 \n、无尾随) */
export function collapseBlankLines(text: string): string {
    const kept = text
        .split("\n")
        .map((l) => l.replace(/\s+$/, ""))
        .filter((l) => l !== "");
    return "\n" + kept.join("\n");
}

/**
 * 按最小公共缩进 dedent 源程序(CCProgram 块体通常整体缩进于 %{ 下)。
 * 仅对源生效(include 前),chunk 内容保留自身缩进。
 */
function dedent(source: string): string {
    const lines = source.split("\n");
    let min = Infinity;
    for (const l of lines) {
        if (l.trim() === "") continue;
        const lead = l.match(/^ */)![0].length;
        if (lead < min) min = lead;
    }
    if (!isFinite(min) || min === 0) return source;
    return lines.map((l) => l.slice(min)).join("\n");
}

/** 完整预处理:source(单个 program 的 GLSL)→ 编译后 GLSL(in/out 等保留,交给 glsl3/glsl1 各自处理) */
export function preprocess(source: string): string {
    let text = expandIncludes(dedent(source));
    text = stripComments(text);
    const { macros, text: t2 } = collectDefines(text);
    text = expandMacros(t2, macros);
    text = stripPragmas(text);
    text = collapseBlankLines(text);
    return text;
}
