/**
 * 自动图集(AutoAtlas)解析。
 *
 * 【已脱离编辑器】数据源是 fast-build 自研 packer 产出的 manifest(src/atlasPack/),
 * 不再依赖编辑器的 temp/TexturePacker 缓存。manifest 由装配前的 packAllAtlases() 写出,
 * 几何(大图坐标/裁剪尺寸/rotated)+ 合成大图 png 都由我们生成,只需自洽。
 *
 * 关键:manifest 里每条 = 一个 SpriteFrame 的落位(spriteFrameUuid / 原始纹理 / 大图 / rect)。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { readManifest } from "./atlasPack/pack.js";

export interface AtlasFrame {
    spriteFrameUuid: string; // 该帧对应的 SpriteFrame uuid
    originalTexture: string; // 原始 Texture2D uuid
    atlasName: string; // 所属图集(.pac)名
    atlasUuid: string; // .pac(SpriteAtlas)uuid
    atlasImage: string; // 打包后大图绝对路径(可作 native 复用)
    atlasWidth: number;
    atlasHeight: number;
    // 帧在大图中的几何
    x: number;
    y: number;
    width: number; // 含 padding 的占位尺寸
    height: number;
    rotatedWidth: number;
    rotatedHeight: number;
    rawWidth: number; // 原图尺寸
    rawHeight: number;
    trim: { x: number; y: number; width: number; height: number; rotatedWidth: number; rotatedHeight: number };
    rotated: boolean;
}

let _map: Map<string, AtlasFrame> | null = null;

/**
 * 构建 spriteFrameUuid -> AtlasFrame 映射,数据源为自研 packer 的 manifest。
 * manifest 缺失(未先跑 packAllAtlases)时返回空 map —— 等价于"无图集",
 * 此时所有 packable 纹理按散图装配(可加载,只是没图集优化)。
 */
export function atlasFrameMap(): Map<string, AtlasFrame> {
    if (_map) return _map;
    const map = new Map<string, AtlasFrame>();
    const manifest = readManifest();
    if (manifest) for (const f of manifest) map.set(f.spriteFrameUuid, f as AtlasFrame);
    _map = map;
    return map;
}

/** 重置缓存(打包后或测试时调用,使后续 atlasFrameMap 重新读 manifest) */
export function resetAtlasCaches(): void {
    _map = null;
    _pages = null;
    _scopes = null;
    _consumption = null;
}

/**
 * 为图集大图分配确定性的自洽 uuid(基于打包大图路径,稳定唯一)。
 * 不复现 cocos 合成 id;只需 spriteframe/import/native/config 四处一致。
 */
export function atlasTextureUuid(frame: AtlasFrame): string {
    return md5Uuid(frame.atlasImage);
}

function md5Uuid(seed: string): string {
    const h = createHash("md5").update(seed).digest("hex"); // 32 hex
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const ASSETS = join(PROJECT_ROOT, "assets");

export interface AtlasPage {
    bigTexUuid: string; // 合成图集大图 uuid(规范 = atlasTextureUuid(frame),源自打包大图路径)
    atlasUuid: string; // 该页所属 SpriteAtlas(.pac;单页时 == .pac uuid)
    image: string; // 打包后大图绝对路径(native 来源)
    width: number;
    height: number;
    members: string[]; // 该页的成员 SpriteFrame uuid
}

let _pages: Map<string, AtlasPage> | null = null;
/** 按页聚合 temp 缓存:bigTexUuid -> AtlasPage(几何/图片/成员) */
export function atlasPages(): Map<string, AtlasPage> {
    if (_pages) return _pages;
    const pages = new Map<string, AtlasPage>();
    for (const fr of atlasFrameMap().values()) {
        const bt = atlasTextureUuid(fr);
        let pg = pages.get(bt);
        if (!pg) {
            pages.set(
                bt,
                (pg = { bigTexUuid: bt, atlasUuid: fr.atlasUuid, image: fr.atlasImage, width: fr.atlasWidth, height: fr.atlasHeight, members: [] })
            );
        }
        pg.members.push(fr.spriteFrameUuid);
    }
    _pages = pages;
    return pages;
}

/** auto-atlas(.pac)作用域:目录子树 + .pac uuid */
interface AutoAtlasScope {
    dir: string;
    pacUuid: string;
}
let _scopes: AutoAtlasScope[] | null = null;
function autoAtlasScopes(): AutoAtlasScope[] {
    if (_scopes) return _scopes;
    const out: AutoAtlasScope[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) walk(p);
            else if (name.endsWith(".pac.meta")) {
                let m: any;
                try {
                    m = JSON.parse(readFileSync(p, "utf8"));
                } catch {
                    continue;
                }
                if (m.importer === "auto-atlas" && m.uuid) out.push({ dir, pacUuid: m.uuid });
            }
        }
    };
    walk(ASSETS);
    out.sort((a, b) => b.dir.length - a.dir.length); // 深目录优先(就近)
    _scopes = out;
    return out;
}

export interface AtlasConsumption {
    /** 被图集吞并而从产物移除的原始 Texture2D uuid */
    consumed: Set<string>;
    /** 原始 Texture2D uuid -> 合成图集大图 uuid(供依赖重写) */
    rewrite: Map<string, string>;
    /** 合成图集大图 uuid 集合 */
    bigTextures: Set<string>;
    /** 图集成员 SpriteFrame uuid -> 合成大图 uuid(用于整组同归属) */
    groupBigTex: Map<string, string>;
}

let _consumption: AtlasConsumption | null = null;
/**
 * 自动图集消耗(混合):消耗检测用 .pac 作用域(完整);大图 uuid 优先用 temp 缓存的
 * atlasTextureUuid(规范、可装配,与 spriteFrame 序列化一致),temp 未缓存的图集退回
 * .pac 派生 id(消耗仍被剔除,但该图集无法装配 —— 属包体优化待办)。
 */
export function atlasConsumption(): AtlasConsumption {
    if (_consumption) return _consumption;
    const consumed = new Set<string>();
    const rewrite = new Map<string, string>();
    const groupBigTex = new Map<string, string>();
    const bigTextures = new Set<string>();

    // temp 缓存(图集帧 = .pac 已打包的成员,是消耗的真相来源):直接据此完整填充
    // consumed / rewrite / groupBigTex。否则只靠下方 .pac walk(按 packable meta 检测)会漏掉
    // 个别图集 → 成员 SF 序列化时改写到大图(serializeSpriteFrame 查 atlasFrameMap),但大图
    // 没进闭包/无 owner/未装配 → 运行时按无版本请求大图 import → 404。
    const texCanonical = new Map<string, string>();
    const sfCanonical = new Map<string, string>();
    for (const fr of atlasFrameMap().values()) {
        const bt = atlasTextureUuid(fr);
        bigTextures.add(bt);
        sfCanonical.set(fr.spriteFrameUuid, bt);
        groupBigTex.set(fr.spriteFrameUuid, bt); // 成员 SF → 大图(供 rwDeps 改写依赖,完整)
        if (fr.originalTexture) {
            texCanonical.set(fr.originalTexture, bt);
            consumed.add(fr.originalTexture); // 原始纹理被打包消耗 → 从产物移除
            rewrite.set(fr.originalTexture, bt); // 依赖图改写到大图
        }
    }

    // .pac 作用域:完整消耗检测,大图 uuid 优先 temp 规范、否则兜底
    const scopes = autoAtlasScopes();
    const scopeFor = (path: string): AutoAtlasScope | null => {
        for (const s of scopes) if (path === s.dir || path.startsWith(s.dir + "/")) return s;
        return null;
    };
    const walk = (dir: string) => {
        const sc = scopeFor(dir);
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) {
                walk(p);
            } else if (sc && name.endsWith(".meta")) {
                let m: any;
                try {
                    m = JSON.parse(readFileSync(p, "utf8"));
                } catch {
                    continue;
                }
                if (m.importer === "texture" && m.type === "sprite" && m.packable && m.uuid) {
                    // 仅当该图集已在 temp 缓存(有真实打包大图)才消耗 + 重写到合成大图;
                    // 未缓存的图集不消耗 —— 其纹理作为独立 Texture2D 装配(放弃图集优化,但可加载,
                    // 否则会重写到无页图的兜底大图 uuid → 运行时 404)。
                    const bt = texCanonical.get(m.uuid);
                    if (!bt) continue;
                    bigTextures.add(bt);
                    consumed.add(m.uuid);
                    rewrite.set(m.uuid, bt);
                    if (m.subMetas)
                        for (const k in m.subMetas) {
                            const sm = m.subMetas[k];
                            if (sm?.importer === "sprite-frame" && sm.uuid) groupBigTex.set(sm.uuid, sfCanonical.get(sm.uuid) ?? bt);
                        }
                }
            }
        }
    };
    walk(ASSETS);
    _consumption = { consumed, rewrite, bigTextures, groupBigTex };
    return _consumption;
}
