/**
 * GLSL chunk 库(vendor 自引擎 renderer/build/chunks → data/effect-chunks/)。
 * 提供 #include <name> 的递归展开(原始文本拼接,供反射/进一步预处理)。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const CHUNK_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../data/effect-chunks");

const _cache = new Map<string, string>();
function chunk(name: string): string {
    let c = _cache.get(name);
    if (c !== undefined) return c;
    const p = join(CHUNK_DIR, `${name}.inc`);
    c = existsSync(p) ? readFileSync(p, "utf8") : "";
    _cache.set(name, c);
    return c;
}

const INCLUDE_RE = /#include\s+<([^>]+)>/g;

/** 递归展开 #include <x>;visited 防环 */
export function expandIncludes(src: string, visited = new Set<string>()): string {
    return src.replace(INCLUDE_RE, (_m, name: string) => {
        if (visited.has(name)) return "";
        visited.add(name);
        return expandIncludes(chunk(name), visited);
    });
}
