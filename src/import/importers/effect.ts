/**
 * effect importer:.effect(CCEffect YAML + CCProgram GLSL)→ cc.EffectAsset。
 * 自研 cocos-effect 离线编译器,字节级复刻(见 docs/10、import/effect/)。
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Importer, ImportCtx, ImportResult } from "../types.js";
import { compileEffect } from "../effect/compile.js";

export const effectImporter: Importer = {
    name: "effect",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const name = basename(ctx.srcPath, extname(ctx.srcPath));
        const object = compileEffect(name, readFileSync(ctx.srcPath, "utf8"));
        return new Map([[ctx.uuid, { object }]]);
    },
};
