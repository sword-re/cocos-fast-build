/**
 * glsl3(WebGL2)/ glsl1(WebGL1)着色器生成(预处理之上的版本特化)。
 *  - glsl3:预处理结果直接用(UBO、in/out 保留);入口非 main 追加 main 包装。
 *  - glsl1:UBO 拍平成独立 uniform(仅保留被引用成员)、in→attribute(顶点)/varying(片元)、
 *    out→varying(顶点)、texture(→texture2D(;入口非 main 追加 main 包装。
 */
import { preprocess, collapseBlankLines } from "./preprocess.js";

export type Stage = "vert" | "frag";

/** 程序引用 "name:entry" 拆分 */
export function splitProgramRef(ref: string): { name: string; entry: string } {
    const i = ref.indexOf(":");
    return i < 0 ? { name: ref, entry: "main" } : { name: ref.slice(0, i), entry: ref.slice(i + 1) };
}

/** glsl3:预处理 + 入口包装(片元用 out vec4 cc_FragColor) */
export function genGlsl3(source: string, entry: string, stage: Stage): string {
    const body = preprocess(source);
    if (entry === "main") return body;
    if (stage === "vert") return body + `\nvoid main() { gl_Position = ${entry}(); }`;
    return body + `\nout vec4 cc_FragColor;\nvoid main() { cc_FragColor = ${entry}(); }`;
}

/** glsl1:版本下转 + 入口包装(片元用 gl_FragColor) */
export function genGlsl1(source: string, entry: string, stage: Stage): string {
    const body = toGlsl1(preprocess(source), stage);
    if (entry === "main") return body;
    if (stage === "vert") return body + `\nvoid main() { gl_Position = ${entry}(); }`;
    return body + `\nvoid main() { gl_FragColor = ${entry}(); }`;
}

/** 预处理结果(glsl3 形态)→ glsl1 形态 */
function toGlsl1(text: string, stage: Stage): string {
    text = flattenUBOs(text);
    text = convertInOut(text, stage);
    text = text.replace(/\btexture\s*\(/g, "texture2D("); // WebGL1 采样
    return collapseBlankLines(text); // 拍平未用 UBO 留下的空行重新折叠

}

/** UBO `uniform Name { members };` → 逐成员独立 uniform(仅保留全文被引用者) */
function flattenUBOs(text: string): string {
    return text.replace(/uniform\s+\w+\s*\{([^}]*)\}\s*;/g, (_m, body: string) => {
        const lines: string[] = [];
        for (const seg of body.split(";")) {
            const decl = seg.trim();
            if (!decl) continue;
            const name = decl.split(/\s+/).pop()!.replace(/\[.*\]$/, "");
            // 被引用:全文出现 >1 次(本声明 + 至少一处使用)
            const uses = (text.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
            if (uses > 1) lines.push(`uniform ${decl};`);
        }
        return lines.join("\n");
    });
}

/** 行首 in/out 声明转换:顶点 in→attribute、out→varying;片元 in→varying */
function convertInOut(text: string, stage: Stage): string {
    return text
        .split("\n")
        .map((line) => {
            if (/^\s*in\b/.test(line)) return line.replace(/\bin\b/, stage === "vert" ? "attribute" : "varying");
            if (stage === "vert" && /^\s*out\b/.test(line)) return line.replace(/\bout\b/, "varying");
            return line;
        })
        .join("\n");
}
