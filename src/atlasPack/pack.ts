/**
 * 自研 auto-atlas 打包编排:发现 .pac → 收集 packable 帧 → bin-pack → sharp 合成大图。
 *
 * 设计要点:
 *  - 完全脱离编辑器 temp/TexturePacker;源图取自 library native,几何取自 .meta subMeta。
 *  - 大图与 SpriteFrame rect 均本工具生成,只需自洽。v1 禁用旋转(rect 语义零风险)。
 *  - bleed:每帧内容四周用边缘像素扩散 `padding` 像素,避免双线性采样跨帧漏色。
 *  - 增量缓存:按 .pac 维度,key=hash(配置+成员内容)。命中则跳过 sharp,直接复用大图。
 *  - 并发:sharp 底层走 libvips 原生线程池(C++/SIMD);页级 toFile 并发 → 吃满多核。
 *
 * 产出:.atlas-cache/manifest.json(AtlasFrame[],供同步 atlasFrameMap 读取)
 *       .atlas-cache/pages/<pacUuid>-<page>.png(合成大图,作 native 源)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { PROJECT_ROOT } from "../paths.js";
import { collectItems, discoverPacs } from "./collect.js";
import { packPages, type RectIn } from "./binpack.js";
import type { PacConfig, PackItem } from "./types.js";

/** 缓存格式版本;算法/输出结构变更时 +1 以整体失效 */
const PACKER_VERSION = 1;

export const ATLAS_CACHE_DIR = join(PROJECT_ROOT, "tools/fast-build/.atlas-cache");
const PAGES_DIR = join(ATLAS_CACHE_DIR, "pages");
const MANIFEST_PATH = join(ATLAS_CACHE_DIR, "manifest.json");

/** 与 atlas.ts 的 AtlasFrame 完全一致(下游只用 trim/rotated/atlasImage/atlasWidth/atlasHeight/spriteFrameUuid/originalTexture/atlasUuid) */
export interface ManifestFrame {
    spriteFrameUuid: string;
    originalTexture: string;
    atlasName: string;
    atlasUuid: string;
    atlasImage: string;
    atlasWidth: number;
    atlasHeight: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotatedWidth: number;
    rotatedHeight: number;
    rawWidth: number;
    rawHeight: number;
    trim: { x: number; y: number; width: number; height: number; rotatedWidth: number; rotatedHeight: number };
    rotated: boolean;
}

interface PacCache {
    key: string;
    pages: { page: number; width: number; height: number; image: string }[];
    frames: ManifestFrame[];
}

function pacCacheKey(pac: PacConfig, items: PackItem[]): string {
    const h = createHash("md5");
    h.update(`v${PACKER_VERSION}|${pac.pacUuid}|${pac.maxWidth}x${pac.maxHeight}|pad${pac.padding}|pot${pac.powerOfTwo}|sq${pac.forceSquared}`);
    // 成员按 sfUuid 排序,纳入内容 hash 与 trim 几何 —— 内容/裁剪一变即失效
    for (const it of [...items].sort((a, b) => a.spriteFrameUuid.localeCompare(b.spriteFrameUuid))) {
        h.update(`|${it.spriteFrameUuid}:${it.textureUuid}:${it.contentHash}:${it.trimX},${it.trimY},${it.width},${it.height},${it.rawWidth},${it.rawHeight}`);
    }
    return h.digest("hex");
}

function pacCachePath(pacUuid: string): string {
    return join(ATLAS_CACHE_DIR, `pac-${pacUuid}.json`);
}

/** 帧(含 border)是否超过单页上限 —— 超大图不入图集,留作散图(与编辑器 unpackedTextures 一致) */
function fitsPage(it: PackItem, pac: PacConfig, border: number): boolean {
    return it.width + 2 * border <= pac.maxWidth && it.height + 2 * border <= pac.maxHeight;
}

/** 合成单个 .pac 的所有页,返回 ManifestFrame[];内部 sharp 操作并发 */
async function packOnePac(pac: PacConfig, items: PackItem[]): Promise<ManifestFrame[]> {
    const border = Math.max(pac.padding, 1); // bleed/padding 边
    // 膨胀矩形(含两侧 border)送入 packer
    const rects: RectIn[] = items.map((it, id) => ({ id, w: it.width + 2 * border, h: it.height + 2 * border }));
    // v1 禁用旋转:自洽且 rect 语义零风险
    const pages = packPages(rects, pac.maxWidth, pac.maxHeight, {
        allowRotation: false,
        powerOfTwo: pac.powerOfTwo,
        forceSquared: pac.forceSquared,
    });

    mkdirSync(PAGES_DIR, { recursive: true });
    const frames: ManifestFrame[] = [];

    await Promise.all(
        pages.map(async (page, pageIdx) => {
            const imagePath = join(PAGES_DIR, `${pac.pacUuid}-${pageIdx}.png`);
            // 为每帧裁剪 + 边缘扩散,生成 raw 合成输入
            const composites = await Promise.all(
                page.rects.map(async (r) => {
                    const it = items[r.id];
                    const contentX = r.x + border;
                    const contentY = r.y + border;
                    // 裁剪 trimmed 区域,再四周复制边缘像素扩散 border 像素
                    const tile = await sharp(it.srcPng)
                        .extract({ left: it.trimX, top: it.trimY, width: it.width, height: it.height })
                        .extend({ top: border, bottom: border, left: border, right: border, extendWith: "copy" })
                        .raw()
                        .toBuffer({ resolveWithObject: true });
                    frames.push({
                        spriteFrameUuid: it.spriteFrameUuid,
                        originalTexture: it.textureUuid,
                        atlasName: pac.name,
                        atlasUuid: pac.pacUuid,
                        atlasImage: imagePath,
                        atlasWidth: page.width,
                        atlasHeight: page.height,
                        x: r.x,
                        y: r.y,
                        width: it.width,
                        height: it.height,
                        rotatedWidth: it.width,
                        rotatedHeight: it.height,
                        rawWidth: it.rawWidth,
                        rawHeight: it.rawHeight,
                        trim: { x: contentX, y: contentY, width: it.width, height: it.height, rotatedWidth: it.width, rotatedHeight: it.height },
                        rotated: false,
                    });
                    return {
                        input: tile.data,
                        raw: { width: tile.info.width, height: tile.info.height, channels: tile.info.channels },
                        left: r.x, // 膨胀盒左上 = 内容左上 - border
                        top: r.y,
                    };
                })
            );
            await sharp({ create: { width: page.width, height: page.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
                .composite(composites as OverlayOptions[])
                .png({ compressionLevel: 9 })
                .toFile(imagePath);
        })
    );
    return frames;
}

export interface PackStats {
    pacs: number;
    packed: number; // 重新合成的 .pac 数
    cached: number; // 命中缓存的 .pac 数
    pages: number;
    frames: number;
    unpacked: number; // 超大留作散图的帧数
    ms: number;
}

/**
 * 打包全工程所有 auto-atlas,写出 manifest.json + 大图。增量:命中缓存的 .pac 跳过合成。
 * 返回统计。入口应在装配前 await 本函数。
 */
export async function packAllAtlases(opts: { onLog?: (m: string) => void } = {}): Promise<PackStats> {
    const t0 = Date.now();
    const log = opts.onLog ?? (() => {});
    mkdirSync(ATLAS_CACHE_DIR, { recursive: true });

    const pacs = discoverPacs();
    const allFrames: ManifestFrame[] = [];
    let packed = 0;
    let cached = 0;
    let pageCount = 0;
    let unpacked = 0;

    for (const pac of pacs) {
        const border = Math.max(pac.padding, 1);
        const all = collectItems(pac, pacs);
        // 超大图(含 border 超过单页)不入图集 → 不进 manifest → 按散图装配
        const items = all.filter((it) => fitsPage(it, pac, border));
        unpacked += all.length - items.length;
        if (!items.length) continue;
        const key = pacCacheKey(pac, items);
        const cachePath = pacCachePath(pac.pacUuid);

        // 命中缓存:key 一致且所有页大图都在 → 直接复用
        let hit: PacCache | null = null;
        if (existsSync(cachePath)) {
            try {
                const c: PacCache = JSON.parse(readFileSync(cachePath, "utf8"));
                if (c.key === key && c.pages.every((p) => existsSync(p.image))) hit = c;
            } catch {
                /* ignore */
            }
        }

        if (hit) {
            allFrames.push(...hit.frames);
            pageCount += hit.pages.length;
            cached++;
            log(`  ⟲ ${pac.name}(${items.length}帧/${hit.pages.length}页)缓存命中`);
            continue;
        }

        const frames = await packOnePac(pac, items);
        const pageMap = new Map<string, { page: number; width: number; height: number; image: string }>();
        for (const f of frames) {
            if (!pageMap.has(f.atlasImage))
                pageMap.set(f.atlasImage, { page: pageMap.size, width: f.atlasWidth, height: f.atlasHeight, image: f.atlasImage });
        }
        const cache: PacCache = { key, pages: [...pageMap.values()], frames };
        writeFileSync(cachePath, JSON.stringify(cache));
        allFrames.push(...frames);
        pageCount += pageMap.size;
        packed++;
        log(`  ✔ ${pac.name}(${items.length}帧/${pageMap.size}页)已合成`);
    }

    writeFileSync(MANIFEST_PATH, JSON.stringify(allFrames));
    const stats: PackStats = { pacs: pacs.length, packed, cached, pages: pageCount, frames: allFrames.length, unpacked, ms: Date.now() - t0 };
    log(`图集打包完成: ${stats.frames} 帧 / ${stats.pages} 页 (${packed} 重打, ${cached} 命中缓存, ${unpacked} 超大留散图), 耗时 ${stats.ms}ms`);
    return stats;
}

/** 同步读取 manifest(供 atlas.ts 的 atlasFrameMap 使用);不存在返回 null */
export function readManifest(): ManifestFrame[] | null {
    if (!existsSync(MANIFEST_PATH)) return null;
    try {
        return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    } catch {
        return null;
    }
}

/** 删除整个图集缓存(调试用) */
export function clearAtlasCache(): void {
    rmSync(ATLAS_CACHE_DIR, { recursive: true, force: true });
}
