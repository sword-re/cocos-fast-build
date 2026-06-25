/**
 * 诊断:被跳过的 SpriteAtlas 成员能否从 atlasFrameMap 复原,并对比真实 build import。
 * 区分两类缺口:(A) temp 已缓存但 owned 路径未走 serializeSpriteAtlas;(B) temp 未缓存无成员。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atlasFrameMap } from "../atlas.js";
import { assetMetaMap } from "../assetMeta.js";
import { serializeSpriteAtlas } from "../serialize/spriteAtlas.js";
import { stringify } from "../verify.js";
import { BUILD_DIR } from "../paths.js";
import { phase, log } from "../log.js";

/** atlasUuid -> 成员 SF uuid(从 atlasFrameMap 反转) */
function membersByAtlas(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const fr of atlasFrameMap().values()) {
        let arr = m.get(fr.atlasUuid);
        if (!arr) m.set(fr.atlasUuid, (arr = []));
        arr.push(fr.spriteFrameUuid);
    }
    return m;
}

/** 在真实 build 找某 uuid 的 import 产物 */
function realImport(uuid: string): string | null {
    const sub = uuid.slice(0, 2);
    for (const base of ["subpackages/Common/import", "subpackages/MainBundle/import", "assets/resources/import"]) {
        const dir = join(BUILD_DIR, base, sub);
        if (!existsSync(dir)) continue;
        const f = readdirSync(dir).find((x) => x.startsWith(uuid + "."));
        if (f) return join(dir, f);
    }
    return null;
}

function main(): void {
    const byAtlas = membersByAtlas();
    const metaMap = assetMetaMap();

    phase("SpriteAtlas 成员复原 + 对比真实");
    // Common 的几个被跳过 SpriteAtlas
    const samples = [
        "1d92747a-42a3-4fda-9b64-b2669ab13ecc", // Common/Texture/Common/Common
        "2509ea60-1759-412b-b059-e9da42396a79", // Common/Texture/Gift/Gift
        "5ef61dda-8507-47c4-bc5a-2e2d210896a6", // Main/Texture/Home/HomeAtlas
    ];
    for (const uuid of samples) {
        const members = byAtlas.get(uuid) ?? [];
        const meta = metaMap.get(uuid);
        const real = realImport(uuid);
        let realCount = -1;
        if (real) {
            try {
                const arr = JSON.parse(readFileSync(real, "utf8"));
                // SpriteAtlas import: [1,[<SF compressed uuids>],...] —— 第二段是成员数组
                realCount = Array.isArray(arr) && Array.isArray(arr[1]) ? arr[1].length : -1;
            } catch {
                /* ignore */
            }
        }
        log(`${meta?.path ?? uuid}: atlasFrameMap 成员=${members.length}, 真实 build 成员=${realCount}, temp ${members.length ? "已缓存" : "未缓存"}`);
        if (members.length) {
            const memObjs = members.map((u) => ({ uuid: u, name: metaMap.get(u)?.path.split("/").pop() ?? u }));
            const out = stringify(serializeSpriteAtlas(memObjs));
            log(`    我们 serializeSpriteAtlas 成员=${memObjs.length}, 字节=${out.length}`);
        }
    }
}

main();
