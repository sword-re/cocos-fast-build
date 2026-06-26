/**
 * 资源 import 框架的公共类型。
 *
 * importer 的产出 = "反序列化中间对象"(与 library/imports/<uuid>.json 解析后同构),
 * 再喂给现有 serialize/ 与 libraryIndex 的 toRec()。详见 docs/fast-build/09-asset-import.md。
 */
import type { MetaRecord } from "../metaScan.js";

/** native 文件布局 */
export type NativeLayout =
    /** 扁平:native/<sub>/<uuid>.<md5><ext>(纹理/音频) */
    | { kind: "flat"; ext: string; source: string | Buffer }
    /** 目录:native/<sub>/<uuid>.<md5>/<filename>(字体等带原文件名) */
    | { kind: "dir"; filename: string; source: string | Buffer };

/** 单个资源(uuid)的 import 产物 */
export interface ImportResult {
    /** 反序列化中间对象;喂给 serializeAsset() 与 toRec() */
    object: any;
    /** native 文件(可选) */
    native?: NativeLayout;
}

/** importer 执行上下文:一条主 .meta 记录 */
export interface ImportCtx {
    /** 主资源 uuid */
    uuid: string;
    /** 解析后的 .meta */
    meta: any;
    /** 资源源文件绝对路径(.meta 去掉后缀) */
    srcPath: string;
    /** importer 名(meta.importer) */
    importer: string;
    /** 完整 meta 记录 */
    record: MetaRecord;
}

/**
 * 一个 importer 把一条主 .meta 转成 1..n 个资源对象(主资源 + 各 subMeta 子资源)。
 * 返回 uuid -> ImportResult。纯函数,不写盘(写盘由 assemble 统一做)。
 */
export interface Importer {
    /** importer 名(对齐 cocos 的 meta.importer),用于注册分发 */
    readonly name: string;
    import(ctx: ImportCtx): Map<string, ImportResult>;
}
