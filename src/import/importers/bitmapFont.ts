/**
 * bitmap-font(.fnt / BMFont 文本)importer:产出 cc.BitmapFont。
 *  - _fntConfig: 解析 .fnt 的 info/common/page/char/kerning 行
 *  - spriteFrame: meta.textureUuid 对应纹理的 sprite-frame 子资源(反查)
 *  - fontSize: meta.fontSize
 *
 * native 无(贴图是独立 texture/sprite-frame 资源)。
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Importer, ImportCtx, ImportResult } from "../types.js";
import { spriteFrameForTexture } from "../metaIndex.js";

/** 解析一行 BMFont:`tag key=value key="str" ...` → {tag, attrs} */
function parseLine(line: string): { tag: string; attrs: Record<string, string> } {
    const attrs: Record<string, string> = {};
    const m = line.match(/^(\w+)\s*(.*)$/);
    if (!m) return { tag: "", attrs };
    const tag = m[1];
    // key=value(value 可为 "带空格的字符串" 或 无空格 token)
    const re = /(\w+)=("[^"]*"|\S+)/g;
    let g: RegExpExecArray | null;
    while ((g = re.exec(m[2]))) {
        let v = g[2];
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        attrs[g[1]] = v;
    }
    return { tag, attrs };
}

interface FntConfig {
    commonHeight: number;
    fontSize: number;
    atlasName: string;
    fontDefDictionary: Record<string, { rect: { x: number; y: number; width: number; height: number }; xOffset: number; yOffset: number; xAdvance: number }>;
    kerningDict: Record<string, number>;
}

function parseFnt(text: string): FntConfig {
    const cfg: FntConfig = { commonHeight: 0, fontSize: 0, atlasName: "", fontDefDictionary: {}, kerningDict: {} };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const { tag, attrs } = parseLine(line);
        const num = (k: string) => parseInt(attrs[k], 10) || 0;
        switch (tag) {
            case "info":
                cfg.fontSize = num("size");
                break;
            case "common":
                cfg.commonHeight = num("lineHeight");
                break;
            case "page":
                if (!cfg.atlasName) cfg.atlasName = attrs.file || "";
                break;
            case "char":
                cfg.fontDefDictionary[String(num("id"))] = {
                    rect: { x: num("x"), y: num("y"), width: num("width"), height: num("height") },
                    xOffset: num("xoffset"),
                    yOffset: num("yoffset"),
                    xAdvance: num("xadvance"),
                };
                break;
            case "kerning":
                // cocos: key = (first << 16) | (second & 0xffff)
                cfg.kerningDict[String((num("first") << 16) | (num("second") & 0xffff))] = num("amount");
                break;
        }
    }
    return cfg;
}

export const bitmapFontImporter: Importer = {
    name: "bitmap-font",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const { uuid, meta, srcPath } = ctx;
        const cfg = parseFnt(readFileSync(srcPath, "utf8"));
        const sf = spriteFrameForTexture(meta.textureUuid);
        return new Map([
            [
                uuid,
                {
                    object: {
                        __type__: "cc.BitmapFont",
                        _name: basename(srcPath, extname(srcPath)),
                        _objFlags: 0,
                        _native: "",
                        fntDataStr: "",
                        spriteFrame: sf ? { __uuid__: sf } : null,
                        fontSize: meta.fontSize,
                        _fntConfig: cfg,
                        _fontDefDictionary: null,
                    },
                },
            ],
        ]);
    },
};
