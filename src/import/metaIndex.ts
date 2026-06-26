/**
 * import 模块内部的跨资源反查索引(派生自共享 .meta 扫描,缓存)。
 * 用于 importer 之间的引用解析(如 bitmap-font 需把 textureUuid 解析成其 sprite-frame uuid)。
 */
import { rawMetaScan } from "../metaScan.js";

let _sfByTex: Map<string, string> | null = null;

/**
 * 纹理 uuid → 该纹理的(首个)sprite-frame 子资源 uuid。
 * 扫描所有 .meta 的 subMetas,取 importer=sprite-frame 且 rawTextureUuid 匹配者。
 */
export function spriteFrameForTexture(textureUuid: string): string | undefined {
    if (!_sfByTex) {
        const m = new Map<string, string>();
        for (const { meta } of rawMetaScan()) {
            const subs = meta?.subMetas;
            if (!subs) continue;
            for (const k in subs) {
                const sm = subs[k];
                if (sm?.importer === "sprite-frame" && sm.uuid && sm.rawTextureUuid) {
                    if (!m.has(sm.rawTextureUuid)) m.set(sm.rawTextureUuid, sm.uuid);
                }
            }
        }
        _sfByTex = m;
    }
    return _sfByTex.get(textureUuid);
}
