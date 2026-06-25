/**
 * 自定义序列化对象(packCustomObjData 模式)。
 * 仅 3 个类有自定义 _serialize:cc.Texture2D / cc.RenderTexture / cc.SpriteFrame。
 *
 * Texture2D/RenderTexture:content 为编码字符串,带 native 依赖。
 * SpriteFrame 较特殊(content + 贴图资源依赖),单独在 spriteFrame.ts 处理。
 *
 * packCustomObjData 模板(engine deserialize-compiled.ts L997):
 *   [1, 0, 0, [type], 0, hasNativeDep ? [data, ~0] : [data], [0], 0, [], [], []]
 */
import { EMPTY, FORMAT_VERSION, type IFileData } from "../format.js";

export function packCustomObjData(type: string, content: unknown, hasNativeDep: boolean): IFileData {
    return [
        FORMAT_VERSION,
        EMPTY, // SharedUuids
        EMPTY, // SharedStrings
        [type], // SharedClasses(字符串 => 自定义类)
        EMPTY, // SharedMasks
        hasNativeDep ? [content, ~0] : [content], // Instances [data, RootInfo?]
        [0], // InstanceTypes -> custom class 0
        EMPTY, // Refs
        [], // DependObjs
        [], // DependKeys
        [], // DependUuidIndices
    ];
}

/** Texture2D / RenderTexture:library 形如 { __type__, content:"..." },恒有 native 依赖 */
export function serializeTexture2D(lib: any): IFileData {
    return packCustomObjData(lib.__type__, lib.content, true);
}
