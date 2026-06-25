/**
 * 通用 CCClass 序列化路径(spike 1b)。
 * 适用于未覆盖 _serialize 的类(占 962 类中的绝大多数)。
 *
 * 规则(从样本 + 注册表推导,见 spec §2.3/§2.7):
 *  - 字段顺序 = 类的 __values__ 顺序;
 *  - editorOnly 字段丢弃;
 *  - 值等于默认值则裁剪;
 *  - 资源引用({__uuid__})抽出 keys,进依赖三表;
 *  - propTypeOffset = 3 - 简单字段数;
 *  - mask = [classIdx, ...字段下标, 1+简单字段数];
 *  - 若根资源有 _native,则 Instances 末尾追加 RootInfo = ~rootIndex。
 *
 * 当前仅处理 SimpleType 字段(叶子资源足够);ValueType/嵌套Class/数组等留待 spike 2。
 */
import { EMPTY, FORMAT_VERSION, type IFileData } from "../format.js";
import { getClassMeta } from "../registry.js";
import { compressUuid } from "../uuid.js";
import { deepEqual } from "../util/deepEqual.js";

function isAssetRef(val: unknown): val is { __uuid__: string } {
    return !!val && typeof val === "object" && "__uuid__" in (val as object);
}

export function serializeGenericLeaf(type: string, lib: any): IFileData {
    const meta = getClassMeta(type);
    if (!meta) throw new Error(`类未在注册表中: ${type}`);

    const simpleKeys: string[] = [];
    const simpleVals: unknown[] = [];
    const depKeys: string[] = []; // 资源引用属性名
    const depUuids: string[] = []; // 压缩 uuid

    for (const prop of meta.v) {
        if (prop.eo) continue; // editorOnly
        const key = prop.k;
        if (!(key in lib)) continue; // 缺失视为默认
        const val = lib[key];

        if (isAssetRef(val)) {
            depKeys.push(key);
            depUuids.push(compressUuid(val.__uuid__));
            continue;
        }
        // 资源引用为空(null)且默认即 null → 裁剪
        if ("d" in prop && deepEqual(val, prop.d)) continue;

        // 目前一律按 SimpleType 处理(叶子资源)
        simpleKeys.push(key);
        simpleVals.push(val);
    }

    const hasDep = depKeys.length > 0;
    const numSimple = simpleKeys.length;
    const keys = simpleKeys; // 暂无 advanced

    // IClass: [name, keys, propTypeOffset, ...advancedTypes]
    const iclass = [type, keys, 3 - numSimple];
    // IMask: [classIdx, ...keyIndices, maskTypeOffset]
    const keyIndices = keys.map((_, i) => i);
    const imask = [0, ...keyIndices, 1 + numSimple];
    // ObjectData: [maskIdx, ...values]
    const objectData = [0, ...simpleVals];

    const hasNativeDep = typeof lib._native === "string" && lib._native.length > 0;
    const instances: unknown[] = [objectData];
    if (hasNativeDep) instances.push(~0); // RootInfo: root=0 且有 native 依赖 => -1

    return [
        FORMAT_VERSION,
        hasDep ? depUuids : EMPTY, // SharedUuids
        hasDep ? depKeys : EMPTY, // SharedStrings
        [iclass], // SharedClasses
        [imask], // SharedMasks
        instances, // Instances
        EMPTY, // InstanceTypes(普通对象)
        EMPTY, // Refs
        hasDep ? depKeys.map((_, i) => 0) : [], // DependObjs(均指向 instance 0)
        hasDep ? depKeys.map((_, i) => i) : [], // DependKeys -> SharedStrings 下标
        hasDep ? depKeys.map((_, i) => i) : [], // DependUuidIndices -> SharedUuids 下标
    ];
}
