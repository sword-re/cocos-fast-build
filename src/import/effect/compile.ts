/**
 * .effect → cc.EffectAsset 编译器(复刻 cocos-effect 离线编译)。
 *
 * 阶段(见 docs/10):P1 拆块 + techniques/properties(本文件已实现);
 * P2 glsl3、P3 glsl1、P4 reflection、P5 hash 在 shaders 部分逐步补齐。
 */
import { load as yamlLoad } from "js-yaml";
import { expandIncludes } from "./chunks.js";
import { scanUniforms, reflect } from "./reflect.js";
import { PASS_PARAMS } from "./enums.js";
import { preprocess } from "./preprocess.js";
import { genGlsl3, genGlsl1, splitProgramRef } from "./glsl.js";
import { murmurhash2_32_gc } from "./murmur.js";

export interface ProgramBlock {
    name: string;
    source: string;
}
export interface ParsedEffect {
    effect: any; // CCEffect YAML
    programs: Map<string, ProgramBlock>;
}

/**
 * 把平衡 {}/[] 内的换行折叠成单行(flow 集合可安全合并)。
 * cocos CCEffect 允许多行 flow 映射(如 `edge: { value: 0.15, inspector: {...} }`),
 * 其缩进不满足 js-yaml 严格块缩进 → 折叠后即合法。字符串字面量内不折叠。
 */
function collapseFlow(yamlText: string): string {
    let depth = 0;
    let inStr: string | null = null;
    let out = "";
    for (let i = 0; i < yamlText.length; i++) {
        const c = yamlText[i];
        if (inStr) {
            out += c;
            if (c === inStr && yamlText[i - 1] !== "\\") inStr = null;
            continue;
        }
        if (c === '"' || c === "'") {
            inStr = c;
            out += c;
        } else if (c === "{" || c === "[") {
            depth++;
            out += c;
        } else if (c === "}" || c === "]") {
            depth = Math.max(0, depth - 1);
            out += c;
        } else if (depth > 0 && (c === "\n" || c === "\r")) {
            out += " "; // flow 内换行 → 空格
        } else {
            out += c;
        }
    }
    return out;
}

/** 拆 .effect 文本为 CCEffect(YAML)+ 各 CCProgram 块 */
export function parseEffect(text: string): ParsedEffect {
    const eff = /CCEffect\s*%\{([\s\S]*?)\}%/.exec(text);
    const effect = eff ? yamlLoad(collapseFlow(eff[1])) : {};
    const programs = new Map<string, ProgramBlock>();
    const re = /CCProgram\s+([\w-]+)\s*%\{([\s\S]*?)\}%/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) programs.set(m[1], { name: m[1], source: m[2] });
    return { effect, programs };
}

const SAMPLER_MIN = 27; // GFXType.SAMPLER1D 起为 sampler

/** 状态对象里字符串枚举 → 数值(递归);布尔/数值原样 */
function convertStates(node: any): any {
    if (Array.isArray(node)) return node.map(convertStates);
    if (node && typeof node === "object") {
        const out: any = {};
        for (const k in node) out[k] = convertStates(node[k]);
        return out;
    }
    if (typeof node === "string") {
        const v = PASS_PARAMS[node.toUpperCase()];
        if (v !== undefined) return v;
    }
    return node;
}

/** program 引用 "name:entry" → 程序名(去入口点后缀) */
function programName(ref: string): string {
    return ref.split(":")[0];
}

/** 某 program 引用的 uniform 名→type(include 展开后反射) */
function programUniformTypes(programs: Map<string, ProgramBlock>, ref: string): Map<string, number> {
    const prog = programs.get(programName(ref));
    if (!prog) return new Map();
    return scanUniforms(expandIncludes(prog.source));
}

/** 一个 program(name|vertRef|fragRef)→ 完整 shader 条目 */
function compileShader(parsed: ParsedEffect, programStr: string): any {
    const [, vRef, fRef] = programStr.split("|");
    const v = splitProgramRef(vRef);
    const f = splitProgramRef(fRef);
    const vSrc = parsed.programs.get(v.name)?.source ?? "";
    const fSrc = parsed.programs.get(f.name)?.source ?? "";
    const glsl3 = { vert: genGlsl3(vSrc, v.entry, "vert"), frag: genGlsl3(fSrc, f.entry, "frag") };
    const glsl1 = { vert: genGlsl1(vSrc, v.entry, "vert"), frag: genGlsl1(fSrc, f.entry, "frag") };
    const refl = reflect(preprocess(vSrc), preprocess(fSrc));
    return {
        hash: murmurhash2_32_gc(glsl1.vert + glsl1.frag, 666),
        glsl3,
        glsl1,
        builtins: refl.builtins,
        defines: refl.defines,
        blocks: refl.blocks,
        samplers: refl.samplers,
        record: null,
        name: programStr,
    };
}

/** 完整编译:.effect 文本 → cc.EffectAsset 对象 */
export function compileEffect(name: string, text: string): any {
    const parsed = parseEffect(text);
    const { techniques, properties } = compileTechniques(name, parsed);
    // shaders:各 pass 的 program 去重(保持出现序)
    const seen = new Set<string>();
    const shaders: any[] = [];
    for (const tech of techniques) {
        for (const pass of tech.passes) {
            if (seen.has(pass.program)) continue;
            seen.add(pass.program);
            shaders.push(compileShader(parsed, pass.program));
        }
    }
    return { __type__: "cc.EffectAsset", _name: name, _objFlags: 0, _native: "", properties, techniques, shaders };
}

/** 编译 techniques + 顶层 properties */
export function compileTechniques(name: string, parsed: ParsedEffect): { techniques: any[]; properties: any } {
    const eff = parsed.effect || {};
    const techniques = (eff.techniques || []).map((tech: any) => {
        const passes = (tech.passes || []).map((srcPass: any) => {
            const { vert, frag, properties: passProps, ...rest } = srcPass;
            const pass: any = {};
            // 状态字段按原顺序(rest 保留 YAML 顺序,去掉 vert/frag/properties)
            for (const k in rest) pass[k] = convertStates(rest[k]);

            // properties:补 type(从 vert+frag uniform 反射)
            if (passProps) {
                const types = new Map<string, number>([...programUniformTypes(parsed.programs, vert), ...programUniformTypes(parsed.programs, frag)]);
                const props: any = {};
                for (const pn in passProps) {
                    const p = { ...passProps[pn] };
                    const type = types.get(pn);
                    if (type !== undefined && type < SAMPLER_MIN && typeof p.value === "number") {
                        p.value = [p.value]; // 标量包数组
                    }
                    if (type !== undefined) p.type = type;
                    props[pn] = p;
                }
                pass.properties = props;
            }
            pass.program = `${name}|${vert}|${frag}`;
            return pass;
        });
        return { passes };
    });
    return { techniques, properties: eff.properties ?? null };
}
