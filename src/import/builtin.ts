/**
 * 引擎内置资源(无项目 meta)从快照 data/builtin-imports/ 读取(由 snapshot-builtins 生成)。
 * 这些是 builtin effect/material/白纹理等,无源码可生成,快照后构建即不依赖 library/imports。
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportResult } from "./types.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../data/builtin-imports");

let _cache: Map<string, ImportResult> | null = null;

/** 加载内置快照 → uuid -> ImportResult(object + 可选 native) */
export function builtinImports(): Map<string, ImportResult> {
    if (_cache) return _cache;
    const map = new Map<string, ImportResult>();
    if (!existsSync(DIR)) return (_cache = map);
    for (const sub of readdirSync(DIR)) {
        const subDir = join(DIR, sub);
        let entries: string[];
        try {
            entries = readdirSync(subDir);
        } catch {
            continue;
        }
        // 先收 json(主对象),再挂 native
        const natives = new Map<string, { kind: "flat" | "dir"; ext?: string; filename?: string; source: string }>();
        for (const f of entries) {
            if (f.endsWith(".json")) continue;
            const p = join(subDir, f);
            if (statSync(p).isDirectory()) {
                // dir 布局:<uuid>/<filename>
                const inner = readdirSync(p);
                if (inner[0]) natives.set(f, { kind: "dir", filename: inner[0], source: join(p, inner[0]) });
            } else {
                const dot = f.indexOf(".");
                const uuid = dot > 0 ? f.slice(0, dot) : f;
                natives.set(uuid, { kind: "flat", ext: f.slice(dot), source: p });
            }
        }
        for (const f of entries) {
            if (!f.endsWith(".json")) continue;
            const uuid = f.slice(0, -5);
            let object: any;
            try {
                object = JSON.parse(readFileSync(join(subDir, f), "utf8"));
            } catch {
                continue;
            }
            const nat = natives.get(uuid);
            map.set(uuid, nat ? { object, native: nat as any } : { object });
        }
    }
    return (_cache = map);
}
