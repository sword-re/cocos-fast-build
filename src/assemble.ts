/**
 * 完整 bundle 装配器:用 crawl() 的归属结果生成真实结构的 config + import/ + native/。
 *
 * 覆盖:uuids / owned 序列化 / redirect / deps / paths / types / versions。
 * 暂未覆盖(后续):packs(JSON 合并)/ 图集大图 native / scenes / 脚本打包 / game 样板。
 *
 * 目标:产物内部自洽、可被引擎 asset-manager 加载(非字节级复刻 cocos 的 uuid 顺序)。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { crawl } from "./crawl.js";
import { assetMetaMap } from "./assetMeta.js";
import { atlasPages } from "./atlas.js";
import { atlasMembers, bundleOf } from "./assetGraph.js";
import { rawImport, nativeExtMap } from "./libraryIndex.js";
import { compressUuid } from "./uuid.js";
import { serializeAsset } from "./serialize/index.js";
import { serializeSpriteAtlas } from "./serialize/spriteAtlas.js";
import { stringify } from "./verify.js";
import { md5hex5 } from "./bundle.js";

// 装配以写盘 syscall 为主(数千个小 import json),提高 libuv 线程池上限让异步写真正并行。
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "16";

const ASSETS = join(PROJECT_ROOT, "assets");

/** 并发写一批文件(libuv 线程池并行 write syscall) */
async function flushWrites(tasks: { path: string; data: string | Buffer }[], concurrency = 16): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < tasks.length) {
            const t = tasks[next++];
            await writeFile(t.path, t.data);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

/** 图集合成大图的 Texture2D 参数(pixelFormat,min,mag,wrapS,wrapT,premultiply,flipY,mipmap) */
const ATLAS_TEX_CONTENT = "0,9729,9729,33071,33071,1,0,0";

function findNative(uuid: string, ext: string): string | null {
    const p = join(PROJECT_ROOT, "library/imports", uuid.slice(0, 2), `${uuid}${ext}`);
    return ext ? p : null;
}

/**
 * 引擎内置资源(internal)的路径/类型派生:这些资源无项目 .meta,只能从 library import 反推。
 *  - cc.EffectAsset → effects/<_name>;cc.Material → materials/<_name>(复刻 cocos 内置布局)
 *  - 其它(如内置白纹理 cc.Texture2D)→ 仅类型,无 path(靠 native 加载)
 */
function builtinMeta(lib: any): { type: string; path?: string } | null {
    const type: string | undefined = lib && typeof lib === "object" && !Array.isArray(lib) ? lib.__type__ : undefined;
    if (!type) return null;
    const name: string | undefined = lib._name;
    if (name && type === "cc.EffectAsset") return { type, path: `effects/${name}` };
    if (name && type === "cc.Material") return { type, path: `materials/${name}` };
    return { type };
}

export interface AssembleResult {
    name: string;
    outDir: string;
    config: any;
    /** config.<md5>.json 的 md5(供 bundleVers,免去回头 readdir 产物目录) */
    configMd5: string;
    importCount: number;
    nativeCount: number;
    skipped: string[]; // 无 import(合成/无 library)而跳过的 owned uuid
}

/** 装配一个 bundle 到 outRoot/<name> */
export async function assembleBundle(name: string, outRoot: string): Promise<AssembleResult> {
    const { bundles, bundleInfo } = crawl();
    const b = bundles.find((x) => x.name === name);
    const info = bundleInfo.get(name);
    if (!b || !info) throw new Error(`未知 bundle: ${name}`);
    const metaMap = assetMetaMap();
    const bundleRootRel = relative(ASSETS, b.rootDir); // 如 Bundles/Audio

    const outDir = join(outRoot, name);
    const importDir = join(outDir, "import");
    const nativeDir = join(outDir, "native");
    mkdirSync(importDir, { recursive: true });

    const uuids = [...info.uuids]; // 可追加(SpriteAtlas 资产注入到末尾)
    const indexOf = new Map(uuids.map((u, i) => [u, i]));
    const uuidSet = new Set(uuids);

    // deps 顺序固定,供 redirect 索引
    const deps = info.deps;
    const depIndex = new Map(deps.map((d, i) => [d, i]));

    const importVersions: (string | number)[] = [];
    const nativeVersions: (string | number)[] = [];
    const paths: Record<string, [string, number]> = {};
    const scenes: Record<string, number> = {};
    const types: string[] = [];
    const typeIndex = new Map<string, number>();
    const skipped: string[] = [];
    let importCount = 0;
    let nativeCount = 0;

    const typeIdx = (t: string): number => {
        let i = typeIndex.get(t);
        if (i === undefined) {
            i = types.length;
            types.push(t);
            typeIndex.set(t, i);
        }
        return i;
    };

    const pages = atlasPages();
    // 写盘任务延后批量并发执行(libuv 线程池并行);md5/versions 同步算好,顺序不依赖写完成。
    const writes: { path: string; data: string | Buffer }[] = [];
    const dirsToMake = new Set<string>();
    const writeImport = (uuid: string, idx: number, content: string) => {
        const md5 = md5hex5(content);
        const sub = uuid.slice(0, 2);
        dirsToMake.add(join(importDir, sub));
        writes.push({ path: join(importDir, sub, `${uuid}.${md5}.json`), data: content });
        importVersions.push(idx, md5);
        importCount++;
    };
    // suffix:扁平资源(纹理/音频)为扩展名 ".png";原名文件资源(字体等)为 "/原文件名"
    // → 目录布局 native/<sub>/<uuid>.<md5>/<原文件名>。读源字节算 md5 后直接写出(免二次读)。
    const copyNative = (uuid: string, idx: number, src: string, suffix: string) => {
        const buf = readFileSync(src);
        const nmd5 = md5hex5(buf);
        const sub = uuid.slice(0, 2);
        const dest = join(nativeDir, sub, `${uuid}.${nmd5}${suffix}`);
        dirsToMake.add(dirname(dest));
        writes.push({ path: dest, data: buf });
        nativeVersions.push(idx, nmd5);
        nativeCount++;
    };


    for (const uuid of info.owned) {
        const idx = indexOf.get(uuid)!;

        // 图集合成大图:无 library,构造 Texture2D import + 拷贝打包大图为 native
        const page = pages.get(uuid);
        if (page) {
            writeImport(uuid, idx, stringify(serializeAsset({ __type__: "cc.Texture2D", content: ATLAS_TEX_CONTENT })));
            try {
                copyNative(uuid, idx, page.image, ".png");
            } catch {
                skipped.push(uuid); // 大图文件缺失(temp 未缓存)
            }
            continue; // 大图无 path
        }

        const meta = metaMap.get(uuid);

        // SpriteAtlas:library import 是空壳,需用成员重新填充 _spriteFrames。
        // 成员来源用 atlasMembers(同时覆盖 plist 图集的 .meta subMetas 与自动图集 .pac),
        // 否则 plist 图集(如 msgIcons.plist)取不到成员被跳过 → 运行时按无版本请求 import → 404。
        if (meta?.type === "cc.SpriteAtlas") {
            const members = [...(atlasMembers(uuid) ?? new Set<string>())]
                .filter((sf) => uuidSet.has(sf)) // 仅本包内可解析的成员
                .sort()
                .map((sf) => ({ uuid: sf, name: metaMap.get(sf)?.path.split("/").pop() ?? sf }));
            if (members.length) {
                writeImport(uuid, idx, stringify(serializeSpriteAtlas(members)));
                paths[String(idx)] = [relative(bundleRootRel, meta.path), typeIdx(meta.type)];
            } else {
                skipped.push(uuid); // temp 未缓存,无成员信息
            }
            continue;
        }

        let hasImport = false;
        let lib: any = null;
        try {
            lib = rawImport(uuid); // 命中预热缓存,免去再次读盘;缺失则抛错走下方 skip
            // 必须传 uuid:图集成员 SpriteFrame 据此查 atlasFrameMap 把 texture 改写到合成大图
            writeImport(uuid, idx, stringify(serializeAsset(lib, uuid)));
            hasImport = true;
        } catch {
            skipped.push(uuid); // 无 library import,或高级类型延后(EffectAsset 等 spike2)
        }

        // 引擎内置资源(internal)无项目 meta,从 library import 派生路径/类型/native
        const resolved = meta ?? builtinMeta(lib);

        // native 布局由 _native 决定:
        //  - 完整文件名(不以 . 开头,如字体 "X.ttf")→ 目录布局,源在 library/imports/<sub>/<uuid>/<文件名>
        //  - 扩展名(".mp3"/".plist")或无 _native(纹理由 meta 推扩展名)→ 扁平 <uuid>.<md5><ext>
        const nativeName = typeof lib?._native === "string" ? lib._native : "";
        if (nativeName && !nativeName.startsWith(".")) {
            const src = join(PROJECT_ROOT, "library/imports", uuid.slice(0, 2), uuid, nativeName);
            try {
                copyNative(uuid, idx, src, `/${nativeName}`);
            } catch {
                /* native 缺失忽略 */
            }
        } else {
            const ext = nativeName || meta?.nativeExt || nativeExtMap().get(uuid) || null;
            if (ext) {
                const np = findNative(uuid, ext);
                if (np) {
                    try {
                        copyNative(uuid, idx, np, ext);
                    } catch {
                        /* native 缺失忽略 */
                    }
                }
            }
        }

        // 场景:登记到 scenes(db url -> idx),不进 paths/types
        if (hasImport && resolved?.type === "cc.Scene") {
            scenes[`db://assets/${resolved.path}.fire`] = idx;
        } else if (hasImport && resolved?.path !== undefined) {
            // paths(有路径的资源):物理资源相对 bundle 根;内置资源 path 已是最终值
            const p = meta ? relative(bundleRootRel, meta.path) : resolved.path;
            paths[String(idx)] = [p, typeIdx(resolved.type)];
        }
    }


    // 物理属于本 bundle、但被上浮 redirect 到其它 owner 的资源:path 仍登记在本 bundle
    //(复刻真实 cocos:floated 资源的 path 留在物理宿主包,import/native 在 owner 包)。
    // 这样 bundle.load(path) 能 path→uuid→redirect→owner 加载;否则报 "Bundle X doesn't contain <path>"
    //(如 VoiceRoom 列表项按路径加载被上浮到 SpyGameRemote 的 msgIcons 帧)。
    for (const u of info.redirect.keys()) {
        if (bundleOf(u) !== name) continue; // 仅本 bundle 物理资源
        const idx = indexOf.get(u);
        const m = metaMap.get(u);
        if (idx === undefined || !m || String(idx) in paths) continue;
        if (m.type === "cc.Scene") scenes[`db://assets/${m.path}.fire`] = idx;
        else paths[String(idx)] = [relative(bundleRootRel, m.path), typeIdx(m.type)];
    }

    // redirect:[uuidIdx, depIdx, ...]
    const redirect: number[] = [];
    for (const [uuid, target] of info.redirect) {
        const ui = indexOf.get(uuid);
        const di = depIndex.get(target);
        if (ui !== undefined && di !== undefined) redirect.push(ui, di);
    }

    const config = {
        paths,
        types,
        uuids: uuids.map(compressUuid),
        scenes,
        redirect,
        deps,
        packs: {},
        name,
        importBase: "import",
        nativeBase: "native",
        debug: false,
        isZip: false,
        encrypted: false,
        versions: { import: importVersions, native: nativeVersions },
    };
    const configStr = stringify(config);
    const configMd5 = md5hex5(configStr);

    // 统一去重建目录(同步,数量远少于逐文件 mkdir),再并发 flush 全部 import/native 写盘
    for (const d of dirsToMake) mkdirSync(d, { recursive: true });
    await flushWrites(writes);
    writeFileSync(join(outDir, `config.${configMd5}.json`), configStr);

    return { name, outDir, config, configMd5, importCount, nativeCount, skipped };
}
