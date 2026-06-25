/**
 * 剥离 cocos quick-compile 的 preview wrapper,提取脚本核心 CommonJS 代码。
 *
 * temp/quick-scripts/dst 下每个脚本文件结构固定(已对 1417/1417 文件验证锚点):
 *   (function() {
 *     ... var nodeEnv / __module / __require ...
 *     function __define (exports, require, module) {
 *       if (!nodeEnv) {__quick_compile_project__.registerModule(__filename, module);}<CORE>
 *     }
 *     if (nodeEnv) { __define(...) } else { __quick_compile_project__.registerModuleFunc(...) }
 *   })();
 *   //# sourceMappingURL=...
 *
 * <CORE> 即 tsc 输出的纯 CommonJS(含 cc._RF.push/pop、require、exports),
 * 其形参名正好是 (require, module, exports),可直接作为 browserify 模块体。
 */

/** 头锚:CORE 紧跟其后 */
const HEAD = "__quick_compile_project__.registerModule(__filename, module);}";
/** 尾锚:CORE 在其前结束(匹配 __define 闭合 `}` 后的 `if (nodeEnv) {`) */
const TAIL_RE = /\n\s*\}\n\s*if \(nodeEnv\) \{/;

export interface StripResult {
    /** 纯 CommonJS 核心代码(去 sourceMap 注释) */
    core: string;
    /** cc._RF.push 注册的脚本名(若有) */
    name: string | null;
    /** cc._RF.push 注册的脚本 uuid(若有) */
    uuid: string | null;
}

/** cc._RF.push(module, 'uuid', 'name') —— 仅用于校验/日志 */
const RF_RE = /cc\._RF\.push\(\s*module\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/;

/** 从 quick-compile 文件内容剥出核心 CommonJS。失败抛错。 */
export function stripWrapper(content: string): StripResult {
    const hi = content.indexOf(HEAD);
    if (hi < 0) throw new Error("找不到 quick-compile 头锚(registerModule)");
    const afterHead = hi + HEAD.length;
    const tailMatch = TAIL_RE.exec(content.slice(afterHead));
    if (!tailMatch) throw new Error("找不到 quick-compile 尾锚(if (nodeEnv))");
    let core = content.slice(afterHead, afterHead + tailMatch.index);

    // 去掉行尾可能粘连的 sourceMappingURL(CORE 内一般没有,保险起见)
    core = core.replace(/\n?\/\/# sourceMappingURL=.*$/m, "");

    const rf = RF_RE.exec(core);
    return {
        core,
        uuid: rf ? rf[1] : null,
        name: rf ? rf[2] : null,
    };
}
