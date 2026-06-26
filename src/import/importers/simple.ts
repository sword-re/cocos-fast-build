/**
 * 简单叶子资源 importer:audio / ttf-font / text / json。
 * 全部字段从源文件 + .meta 派生(audio 的 duration 就在 .meta 里,无需解码)。
 */
import { readFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Importer, ImportCtx, ImportResult } from "../types.js";

function baseName(srcPath: string): string {
    return basename(srcPath, extname(srcPath));
}

/** audio-clip:_native=源扩展名(".mp3"),duration/loadMode 来自 meta;native = 源音频直拷(扁平) */
export const audioImporter: Importer = {
    name: "audio-clip",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const ext = extname(ctx.srcPath).toLowerCase();
        return new Map([
            [
                ctx.uuid,
                {
                    object: {
                        __type__: "cc.AudioClip",
                        _name: baseName(ctx.srcPath),
                        _objFlags: 0,
                        _native: ext,
                        duration: ctx.meta.duration,
                        loadMode: ctx.meta.downloadMode ?? 0,
                    },
                    native: { kind: "flat", ext, source: ctx.srcPath },
                },
            ],
        ]);
    },
};

/** ttf-font:_native=源文件名(含扩展);native = 源 ttf(目录布局 <uuid>/<filename>) */
export const ttfFontImporter: Importer = {
    name: "ttf-font",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const filename = basename(ctx.srcPath);
        return new Map([
            [
                ctx.uuid,
                {
                    object: {
                        __type__: "cc.TTFFont",
                        _name: baseName(ctx.srcPath),
                        _objFlags: 0,
                        _native: filename,
                        _fontFamily: null,
                    },
                    native: { kind: "dir", filename, source: ctx.srcPath },
                },
            ],
        ]);
    },
};

/** text:源文本原样塞进 text 字段 */
export const textImporter: Importer = {
    name: "text",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        return new Map([
            [
                ctx.uuid,
                {
                    object: {
                        __type__: "cc.TextAsset",
                        _name: baseName(ctx.srcPath),
                        _objFlags: 0,
                        _native: "",
                        text: readFileSync(ctx.srcPath, "utf8"),
                    },
                },
            ],
        ]);
    },
};

/** asset:通用裸资源(.ps1/.sh/.atlas 等),仅壳 + native 直拷(扁平,源扩展名) */
export const rawAssetImporter: Importer = {
    name: "asset",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        // 源缺失的孤儿 meta(如 .ts 删了但 .ts.meta 残留):cocos 不 import,跳过以免装配读盘 ENOENT
        if (!existsSync(ctx.srcPath)) return new Map();
        const ext = extname(ctx.srcPath);
        return new Map([
            [
                ctx.uuid,
                {
                    object: { __type__: "cc.Asset", _name: baseName(ctx.srcPath), _objFlags: 0, _native: ext },
                    native: { kind: "flat", ext, source: ctx.srcPath },
                },
            ],
        ]);
    },
};

/** json:解析源 JSON 塞进 json 字段 */
export const jsonImporter: Importer = {
    name: "json",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        return new Map([
            [
                ctx.uuid,
                {
                    object: {
                        __type__: "cc.JsonAsset",
                        _name: baseName(ctx.srcPath),
                        _objFlags: 0,
                        _native: "",
                        json: JSON.parse(readFileSync(ctx.srcPath, "utf8")),
                    },
                },
            ],
        ]);
    },
};
