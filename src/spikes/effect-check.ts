/**
 * effect 编译校验台:逐项目 .effect 编译,对 library/imports 分字段 deepEqual。
 * 现阶段(P1)只验 properties + techniques;shaders 待 P2+ 补齐后纳入。
 *
 * 运行:npm run effect:check        # 汇总
 *       npm run effect:check -- -v  # 打印首个 mismatch 详情
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { rawMetaScan } from "../metaScan.js";
import { LIBRARY_IMPORTS } from "../paths.js";
import { deepEqual } from "../util/deepEqual.js";
import { parseEffect, compileTechniques } from "../import/effect/compile.js";
import { genGlsl3, genGlsl1, splitProgramRef } from "../import/effect/glsl.js";
import { preprocess } from "../import/effect/preprocess.js";
import { reflect } from "../import/effect/reflect.js";
import { murmurhash2_32_gc } from "../import/effect/murmur.js";

const VERBOSE = process.argv.includes("-v");

function libImport(uuid: string): any | undefined {
    const p = join(LIBRARY_IMPORTS, uuid.slice(0, 2), `${uuid}.json`);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8"));
}

interface Row {
    name: string;
    props: boolean;
    techs: boolean;
    glsl3: string; // "n/m" 各 shader glsl3 vert+frag 通过数
    glsl1: string;
    refl: string; // reflection(defines/blocks/samplers/builtins)+ hash 通过数
    detail?: string;
}


function main() {
    const rows: Row[] = [];
    for (const { meta, assetFile } of rawMetaScan()) {
        if (meta?.importer !== "effect" || !meta.uuid) continue;
        const ref = libImport(meta.uuid);
        if (!ref) continue;
        const name = assetFile.split("/").pop()!.replace(/\.effect$/, "");
        let techniques: any, properties: any, parsed: any;
        try {
            parsed = parseEffect(readFileSync(assetFile, "utf8"));
            ({ techniques, properties } = compileTechniques(name, parsed));
        } catch (e: any) {
            rows.push({ name, props: false, techs: false, glsl3: "err", glsl1: "err", refl: "err", detail: `编译异常: ${e.message}` });
            continue;
        }

        const props = deepEqual(properties, ref.properties);
        const techs = deepEqual(techniques, ref.techniques);

        // glsl3/glsl1:对每个 ref shader,按 name "effect|vert|frag" 取程序源 → 生成 → 比对 vert/frag
        let g3pass = 0, g3total = 0, g1pass = 0, g1total = 0;
        let detail = "";
        for (const sh of ref.shaders || []) {
            const parts = String(sh.name).split("|");
            for (const [pref, key] of [[parts[1], "vert"], [parts[2], "frag"]] as const) {
                const { name: pn, entry } = splitProgramRef(pref);
                const prog = parsed.programs.get(pn);
                const src = prog ? prog.source : "";
                g3total++;
                const m3 = prog ? genGlsl3(src, entry, key) : "";
                if (m3 === sh.glsl3?.[key]) g3pass++;
                else if (!detail) detail = `glsl3.${key} [${pref}]\n  mine=${JSON.stringify(m3.slice(0, 360))}\n  ref =${JSON.stringify((sh.glsl3?.[key] || "").slice(0, 360))}`;
                g1total++;
                const m1 = prog ? genGlsl1(src, entry, key) : "";
                if (m1 === sh.glsl1?.[key]) g1pass++;
                else if (!detail) detail = `glsl1.${key} [${pref}]\n  mine=${JSON.stringify(m1.slice(0, 360))}\n  ref =${JSON.stringify((sh.glsl1?.[key] || "").slice(0, 360))}`;
            }
        }

        // P4/P5:reflection(defines/blocks/samplers/builtins)+ hash,逐 shader
        let rpass = 0, rtotal = 0;
        for (const sh of ref.shaders || []) {
            const parts = String(sh.name).split("|");
            const v = splitProgramRef(parts[1]);
            const f = splitProgramRef(parts[2]);
            const vg3 = parsed.programs.get(v.name) ? preprocess(parsed.programs.get(v.name).source) : "";
            const fg3 = parsed.programs.get(f.name) ? preprocess(parsed.programs.get(f.name).source) : "";
            const refl = reflect(vg3, fg3);
            const fields: [string, any, any][] = [
                ["defines", refl.defines, sh.defines],
                ["blocks", refl.blocks, sh.blocks],
                ["samplers", refl.samplers, sh.samplers],
                ["builtins", refl.builtins, sh.builtins],
            ];
            for (const [fname, mine, rf] of fields) {
                rtotal++;
                if (deepEqual(mine, rf)) rpass++;
                else if (!detail) detail = `${fname}\n  mine=${JSON.stringify(mine)}\n  ref =${JSON.stringify(rf)}`;
            }
            // hash = murmur(glsl1.vert + glsl1.frag, 666)
            rtotal++;
            const g1v = parsed.programs.get(v.name) ? genGlsl1(parsed.programs.get(v.name).source, v.entry, "vert") : "";
            const g1f = parsed.programs.get(f.name) ? genGlsl1(parsed.programs.get(f.name).source, f.entry, "frag") : "";
            const h = murmurhash2_32_gc(g1v + g1f, 666);
            if (String(h) === String(sh.hash)) rpass++;
            else if (!detail) detail = `hash mine=${h} ref=${sh.hash}`;
        }

        // detail 优先级:techniques > glsl3/glsl1 > reflection(detail 已按出现序)
        const row: Row = { name, props, techs, glsl3: `${g3pass}/${g3total}`, glsl1: `${g1pass}/${g1total}`, refl: `${rpass}/${rtotal}` };
        if (!techs) detail = `techniques 不一致\n  mine=${JSON.stringify(techniques)}\n  ref =${JSON.stringify(ref.techniques)}`;
        if (detail) row.detail = detail;
        rows.push(row);
    }

    const ok = (b: boolean) => (b ? "✓" : "✗");
    const frac = (s: string): [number, number] => (s.includes("/") ? (s.split("/").map(Number) as [number, number]) : [0, 0]);
    let pP = 0, pT = 0, g3p = 0, g3t = 0, g1p = 0, g1t = 0, rp = 0, rt = 0;
    for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
        const [gp, gt] = frac(r.glsl3);
        const [hp, ht] = frac(r.glsl1);
        const [rfp, rft] = frac(r.refl);
        const allok = (b: number, t: number) => (t > 0 && b === t ? "✓" : "✗");
        console.log(`  ${ok(r.props)}p ${ok(r.techs)}t ${allok(gp, gt)}g3 ${allok(hp, ht)}g1 ${allok(rfp, rft)}refl(${r.refl})  ${r.name}`);
        if (r.props) pP++;
        if (r.techs) pT++;
        g3p += gp; g3t += gt; g1p += hp; g1t += ht; rp += rfp; rt += rft;
    }
    console.log(`\n共 ${rows.length} effect:props ${pP}/${rows.length} · tech ${pT}/${rows.length} · glsl3 ${g3p}/${g3t} · glsl1 ${g1p}/${g1t} · refl+hash ${rp}/${rt}`);

    if (VERBOSE) {
        const bad = rows.find((r) => r.detail);
        if (bad) console.log(`\n首个 mismatch [${bad.name}]:\n${bad.detail}`);
    } else if (pT < rows.length || pP < rows.length || g3p < g3t || g1p < g1t || rp < rt) {
        console.log("加 -v 看 mismatch 详情");
    }
}

main();
