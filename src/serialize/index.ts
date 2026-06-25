/**
 * 序列化分发:按 library 资源的 __type__ 选择路径。
 *  - cc.SpriteFrame:自定义 content + 贴图依赖(spriteFrame.ts)
 *  - cc.Texture2D / cc.RenderTexture:packCustomObjData(customObj.ts)
 *  - 其它注册类:通用 CCClass 路径(genericClass.ts)
 *  - 无 __type__(对象图:prefab/scene):尚未支持(spike 2)
 */
import type { IFileData } from "../format.js";
import { isCustomSerialize } from "../registry.js";
import { serializeSpriteFrame } from "./spriteFrame.js";
import { serializeTexture2D } from "./customObj.js";
import { serializeGenericLeaf } from "./genericClass.js";
import { serializeLeafClass } from "./leafClass.js";
import { serializeObjectGraph } from "./objectGraph.js";

export class UnsupportedAsset extends Error {}

/**
 * 需单独处理、不能直接走通用 CCClass 路径的类。
 *  - cc.SpriteAtlas:_spriteFrames 是 Dict<name, AssetRefByInnerObj>,由 assemble.ts 用
 *    serializeSpriteAtlas 单独填充成员(library 空壳),故在分发处仍拦截兜底。
 *
 * cc.EffectAsset 已验证可走通用路径:shaders/techniques 是 SimpleType 原始 JSON 数据块
 * (无 __uuid__ 引用、无自定义 _serialize),与真实产物语义等价(仅嵌套键序不同,反序列化无关)。
 */
const DEFERRED_TO_SPIKE2 = new Set(["cc.SpriteAtlas"]);

export function serializeAsset(lib: any, uuid?: string): IFileData {
    // 对象图(prefab/scene):library 顶层是数组
    if (Array.isArray(lib)) return serializeObjectGraph(lib);

    const type: string | undefined = lib && typeof lib === "object" ? lib.__type__ : undefined;
    if (!type) throw new UnsupportedAsset("未知资源格式");
    if (DEFERRED_TO_SPIKE2.has(type)) throw new UnsupportedAsset(`高级类型,延后到 spike 2: ${type}`);

    switch (type) {
        case "cc.SpriteFrame":
            return serializeSpriteFrame(lib, uuid);
        case "cc.Texture2D":
        case "cc.RenderTexture":
            return serializeTexture2D(lib);
        case "cc.Material":
            // _techniqueData 可能含嵌套纹理引用 / cc.Color → 需 Dict + AssetRefByInnerObj 编码
            return serializeLeafClass(type, lib);
        case "cc.AnimationClip":
            // curveData 逐帧动画可含嵌套 SpriteFrame 引用({frame,value:{__uuid__}})→ 需 Dict 编码,
            // 否则引用埋在数据里不解析,运行时动画把 sprite.spriteFrame 设成裸对象 → textureLoaded 崩
            return serializeLeafClass(type, lib);
        case "sp.SkeletonData":
            // Spine 骨骼数据含纹理/图集嵌套引用,同理走 Dict + AssetRefByInnerObj
            return serializeLeafClass(type, lib);
        default:
            if (isCustomSerialize(type)) {
                throw new UnsupportedAsset(`自定义序列化类暂未实现: ${type}`);
            }
            return serializeGenericLeaf(type, lib);
    }
}
