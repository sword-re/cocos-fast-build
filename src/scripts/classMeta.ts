/**
 * 项目脚本类元数据提取(脱离编辑器,从 .ts 源 AST 自取 @ccclass/@property)。
 *
 * 背景:通用 CCClass 序列化需要每个类的"可序列化字段(有序)+ 默认值 + editorOnly"。
 * 这份数据原本来自一次性的编辑器 dump(data/class-registry.json),项目脚本一旦新增
 * @property(新组件引用),静态 dump 不含该字段 → 序列化器跳过 → 运行时该引用为 null →
 * 脚本 onLoad/onEnable 裸用即崩(典型表现:render-flow 报 `_renderComponent` 为 null)。
 *
 * 本模块用 ts413(与脚本自编译同款 TS 4.1.3)解析 assets 下所有 .ts,提取每个 @ccclass 类的
 * @property 字段(名 / 默认值 / serializable / editorOnly)与继承基类,展开继承链得到完整
 * 可序列化字段,产出 registry overlay。构建时(序列化前)用它"只增不删"地增补注册表:
 *  - 已有条目:补齐缺失字段(未改动的类零变化)
 *  - 全新组件类(uuid key):用 cc.Component 前缀 + 继承展开新建
 * 失败模式均安全:默认值取不到 → 不写 d → 该字段永不被默认值裁剪(照常序列化,正确只是略大)。
 *
 * 序列化器实际只读 PropMeta 的 k / d / eo(已核 objectGraph/leafClass/genericClass),故不产出 ctor/t。
 */
import ts from "ts413";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import { compressUuidRF } from "../uuid.js";
import { registry, type ClassMeta, type PropMeta } from "../registry.js";

const ASSETS = join(PROJECT_ROOT, "assets");

/** cc.Component 的可序列化基类前缀(每个项目组件类 __values__ 的固定开头) */
const COMPONENT_PREFIX: PropMeta[] = [
    { k: "_name", d: "" },
    { k: "_objFlags", d: 0 },
    { k: "node", d: null },
    { k: "_enabled", d: true },
];

interface ExtractedProp {
    k: string;
    serializable: boolean;
    editorOnly: boolean;
    hasDefault: boolean;
    default: unknown;
}
interface ExtractedClass {
    className: string;
    ccName: string | null; // @ccclass('Name') 的显式名
    ext: string | null; // 基类名(可能带点号,如 cc.Button / 项目类名)
    file: string;
    uuid: string; // 所在脚本 .meta 的 uuid(空串=无 meta)
    props: ExtractedProp[];
}

// ── AST 辅助 ──

/** 简单字面量初始值求值;无法确定返回 {hasDefault:false}(→ 不写默认值,序列化时永不裁剪,安全) */
function evalInitializer(node: ts.Expression | undefined): { hasDefault: boolean; value?: unknown } {
    if (!node) return { hasDefault: false };
    switch (node.kind) {
        case ts.SyntaxKind.NullKeyword:
            return { hasDefault: true, value: null };
        case ts.SyntaxKind.TrueKeyword:
            return { hasDefault: true, value: true };
        case ts.SyntaxKind.FalseKeyword:
            return { hasDefault: true, value: false };
        case ts.SyntaxKind.StringLiteral:
            return { hasDefault: true, value: (node as ts.StringLiteral).text };
        case ts.SyntaxKind.NumericLiteral:
            return { hasDefault: true, value: Number((node as ts.NumericLiteral).text) };
        case ts.SyntaxKind.PrefixUnaryExpression: {
            const u = node as ts.PrefixUnaryExpression;
            if (u.operator === ts.SyntaxKind.MinusToken && u.operand.kind === ts.SyntaxKind.NumericLiteral)
                return { hasDefault: true, value: -Number((u.operand as ts.NumericLiteral).text) };
            return { hasDefault: false };
        }
        case ts.SyntaxKind.ArrayLiteralExpression:
            return (node as ts.ArrayLiteralExpression).elements.length === 0 ? { hasDefault: true, value: [] } : { hasDefault: false };
        case ts.SyntaxKind.ObjectLiteralExpression:
            return (node as ts.ObjectLiteralExpression).properties.length === 0 ? { hasDefault: true, value: {} } : { hasDefault: false };
        default:
            return { hasDefault: false };
    }
}

/** 表达式的完整点号名:Identifier→名;a.b→"a.b"(用于基类名,保留 cc. 前缀) */
function dottedName(e: ts.Expression): string {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return dottedName(e.expression) + "." + e.name.text;
    return e.getText();
}
/** 装饰器名只取末段:cc.ccclass→ccclass、property→property */
function decoratorName(e: ts.Expression): string {
    const n = dottedName(e);
    const i = n.lastIndexOf(".");
    return i >= 0 ? n.slice(i + 1) : n;
}
/** 解出装饰器 {名, 参数} */
function decoratorCall(d: ts.Decorator): { name: string; args: ts.NodeArray<ts.Expression> | null } {
    const e = d.expression;
    if (ts.isCallExpression(e)) return { name: decoratorName(e.expression), args: e.arguments };
    return { name: decoratorName(e), args: null };
}
/** 解析 @property({serializable,editorOnly}) 选项(其余形态默认 serializable:true) */
function parsePropertyOptions(args: ts.NodeArray<ts.Expression> | null): { serializable: boolean; editorOnly: boolean } {
    const opt = { serializable: true, editorOnly: false };
    if (args && args[0] && ts.isObjectLiteralExpression(args[0])) {
        for (const p of args[0].properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const k = p.name.getText();
            if (k === "serializable") opt.serializable = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
            if (k === "editorOnly") opt.editorOnly = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
        }
    }
    return opt;
}

/** 解析单个 .ts 文件,返回其中所有 @ccclass 类 */
function extractFile(file: string, uuid: string): ExtractedClass[] {
    let src: string;
    try {
        src = readFileSync(file, "utf8");
    } catch {
        return [];
    }
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2015, true);
    const out: ExtractedClass[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) && node.name && node.decorators) {
            let isCC = false;
            let ccName: string | null = null;
            for (const d of node.decorators) {
                const c = decoratorCall(d);
                if (c.name === "ccclass") {
                    isCC = true;
                    if (c.args && c.args[0] && ts.isStringLiteral(c.args[0])) ccName = c.args[0].text;
                }
            }
            if (isCC) {
                // 构造函数里的字段初始值(TS 把 `x = v` 编进构造函数 this.x = v)
                const inits: Record<string, ts.Expression> = {};
                for (const m of node.members) {
                    if (ts.isConstructorDeclaration(m) && m.body) {
                        for (const st of m.body.statements) {
                            if (
                                ts.isExpressionStatement(st) &&
                                ts.isBinaryExpression(st.expression) &&
                                st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
                            ) {
                                const l = st.expression.left;
                                if (ts.isPropertyAccessExpression(l) && l.expression.kind === ts.SyntaxKind.ThisKeyword)
                                    inits[l.name.text] = st.expression.right;
                            }
                        }
                    }
                }
                const props: ExtractedProp[] = [];
                for (const m of node.members) {
                    if (!ts.isPropertyDeclaration(m) || !m.decorators) continue;
                    let isProp = false;
                    let args: ts.NodeArray<ts.Expression> | null = null;
                    for (const d of m.decorators) {
                        const c = decoratorCall(d);
                        if (c.name === "property") {
                            isProp = true;
                            args = c.args;
                        }
                    }
                    if (!isProp) continue;
                    const name = m.name.getText();
                    const opt = parsePropertyOptions(args);
                    const ev = evalInitializer(m.initializer ?? inits[name]);
                    props.push({ k: name, serializable: opt.serializable, editorOnly: opt.editorOnly, hasDefault: ev.hasDefault, default: ev.value });
                }
                let ext: string | null = null;
                if (node.heritageClauses) {
                    for (const h of node.heritageClauses) {
                        if (h.token === ts.SyntaxKind.ExtendsKeyword && h.types[0]) ext = dottedName(h.types[0].expression);
                    }
                }
                out.push({ className: node.name.text, ccName, ext, file, uuid, props });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/** 递归枚举 assets 下所有 .ts(排除 .d.ts) */
function walkTs(dir: string, acc: string[]): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkTs(p, acc);
        else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) acc.push(p);
    }
    return acc;
}

function metaUuid(file: string): string {
    try {
        return JSON.parse(readFileSync(file + ".meta", "utf8")).uuid ?? "";
    } catch {
        return "";
    }
}

let _overlay: Record<string, ClassMeta> | null = null;

export interface ClassMetaStats {
    files: number;
    classes: number;
    newEntries: number; // 新建的类条目数
    augmentedEntries: number; // 被补字段的已有条目数
    addedProps: number; // 累计补入的字段数
    ms: number;
}
let _stats: ClassMetaStats | null = null;
export function classMetaStats(): ClassMetaStats | null {
    return _stats;
}

/**
 * 扫描项目脚本,产出 registry overlay(每个项目类 → 完整可序列化字段 ClassMeta)。
 * 结果进程内 memoize。
 */
export function extractClassMetaOverlay(onLog?: (m: string) => void): Record<string, ClassMeta> {
    if (_overlay) return _overlay;
    const t0 = Date.now();
    const log = onLog ?? (() => {});

    const files = walkTs(ASSETS, []);
    const all: ExtractedClass[] = [];
    const byName = new Map<string, ExtractedClass>();
    for (const f of files) {
        for (const c of extractFile(f, metaUuid(f))) {
            all.push(c);
            if (!byName.has(c.className)) byName.set(c.className, c);
        }
    }

    const reg = registry();

    // cc.* 基类是否为组件:registry.v 同时含 node 与 _enabled
    const ccIsComponent = (name: string): boolean => {
        if (name === "cc.Component") return true;
        const e = reg[name];
        if (!e) return false;
        const ks = new Set(e.v.map((p) => p.k));
        return ks.has("node") && ks.has("_enabled");
    };
    const isComponent = (cls: ExtractedClass | undefined, seen = new Set<string>()): boolean => {
        if (!cls || !cls.ext || seen.has(cls.className)) return false;
        seen.add(cls.className);
        if (cls.ext === "cc.Component") return true;
        const base = byName.get(cls.ext);
        if (base) return isComponent(base, seen);
        return ccIsComponent(cls.ext);
    };

    // 展开继承链 → 完整 PropMeta[](父在前,去重,子覆盖)
    const flatten = (cls: ExtractedClass, seen = new Set<string>()): PropMeta[] => {
        if (seen.has(cls.className)) return [];
        seen.add(cls.className);
        let base: PropMeta[];
        const baseCls = cls.ext ? byName.get(cls.ext) : undefined;
        if (baseCls) base = flatten(baseCls, seen);
        else if (cls.ext && reg[cls.ext]) base = reg[cls.ext].v.slice(); // cc.* 基类(cc.Button 等)
        else base = COMPONENT_PREFIX.slice(); // 兜底:按 cc.Component
        const keys = new Set(base.map((p) => p.k));
        const v = base.slice();
        for (const p of cls.props) {
            if (p.serializable === false || keys.has(p.k)) continue;
            const meta: PropMeta = { k: p.k };
            if (p.hasDefault) meta.d = p.default;
            if (p.editorOnly) meta.eo = 1;
            v.push(meta);
            keys.add(p.k);
        }
        return v;
    };

    const overlay: Record<string, ClassMeta> = {};
    for (const cls of all) {
        // 解析 registry key:组件类 → compressUuidRF(脚本 uuid);其余 @ccclass → 显式名/类名
        const comp = isComponent(cls);
        let key: string;
        if (comp) {
            if (!cls.uuid) continue; // 组件却无 meta uuid:无法定位,跳过
            key = compressUuidRF(cls.uuid);
        } else {
            key = cls.ccName ?? cls.className;
        }
        overlay[key] = { v: flatten(cls) };
        // 标注是否组件,供 augment 决定是否允许新建(数据类不新建)
        (overlay[key] as ClassMeta & { __comp?: boolean }).__comp = comp;
    }

    _overlay = overlay;
    _stats = {
        files: files.length,
        classes: all.length,
        newEntries: 0,
        augmentedEntries: 0,
        addedProps: 0,
        ms: Date.now() - t0,
    };
    log(`脚本类扫描: ${files.length} 文件 / ${all.length} 个 @ccclass 类, 耗时 ${_stats.ms}ms`);
    return overlay;
}

export function resetClassMetaCache(): void {
    _overlay = null;
    _stats = null;
}
