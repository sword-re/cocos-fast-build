/**
 * 发现 .pac auto-atlas 作用域,收集其中所有 packable 的 SpriteFrame 待打包项。
 *
 * - 作用域:.pac.meta(importer="auto-atlas")所在目录子树。深目录优先(就近归属)。
 * - 成员:作用域内 importer="texture" && type="sprite" && packable 的纹理 .meta,
 *   其 subMetas 里 importer="sprite-frame" 的帧。trim 几何直接取自 subMeta(编辑器已算好)。
 * - 源图:texture .meta 旁的原始图片(<image>.png,已验证与 library native 字节一致),脱离 library。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import type { PacConfig, PackItem } from "./types.js";

const ASSETS = join(PROJECT_ROOT, "assets");

/** 扫描全工程,返回所有 auto-atlas 作用域(深目录优先) */
export function discoverPacs(): PacConfig[] {
    const out: PacConfig[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) {
                walk(p);
            } else if (name.endsWith(".pac.meta")) {
                let m: any;
                try {
                    m = JSON.parse(readFileSync(p, "utf8"));
                } catch {
                    continue;
                }
                if (m.importer !== "auto-atlas" || !m.uuid) continue;
                out.push({
                    pacUuid: m.uuid,
                    name: name.replace(/\.pac\.meta$/, ""),
                    dir,
                    maxWidth: m.maxWidth ?? 1024,
                    maxHeight: m.maxHeight ?? 1024,
                    padding: m.padding ?? 2,
                    allowRotation: !!m.allowRotation,
                    forceSquared: !!m.forceSquared,
                    powerOfTwo: !!m.powerOfTwo,
                    contourBleed: !!m.contourBleed,
                    paddingBleed: !!m.paddingBleed,
                });
            }
        }
    };
    walk(ASSETS);
    // 深目录优先:嵌套 .pac 时,内层目录的图归内层图集
    out.sort((a, b) => b.dir.length - a.dir.length);
    return out;
}

/** 给定一组作用域,返回 dir -> 最贴近(最深)的 PacConfig */
function scopeResolver(pacs: PacConfig[]) {
    return (path: string): PacConfig | null => {
        for (const pc of pacs) if (path === pc.dir || path.startsWith(pc.dir + "/")) return pc;
        return null;
    };
}

/** 收集某 .pac 作用域内的全部 packable 待打包帧 */
export function collectItems(pac: PacConfig, pacs: PacConfig[]): PackItem[] {
    const resolve = scopeResolver(pacs);
    const items: PackItem[] = [];
    // 从 pac.dir 下钻;某子目录若被更深的嵌套 .pac 抢走(resolve 返回更深 pac),
    // 则其中的纹理归那个 pac,这里据 owner.pacUuid 过滤掉。
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) {
                walk(p);
            } else if (name.endsWith(".meta")) {
                const owner = resolve(dir);
                if (!owner || owner.pacUuid !== pac.pacUuid) continue;
                let m: any;
                try {
                    m = JSON.parse(readFileSync(p, "utf8"));
                } catch {
                    continue;
                }
                if (m.importer !== "texture" || m.type !== "sprite" || !m.packable || !m.uuid) continue;
                if (!m.subMetas) continue;
                const srcPng = p.slice(0, -".meta".length); // .meta 旁的源图(<image>.png)
                if (!existsSync(srcPng)) continue; // 源图缺失,跳过(交由散图路径兜底)
                const hash = createHash("md5").update(readFileSync(srcPng)).digest("hex").slice(0, 16);
                for (const k in m.subMetas) {
                    const sm = m.subMetas[k];
                    if (sm?.importer !== "sprite-frame" || !sm.uuid) continue;
                    items.push({
                        spriteFrameUuid: sm.uuid,
                        textureUuid: m.uuid,
                        srcPng,
                        trimX: sm.trimX ?? 0,
                        trimY: sm.trimY ?? 0,
                        width: sm.width ?? m.width,
                        height: sm.height ?? m.height,
                        rawWidth: sm.rawWidth ?? m.width,
                        rawHeight: sm.rawHeight ?? m.height,
                        contentHash: hash,
                    });
                }
            }
        }
    };
    walk(pac.dir);
    return items;
}
