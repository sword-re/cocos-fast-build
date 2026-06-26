/**
 * GLSL 反射:从预处理后的 glsl3(UBO/#if 完整)抽出 shader 的
 * defines / blocks / samplers / builtins(复刻 cocos-effect 反射)。
 *
 * 规则(对 oracle 反推):
 *  - defines:vert+frag 中 #if/#ifdef/#elif 出现的所有宏名(去重、首现序),
 *    带 #if 嵌套栈作 defines 字段;type 默认 boolean(比较式则 number)。
 *  - blocks:非 builtin 的 UBO,{name,members:[{name,type,count}],defines,binding(0起)}。
 *  - samplers:sampler uniform,{name,type,count,defines,binding(30起)}。
 *  - builtins:#pragma builtin(global|local) 标记的 UBO(CCGlobal→globals、CCLocal→locals),
 *    {globals:{blocks:[{name,defines}],samplers},locals:{...}}。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TYPE_MAP } from "./enums.js";

const SAMPLER_BINDING_START = 30;
const CHUNK_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../data/effect-chunks");

/** 旧接口:uniform 名→type(供 compile.ts 补 pass.properties 的 type) */
export function scanUniforms(glsl: string): Map<string, number> {
    const out = new Map<string, number>();
    const uni = /uniform\s+(\w+)\s+(\w+)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = uni.exec(glsl))) {
        const t = TYPE_MAP[m[1]];
        if (t !== undefined) out.set(m[2], t);
    }
    const block = /uniform\s+\w+\s*\{([^}]*)\}\s*;/g;
    while ((m = block.exec(glsl))) {
        const mem = /(?:lowp|mediump|highp\s+)?\b(\w+)\s+(\w+)\s*(?:\[\s*\d+\s*\])?\s*;/g;
        let mm: RegExpExecArray | null;
        while ((mm = mem.exec(m[1]))) {
            const t = TYPE_MAP[mm[1]];
            if (t !== undefined && !out.has(mm[2])) out.set(mm[2], t);
        }
    }
    return out;
}

/** builtin UBO 名 → 类别(global|local),扫 chunk 的 #pragma builtin(X) + 紧随 uniform <Name> */
let _builtins: Map<string, "global" | "local"> | null = null;
function builtinBlocks(): Map<string, "global" | "local"> {
    if (_builtins) return _builtins;
    const map = new Map<string, "global" | "local">();
    let files: string[] = [];
    try {
        files = readdirSync(CHUNK_DIR);
    } catch {
        /* ignore */
    }
    for (const f of files) {
        if (!f.endsWith(".inc")) continue;
        const txt = readFileSync(join(CHUNK_DIR, f), "utf8");
        const re = /#pragma\s+builtin\((global|local)\)\s*\n\s*uniform\s+(\w+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(txt))) map.set(m[2], m[1] as "global" | "local");
    }
    return (_builtins = map);
}

export interface Reflection {
    defines: { name: string; type: string; defines: string[] }[];
    blocks: { name: string; members: { name: string; type: number; count: number }[]; defines: string[]; binding: number }[];
    samplers: { name: string; type: number; count: number; defines: string[]; binding: number }[];
    builtins: { globals: { blocks: { name: string; defines: string[] }[]; samplers: any[] }; locals: { blocks: { name: string; defines: string[] }[]; samplers: any[] } };
}

/** 从条件式抽宏名(去 defined/数字/运算符);判定 boolean vs number */
function condNames(cond: string): { names: string[]; numeric: boolean } {
    const numeric = /[<>=!]=|[<>]/.test(cond);
    const names = (cond.match(/[A-Za-z_]\w*/g) || []).filter((n) => n !== "defined");
    return { names, numeric };
}

/** 解析 UBO 体成员 [{name,type,count}] */
function parseMembers(body: string): { name: string; type: number; count: number }[] {
    const out: { name: string; type: number; count: number }[] = [];
    for (const seg of body.split(";")) {
        const s = seg.trim();
        if (!s) continue;
        const m = /^(?:lowp|mediump|highp)?\s*(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?$/.exec(s);
        if (!m) continue;
        const type = TYPE_MAP[m[1]];
        if (type === undefined) continue;
        out.push({ name: m[2], type, count: m[3] ? parseInt(m[3], 10) : 1 });
    }
    return out;
}

/** 对 vert+frag 两段 glsl3 反射 */
export function reflect(vertGlsl3: string, fragGlsl3: string): Reflection {
    const builtinMap = builtinBlocks();
    const r: Reflection = {
        defines: [],
        blocks: [],
        samplers: [],
        builtins: { globals: { blocks: [], samplers: [] }, locals: { blocks: [], samplers: [] } },
    };
    const defineSeen = new Set<string>();
    const blockSeen = new Set<string>();
    const samplerSeen = new Set<string>();
    let blockBinding = 0;
    let samplerBinding = SAMPLER_BINDING_START;

    const addDefine = (name: string, numeric: boolean, stack: string[]) => {
        if (defineSeen.has(name)) return;
        defineSeen.add(name);
        r.defines.push({ name, type: numeric ? "number" : "boolean", defines: [...stack] });
    };

    for (const text of [vertGlsl3, fragGlsl3]) {
        const lines = text.split("\n");
        // 帧栈:active=false 表示在 #else/#elif 负分支,该 define 不计入正向嵌套
        const stack: { name: string; active: boolean }[] = [];
        const activeNames = () => stack.filter((f) => f.active).map((f) => f.name);
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            // 预处理指令
            let m = /^#(if|ifdef|ifndef)\b(.*)$/.exec(t);
            if (m) {
                const { names, numeric } = condNames(m[2]);
                for (const n of names) addDefine(n, numeric, activeNames());
                stack.push({ name: names[0] ?? "", active: true });
                continue;
            }
            m = /^#elif\b(.*)$/.exec(t);
            if (m) {
                if (stack.length) stack[stack.length - 1].active = false; // 进入负分支
                const { names, numeric } = condNames(m[1]);
                for (const n of names) addDefine(n, numeric, activeNames());
                continue;
            }
            if (/^#else\b/.test(t)) {
                if (stack.length) stack[stack.length - 1].active = false;
                continue;
            }
            if (/^#endif\b/.test(t)) {
                stack.pop();
                continue;
            }
            if (/^#(pragma|define|extension|version)\b/.test(t)) continue;

            // sampler:uniform <samplerType> <name>;
            m = /^uniform\s+(sampler\w+)\s+(\w+)\s*;/.exec(t);
            if (m) {
                if (!samplerSeen.has(m[2])) {
                    samplerSeen.add(m[2]);
                    r.samplers.push({ name: m[2], type: TYPE_MAP[m[1]] ?? 0, count: 1, defines: activeNames(), binding: samplerBinding++ });
                }
                continue;
            }
            // UBO 起始:uniform <Name> {  → 累积到含 } 的行
            m = /^uniform\s+(\w+)\s*\{/.exec(t);
            if (m) {
                const name = m[1];
                let body = t.slice(m[0].length);
                while (!body.includes("}") && i + 1 < lines.length) body += "\n" + lines[++i];
                body = body.slice(0, body.indexOf("}"));
                if (blockSeen.has(name)) continue;
                blockSeen.add(name);
                const cat = builtinMap.get(name);
                if (cat) {
                    r.builtins[cat === "global" ? "globals" : "locals"].blocks.push({ name, defines: activeNames() });
                } else {
                    r.blocks.push({ name, members: parseMembers(body), defines: activeNames(), binding: blockBinding++ });
                }
                continue;
            }
        }
    }
    return r;
}
