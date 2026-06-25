/**
 * Spike 1a:SpriteFrame 序列化(自定义对象路径 / packCustomObjData 模式)。
 *
 * 输入:library 源 { __type__:"cc.SpriteFrame", content:{ name, texture, atlas, rect, offset, originalSize, capInsets } }
 * 输出:压缩 JSON,目标与真实产物字节级一致。
 *
 * 真实产物样本(非图集):
 *   [1,["<压缩texture>"],["_textureSetter"],["cc.SpriteFrame"],0,
 *    [{"name":..,"rect":..,"offset":..,"originalSize":..,"capInsets":..}],
 *    [0],0,[0],[0],[0]]
 *
 * 注意:图集内的 spriteframe 其 rect 会被改写为图集坐标(见 spec §2.7),
 *       本 spike 仅针对非图集 spriteframe 做字节对齐。
 */
import { compressUuid } from "../uuid.js";
import { EMPTY, FORMAT_VERSION, type IFileData } from "../format.js";
import { atlasFrameMap, atlasTextureUuid } from "../atlas.js";

export function serializeSpriteFrame(lib: any, uuid?: string): IFileData {
    const c = lib.content;

    // 图集帧:rect/rotated 来自图集缓存,texture 指向自洽图集大图;
    // name/offset/originalSize/capInsets 是内在属性,取自原始 spriteframe。
    const frame = uuid ? atlasFrameMap().get(uuid) : undefined;
    let texture: string | undefined;
    let content: Record<string, unknown>;
    if (frame) {
        texture = atlasTextureUuid(frame);
        content = {
            name: c.name,
            rect: [frame.trim.x, frame.trim.y, frame.trim.width, frame.trim.height],
            offset: c.offset,
            originalSize: c.originalSize,
            ...(frame.rotated ? { rotated: 1 } : {}),
            capInsets: c.capInsets,
        };
    } else {
        // 非图集:剔除 texture(抽为资源依赖)与空 atlas,保持原字段顺序
        texture = c.texture || undefined;
        content = {
            name: c.name,
            rect: c.rect,
            offset: c.offset,
            originalSize: c.originalSize,
            capInsets: c.capInsets,
        };
    }

    const hasTexture = !!texture;
    const sharedUuids = hasTexture ? [compressUuid(texture!)] : EMPTY;
    const sharedStrings = hasTexture ? ["_textureSetter"] : EMPTY;
    const dependObjs = hasTexture ? [0] : [];
    const dependKeys = hasTexture ? [0] : [];
    const dependUuidIndices = hasTexture ? [0] : [];

    return [
        FORMAT_VERSION,        // 0 Version
        sharedUuids,           // 1 SharedUuids
        sharedStrings,         // 2 SharedStrings
        ["cc.SpriteFrame"],    // 3 SharedClasses
        EMPTY,                 // 4 SharedMasks
        [content],             // 5 Instances
        [0],                   // 6 InstanceTypes -> custom class index 0
        EMPTY,                 // 7 Refs
        dependObjs,            // 8 DependObjs
        dependKeys,            // 9 DependKeys
        dependUuidIndices,     // 10 DependUuidIndices
    ];
}
