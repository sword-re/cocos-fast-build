/**
 * material(.mtl) / animation-clip(.anim) importer:
 * 源文件本身就是序列化好的 CCClass JSON,import 几乎 == 源;唯一变换:_name ← 文件名
 *(源里 _name 可能是旧名/test,cocos 以文件名为准)。
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Importer, ImportCtx, ImportResult } from "../types.js";

function passthrough(name: string): Importer {
    return {
        name,
        import(ctx: ImportCtx): Map<string, ImportResult> {
            const obj = JSON.parse(readFileSync(ctx.srcPath, "utf8"));
            if (obj && typeof obj === "object" && "_name" in obj) {
                obj._name = basename(ctx.srcPath, extname(ctx.srcPath));
            }
            return new Map([[ctx.uuid, { object: obj }]]);
        },
    };
}

export const materialImporter = passthrough("material");
export const animationImporter = passthrough("animation-clip");
