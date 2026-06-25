/**
 * 自研 auto-atlas 打包的数据模型。
 *
 * 目标:完全脱离编辑器 temp/TexturePacker 缓存,由 fast-build 自己读 .pac 配置、收集
 * packable 帧、bin-pack 排版、用 sharp 合成大图,产出与原 atlas.ts 完全一致的 AtlasFrame。
 *
 * 关键不变量:大图与 SpriteFrame 的 rect 都由本工具生成,只需"自洽"——运行时按我们写入
 * 的 rect 去我们合成的大图里采样即可,无需逐像素复刻编辑器算法。
 */

/** .pac(auto-atlas)的打包配置(取自 .pac.meta) */
export interface PacConfig {
    pacUuid: string; // .pac(SpriteAtlas)uuid
    name: string; // .pac 文件名(不含扩展名)
    dir: string; // 作用域目录(.pac 所在目录子树)
    maxWidth: number;
    maxHeight: number;
    padding: number; // 帧间留白
    allowRotation: boolean;
    forceSquared: boolean;
    powerOfTwo: boolean;
    contourBleed: boolean;
    paddingBleed: boolean;
}

/** 待打包的一个 SpriteFrame(几何取自其 subMeta,源图取自 library native) */
export interface PackItem {
    spriteFrameUuid: string;
    textureUuid: string; // 原始 Texture2D uuid
    srcPng: string; // 原始纹理 native 绝对路径(library/imports/<sub>/<uuid>.<ext>)
    // 在原始纹理中的裁剪区域(top-left 原点,与 sharp.extract 一致)
    trimX: number;
    trimY: number;
    width: number; // 裁剪后(trimmed)宽
    height: number; // 裁剪后(trimmed)高
    rawWidth: number; // 原图宽
    rawHeight: number; // 原图高
    contentHash: string; // 源图内容 hash(增量缓存用)
}

/** 一帧在大图中的最终落位 */
export interface PlacedFrame {
    spriteFrameUuid: string;
    textureUuid: string;
    page: number; // 所属页索引
    x: number; // 内容在大图中的 x(top-left)
    y: number; // 内容在大图中的 y
    width: number; // = trimmed 宽
    height: number; // = trimmed 高
    rotated: boolean;
    // 合成大图所需:从源图裁剪并贴入的信息
    srcPng: string;
    trimX: number;
    trimY: number;
}

/** 一页大图 */
export interface PackedPage {
    page: number;
    width: number;
    height: number;
    frames: PlacedFrame[];
}
