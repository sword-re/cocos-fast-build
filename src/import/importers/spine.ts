/**
 * spine(sp.SkeletonData)importer:产出
 *  - _skeletonJson: 源 .json(骨骼数据)解析
 *  - _atlasText:   同名 .atlas 文本原样
 *  - textures:     meta.textures(uuid 数组)→ [{__uuid__}]
 *  - textureNames: 从 .atlas 解析出的页(贴图)名
 *  - scale:        meta.scale
 *
 * native 无(贴图是独立 texture 资源,经 textures 引用)。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Importer, ImportCtx, ImportResult } from "../types.js";

/** spine 的图集伴生文件扩展名(不同导出工具:.atlas 或 .atlas.txt) */
const ATLAS_EXTS = [".atlas", ".atlas.txt"];

/** 在源同目录按候选扩展名找 atlas 文件 */
function resolveAtlasPath(srcPath: string): string {
    const dir = dirname(srcPath);
    const base = basename(srcPath, extname(srcPath));
    for (const ext of ATLAS_EXTS) {
        const p = join(dir, base + ext);
        if (existsSync(p)) return p;
    }
    throw new Error(`spine 缺 atlas 伴生文件: ${base}`);
}

/** spine .atlas 的页名:被空行(或文件首)隔开、且不含 ':' 的非空行(区域名前一行非空,据此区分) */
function parseAtlasPageNames(atlasText: string): string[] {
    const lines = atlasText.split(/\r?\n/);
    const pages: string[] = [];
    let prevBlank = true;
    for (const line of lines) {
        const t = line.trim();
        if (t && prevBlank && !t.includes(":")) pages.push(t);
        prevBlank = t === "";
    }
    return pages;
}

export const spineImporter: Importer = {
    name: "spine",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const { uuid, meta, srcPath } = ctx;
        const skeletonJson = JSON.parse(readFileSync(srcPath, "utf8"));
        const atlasText = readFileSync(resolveAtlasPath(srcPath), "utf8");
        const textures = (meta.textures || []).map((u: string) => ({ __uuid__: u }));

        return new Map([
            [
                uuid,
                {
                    object: {
                        __type__: "sp.SkeletonData",
                        _name: basename(srcPath, extname(srcPath)),
                        _objFlags: 0,
                        _native: "",
                        _skeletonJson: skeletonJson,
                        _atlasText: atlasText,
                        textures,
                        textureNames: parseAtlasPageNames(atlasText),
                        scale: meta.scale,
                    },
                },
            ],
        ]);
    },
};
