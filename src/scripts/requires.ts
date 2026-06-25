/**
 * 从脚本核心代码静态提取 require() 的字面量参数。
 *
 * tsc 输出里所有模块引用都是字面量 require("..."),无动态 require。
 * 收集这些字符串供打包器解析成 depMap(require 字符串 -> 目标模块 key)。
 */

const REQUIRE_RE = /\brequire\(\s*(['"])((?:\\.|(?!\1).)*?)\1\s*\)/g;

/** 提取去重后的 require 字面量参数(保持首次出现顺序) */
export function extractRequires(core: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    let m: RegExpExecArray | null;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(core))) {
        const req = m[2];
        if (!seen.has(req)) {
            seen.add(req);
            out.push(req);
        }
    }
    return out;
}

/** 是否相对路径引用(./ 或 ../) */
export function isRelative(req: string): boolean {
    return req.startsWith("./") || req.startsWith("../");
}
