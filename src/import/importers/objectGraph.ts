/**
 * prefab / scene importer:源 .prefab / .fire 本身就是序列化对象图数组,
 * import 几乎等于源数组,仅少量 importer 变换(已全量 diff 验证):
 *   - prefab: 首元素 cc.Prefab._name ← 文件名(源里为 "");optimizationPolicy/asyncLoadAssets ← .meta
 *   - scene:  首元素 cc.SceneAsset._name ← 文件名 + 补默认 asyncLoadAssets:false
 *
 * 脚本组件的 __type__ 在源里**已是压缩 uuid**,无需再处理。
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Importer, ImportCtx, ImportResult } from "../types.js";

function baseName(srcPath: string): string {
    return basename(srcPath, extname(srcPath));
}

function loadGraph(srcPath: string): any[] {
    const arr = JSON.parse(readFileSync(srcPath, "utf8"));
    if (!Array.isArray(arr)) throw new Error("对象图源不是数组");
    return arr;
}

/** cc.Prefab.OptimizationPolicy 枚举字符串 → 数值 */
const OPTIMIZATION_POLICY: Record<string, number> = { AUTO: 0, SINGLE_INSTANCE: 1, MULTI_INSTANCE: 2 };

export const prefabImporter: Importer = {
    name: "prefab",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const arr = loadGraph(ctx.srcPath);
        const head = arr[0];
        if (head && head.__type__ === "cc.Prefab") {
            head._name = baseName(ctx.srcPath);
            head.optimizationPolicy = OPTIMIZATION_POLICY[ctx.meta.optimizationPolicy] ?? 0;
            head.asyncLoadAssets = ctx.meta.asyncLoadAssets ?? false;
        }
        return new Map([[ctx.uuid, { object: arr }]]);
    },
};

export const sceneImporter: Importer = {
    name: "scene",
    import(ctx: ImportCtx): Map<string, ImportResult> {
        const arr = loadGraph(ctx.srcPath);
        const head = arr[0];
        if (head && head.__type__ === "cc.SceneAsset") {
            head._name = baseName(ctx.srcPath);
            if (!("asyncLoadAssets" in head)) head.asyncLoadAssets = false;
        }
        return new Map([[ctx.uuid, { object: arr }]]);
    },
};
