/**
 * importer 注册表:meta.importer 名 → Importer 实现。
 * 逐里程碑往这里加(M1: texture …;M3: bitmap-font/spine;M4: effect)。
 */
import type { Importer } from "./types.js";
import { textureImporter } from "./importers/texture.js";
import { prefabImporter, sceneImporter } from "./importers/objectGraph.js";
import { materialImporter, animationImporter } from "./importers/plainJson.js";
import { audioImporter, ttfFontImporter, textImporter, jsonImporter, rawAssetImporter } from "./importers/simple.js";
import { spriteAtlasImporter } from "./importers/spriteAtlas.js";
import { spineImporter } from "./importers/spine.js";
import { bitmapFontImporter } from "./importers/bitmapFont.js";
import { effectImporter } from "./importers/effect.js";

const registry = new Map<string, Importer>();
function reg(imp: Importer) {
    registry.set(imp.name, imp);
}

reg(textureImporter);
reg(prefabImporter);
reg(sceneImporter);
reg(materialImporter);
reg(animationImporter);
reg(audioImporter);
reg(ttfFontImporter);
reg(textImporter);
reg(jsonImporter);
reg(rawAssetImporter);
reg(spriteAtlasImporter);
reg(spineImporter);
reg(bitmapFontImporter);
reg(effectImporter);

export function importerFor(name: string): Importer | undefined {
    return registry.get(name);
}

/** 已实现的 importer 名集合(供覆盖率统计) */
export function implementedImporters(): Set<string> {
    return new Set(registry.keys());
}
