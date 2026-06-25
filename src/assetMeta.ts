/**
 * 资源元信息:uuid -> 路径(相对所属 bundle 根)/ cc 类型 / 是否主资源。
 * 用于装配 config 的 paths / types。
 *  - 主资源:有独立文件(.meta 顶层 uuid),路径 = 文件名去扩展名,相对 bundle 根。
 *  - 子资源:subMetas(如 texture 里的 sprite-frame),路径 = 父路径 + "/" + 子名。
 *  - 类型:优先 library import 的 __type__,否则按 importer 映射。
 */
import { join, relative } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { rawMetaScan } from "./metaScan.js";
import { importMap, nativeExtMap } from "./libraryIndex.js";

const ASSETS = join(PROJECT_ROOT, "assets");

export interface AssetMeta {
    /** 相对 assets 的路径(不含扩展名);子资源为 父路径/子名 */
    path: string;
    /** cc 类型名,如 cc.AudioClip / cc.Prefab / cc.SpriteFrame */
    type: string;
    /** 主资源(独立文件)还是子资源(subMeta) */
    isMain: boolean;
    /** native 扩展名(如 .mp3 / .png),无则 null */
    nativeExt: string | null;
}

/** importer -> cc 类型(library import 无 __type__ 时的兜底,如编译后的 prefab/scene) */
const IMPORTER_TYPE: Record<string, string> = {
    prefab: "cc.Prefab",
    scene: "cc.Scene",
    "sprite-frame": "cc.SpriteFrame",
    "sprite-atlas": "cc.SpriteAtlas",
    "auto-atlas": "cc.SpriteAtlas",
    texture: "cc.Texture2D",
    "audio-clip": "cc.AudioClip",
    audio: "cc.AudioClip",
    "particle-system": "cc.ParticleAsset",
    bitmap_font: "cc.BitmapFont",
    "ttf-font": "cc.TTFFont",
    text: "cc.TextAsset",
    json: "cc.JsonAsset",
    "label-atlas": "cc.LabelAtlas",
    animation: "cc.AnimationClip",
};

function typeFromImport(uuid: string, importer: string): string {
    const t = importMap().get(uuid)?.type;
    if (t) return t;
    return IMPORTER_TYPE[importer] || "cc.Asset";
}

/** library 里某 uuid 的 native 文件扩展名(含前导点;无则 null) */
function nativeExtOf(uuid: string): string | null {
    return nativeExtMap().get(uuid) ?? null;
}

let _map: Map<string, AssetMeta> | null = null;

/** 构建 uuid -> AssetMeta(派生自共享 .meta 扫描 + library 索引) */
export function assetMetaMap(): Map<string, AssetMeta> {
    if (_map) return _map;
    const map = new Map<string, AssetMeta>();
    for (const { assetFile, meta: m } of rawMetaScan()) {
        const base = assetFile.replace(/\.[^/.]+$/, ""); // 去掉资源扩展名
        const relPath = relative(ASSETS, base);
        // native:同名非 .json 文件存在?用 library 判定更准,这里按资源扩展名
        const ext = assetFile.slice(base.length); // 含点,如 .mp3 / .png
        if (m.uuid) {
            map.set(m.uuid, {
                path: relPath,
                type: typeFromImport(m.uuid, m.importer),
                isMain: true,
                nativeExt: nativeExtOf(m.uuid) ?? (ext && ext !== ".json" ? ext : null),
            });
        }
        if (m.subMetas) {
            const baseName = relPath.split("/").pop()!; // 父文件名(无扩展)
            for (const k in m.subMetas) {
                const sm = m.subMetas[k];
                if (!sm?.uuid) continue;
                // 单图 sprite:子帧 key==父文件名 → 与父共享路径(如 icon_safety);
                // plist 多帧:各子名不同 → 父路径/子名
                const subPath = k === baseName ? relPath : `${relPath}/${k}`;
                map.set(sm.uuid, {
                    path: subPath,
                    type: typeFromImport(sm.uuid, sm.importer),
                    isMain: false,
                    nativeExt: nativeExtOf(sm.uuid),
                });
            }
        }
    }
    _map = map;
    return map;
}
