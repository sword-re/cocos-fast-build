/**
 * 资源依赖图 + 物理归属。
 * - directDeps(uuid):该资源直接引用的资源 uuid(library import 的所有 __uuid__ + SpriteAtlas 成员帧)。
 * - bundleOf(uuid):资源物理归属的 bundle(最深的 isBundle 祖先目录)。
 *
 * .meta / library import 的读盘统一走 metaScan / libraryIndex 共享索引(一趟读、可并行预热),
 * 本模块只做内存派生,不再各自全量遍历 assets/ 或逐 uuid 读 import。
 */
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { discoverBundles, type BundleDef } from "./bundles.js";
import { atlasFrameMap } from "./atlas.js";
import { rawMetaScan } from "./metaScan.js";
import { importMap } from "./libraryIndex.js";

const ASSETS = join(PROJECT_ROOT, "assets");

let _uuidDir: Map<string, string> | null = null;

/** uuid(含 subMetas)-> 所在目录绝对路径(派生自共享 .meta 扫描) */
function uuidDirMap(): Map<string, string> {
    if (_uuidDir) return _uuidDir;
    const map = new Map<string, string>();
    for (const { dir, meta } of rawMetaScan()) {
        if (meta.uuid) map.set(meta.uuid, dir);
        if (meta.subMetas) for (const k in meta.subMetas) if (meta.subMetas[k]?.uuid) map.set(meta.subMetas[k].uuid, dir);
    }
    return (_uuidDir = map);
}

let _bundles: BundleDef[] | null = null;
function bundlesByDepth(): BundleDef[] {
    if (!_bundles) _bundles = discoverBundles().sort((a, b) => b.rootDir.length - a.rootDir.length); // 深目录优先
    return _bundles;
}

/** 该 uuid 是否有物理资源(assets/ 下有 .meta 记录);引擎内置(无物理 meta)返回 false */
export function hasPhysicalAsset(uuid: string): boolean {
    return uuidDirMap().has(uuid);
}

/** 资源物理归属的 bundle 名(最深 bundle 祖先);不在任何 bundle 下返回 null */
export function bundleOf(uuid: string): string | null {
    const dir = uuidDirMap().get(uuid);
    if (!dir) return null;
    for (const b of bundlesByDepth()) {
        if (dir === b.rootDir || dir.startsWith(b.rootDir + "/")) return b.name;
    }
    return null;
}

let _atlasMembers: Map<string, Set<string>> | null = null;

/**
 * SpriteAtlas uuid -> 成员 spriteframe uuid。
 * library 里 SpriteAtlas 是空壳(成员关系 build 时才生成),故单独构建:
 *  - plist 图集:.meta importer="sprite-atlas" 的 subMetas(importer="sprite-frame")。
 *  - 自动图集(.pac):atlasFrameMap 按 atlasUuid 分组。
 */
function atlasMembersMap(): Map<string, Set<string>> {
    if (_atlasMembers) return _atlasMembers;
    const m = new Map<string, Set<string>>();
    const add = (atlas: string, frame: string) => {
        let s = m.get(atlas);
        if (!s) m.set(atlas, (s = new Set()));
        s.add(frame);
    };
    // plist(派生自共享 .meta 扫描)
    for (const { meta } of rawMetaScan()) {
        if (meta.importer === "sprite-atlas" && meta.subMetas) {
            for (const k in meta.subMetas) {
                const sm = meta.subMetas[k];
                if (sm?.importer === "sprite-frame" && sm.uuid) add(meta.uuid, sm.uuid);
            }
        }
    }
    // auto-atlas
    for (const fr of atlasFrameMap().values()) add(fr.atlasUuid, fr.spriteFrameUuid);
    _atlasMembers = m;
    return m;
}

/** SpriteAtlas 的成员 spriteframe(非图集返回 null) */
export function atlasMembers(uuid: string): Set<string> | null {
    return atlasMembersMap().get(uuid) || null;
}

/** 直接依赖:library import 里递归出现的所有 __uuid__(去掉自身),SpriteAtlas 额外含成员帧 */
export function directDeps(uuid: string): Set<string> {
    const rec = importMap().get(uuid);
    const set = new Set<string>(rec ? rec.deps : undefined);
    // SpriteAtlas:补成员帧(library 空壳)
    const members = atlasMembersMap().get(uuid);
    if (members) for (const m of members) set.add(m);
    set.delete(uuid);
    return set;
}
