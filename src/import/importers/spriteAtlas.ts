/**
 * sprite-atlas(.plist / TexturePacker)importer:产出
 *  - cc.SpriteAtlas:_spriteFrames = { 帧名: {__uuid__} }(帧名去尾随 .png)
 *  - 各成员 cc.SpriteFrame:结构同 texture 子帧,但 atlas 指向本图集 uuid
 *
 * 图集纹理(.png 主资源)由 texture importer 单独产出(其 .meta type=raw,无子帧),此处不管。
 */
import { basename } from "node:path";
import type { Importer, ImportCtx, ImportResult } from "../types.js";

function frameName(key: string): string {
    return key.replace(/\.(png|jpe?g)$/i, "");
}

export const spriteAtlasImporter: Importer = {
    name: "sprite-atlas",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const { uuid, meta, srcPath } = ctx;
        const out = new Map<string, ImportResult>();
        const spriteFrames: Record<string, { __uuid__: string }> = {};

        const subs = meta.subMetas || {};
        for (const key in subs) {
            const sm = subs[key];
            if (!sm?.uuid || sm.importer !== "sprite-frame") continue;
            const name = frameName(key);
            spriteFrames[name] = { __uuid__: sm.uuid };
            out.set(sm.uuid, {
                object: {
                    __type__: "cc.SpriteFrame",
                    content: {
                        name,
                        texture: sm.rawTextureUuid,
                        atlas: uuid, // 成员帧归属本图集(与 texture 散帧 atlas="" 区别)
                        rect: [sm.trimX, sm.trimY, sm.width, sm.height],
                        offset: [sm.offsetX, sm.offsetY],
                        originalSize: [sm.rawWidth, sm.rawHeight],
                        capInsets: [sm.borderLeft, sm.borderTop, sm.borderRight, sm.borderBottom],
                    },
                },
            });
        }

        out.set(uuid, {
            object: {
                __type__: "cc.SpriteAtlas",
                _name: basename(srcPath), // 含扩展名,如 "msgIcons.plist"
                _objFlags: 0,
                _native: "",
                _spriteFrames: spriteFrames,
            },
        });
        return out;
    },
};
