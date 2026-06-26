/**
 * texture importer:一张图片 → cc.Texture2D(主) + 各 sprite-frame 子资源(subMetas)。
 *
 * 全部字段从 .meta 派生,无需读 library(native = 源图字节直拷,已验证字节一致)。
 *
 * Texture2D.content = "extId,minFilter,magFilter,wrapS,wrapT,premultiply,genMipmaps,packable"
 *   —— 字段语义取自引擎 CCTexture2D.js _serialize(非经验猜测):
 *   - extId: native 扩展名在 Texture2D.extnames 的索引,越界则取扩展名字符串本身
 *            extnames=['.png','.jpg','.jpeg','.bmp','.webp','.pvr','.pkm','.astc']
 *            (这解释了 .jpeg=2:它是第 3 项,非像素格式)
 *   - min/magFilter: point→9728(NEAREST),bilinear/trilinear→9729(LINEAR)
 *   - wrapS/T: repeat→10497,clamp(及默认)→33071(CLAMP_TO_EDGE)
 *   - premultiply: premultiplyAlpha?1:0
 *   - genMipmaps: genMipmaps?1:0
 *   - packable: packable!==false?1:0
 *
 * SpriteFrame.content 各字段 ←→ subMeta(已全量比对):
 *   rect=[trimX,trimY,width,height] offset=[offsetX,offsetY]
 *   originalSize=[rawWidth,rawHeight] capInsets=[borderL,borderT,borderR,borderB](左上右下)
 */
import { extname } from "node:path";
import type { Importer, ImportCtx, ImportResult } from "../types.js";

const GL_NEAREST = 9728;
const GL_LINEAR = 9729;
const GL_REPEAT = 10497;
const GL_CLAMP_TO_EDGE = 33071;

/** 引擎 Texture2D.extnames(CCTexture2D.js):native 扩展名 → content 首字段索引 */
const EXTNAMES = [".png", ".jpg", ".jpeg", ".bmp", ".webp", ".pvr", ".pkm", ".astc"];

function extId(srcPath: string): string {
    const ext = extname(srcPath).toLowerCase();
    const i = EXTNAMES.indexOf(ext);
    return i >= 0 ? String(i) : ext; // 越界:引擎用扩展名字符串本身
}

function textureContent(meta: any, srcPath: string): string {
    const filter = meta.filterMode === "point" ? GL_NEAREST : GL_LINEAR;
    const wrap = meta.wrapMode === "repeat" ? GL_REPEAT : GL_CLAMP_TO_EDGE;
    const pma = meta.premultiplyAlpha ? 1 : 0;
    const mip = meta.genMipmaps ? 1 : 0;
    const packable = meta.packable === false ? 0 : 1;
    return `${extId(srcPath)},${filter},${filter},${wrap},${wrap},${pma},${mip},${packable}`;
}

export const textureImporter: Importer = {
    name: "texture",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const { uuid, meta, srcPath } = ctx;
        const out = new Map<string, ImportResult>();

        // 主资源:cc.Texture2D + 源图 native(扁平,源扩展名)
        out.set(uuid, {
            object: { __type__: "cc.Texture2D", content: textureContent(meta, srcPath) },
            native: { kind: "flat", ext: extname(srcPath).toLowerCase(), source: srcPath },
        });

        // 子资源:sprite-frame(subMetas);单图通常一个、key==父名
        const subs = meta.subMetas || {};
        for (const key in subs) {
            const sm = subs[key];
            if (!sm?.uuid || sm.importer !== "sprite-frame") continue;
            // 名字 = subMeta key 去掉尾随图片扩展名(cocos 对单图帧剥离 .png/.jpg)
            const name = key.replace(/\.(png|jpe?g)$/i, "");
            out.set(sm.uuid, {
                object: {
                    __type__: "cc.SpriteFrame",
                    content: {
                        name,
                        texture: sm.rawTextureUuid || uuid,
                        atlas: "",
                        rect: [sm.trimX, sm.trimY, sm.width, sm.height],
                        offset: [sm.offsetX, sm.offsetY],
                        originalSize: [sm.rawWidth, sm.rawHeight],
                        capInsets: [sm.borderLeft, sm.borderTop, sm.borderRight, sm.borderBottom],
                    },
                },
                // SpriteFrame 无独立 native(贴图在父 Texture2D)
            });
        }
        return out;
    },
};
