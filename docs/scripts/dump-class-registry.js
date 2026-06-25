/**
 * 重新生成类注册表。
 * 用法:在 Cocos Creator 2.4.13 打开本项目 → 连接 cocos-mcp 面板 →
 *       通过 execute_script(target: "scene")执行本脚本 →
 *       取返回 JSON 的 .data 字段写入 tools/fast-build/data/class-registry.json。
 *
 * 见 docs/fast-build/02-class-registry.md。
 */
const reg = cc.js._registeredClassNames || {};
const out = {};
let withVals = 0;
for (const name in reg) {
    const c = reg[name];
    if (!c) continue;
    const vals = c.__values__;
    if (!vals || !vals.length) continue;
    withVals++;
    const props = [];
    for (const p of vals) {
        let a = {};
        try { a = cc.Class.attr(c, p) || {}; } catch (e) {}
        let def = a.default;
        if (typeof def === "function") { try { def = def(); } catch (e) { def = "[fn]"; } }
        const e = { k: p };
        if (def !== undefined) {
            try { JSON.stringify(def); e.d = def; } catch (_) { e.d = "[obj]"; }
        }
        if (a.editorOnly) e.eo = 1;
        if (a.ctor && a.ctor.name) e.ctor = a.ctor.name;
        else if (a.type && typeof a.type === "object") e.t = a.type.name;
        else if (a.type) e.t = a.type;
        props.push(e);
    }
    out[name] = { v: props };
    if (c.prototype && c.prototype._serialize) out[name].cs = 1;
}
const s = JSON.stringify(out);
return JSON.stringify({ classes: withVals, length: s.length, data: s });
