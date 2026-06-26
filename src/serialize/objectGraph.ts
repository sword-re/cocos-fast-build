/**
 * 对象图序列化(prefab / scene)—— spike 2 核心,正确性优先(非字节对齐)。
 *
 * 输入:library 对象数组(editor 格式),引用为 {__id__:n}。
 * 输出:压缩 JSON(IFileData),目标=能被引擎反序列化成等价对象图。
 *
 * 策略:
 *  - refcount:被引用 >=2 次的对象 + 根 → 顶层 Instance;单引用对象内联。
 *  - 实例↔实例引用 → Refs 表(instance-owner),属性从 keys 移除。
 *  - 内联对象→实例引用 → 负数 InstanceRef(object-owner Refs),属性保留为 InstanceRef 类型。
 *  - 资源引用:顶层实例属性 → 移除 + DependObjs(instanceIdx);内联对象属性 → AssetRefByInnerObj。
 *  - 默认值裁剪 + ValueType 归一化(见 valueType.ts / registry.ts)。
 *
 * 已实现类型:SimpleType / InstanceRef / Class / Array_Class / ValueTypeCreated / TRS /
 *            AssetRefByInnerObj / Array(simple)。
 * 未实现(遇到则抛错,留待迭代):Array_InstanceRef / Dict(含引用) / 自定义内联对象。
 */
import { DataTypeID, EMPTY, FORMAT_VERSION, type IFileData } from "../format.js";
import { assetExists } from "../assetExists.js";
import { getClassMeta } from "../registry.js";
import { compressUuid } from "../uuid.js";
import { deepEqual } from "../util/deepEqual.js";
import { encodeValueType, isValueType, valueTypeEqualsDefault } from "./valueType.js";

export class GraphUnsupported extends Error {}

interface EncodedProp {
    key: string;
    dataType: number; // DataTypeID;若为 -1 表示 SimpleType
    value: unknown;
}

const isRef = (v: any) => v && typeof v === "object" && "__id__" in v;
const isAsset = (v: any) => v && typeof v === "object" && "__uuid__" in v;
const isTRS = (v: any) => v && typeof v === "object" && v.__type__ === "TypedArray";
const isEmbeddedClass = (v: any) =>
    v && typeof v === "object" && typeof v.__type__ === "string" && !isValueType(v) && !isTRS(v);
/** 纯 JSON 对象(无 __type__/__uuid__/__id__)—— 可能是含嵌套引用的 Dict 属性 */
const isPlainObject = (v: any) =>
    v && typeof v === "object" && !Array.isArray(v) && !("__type__" in v) && !("__uuid__" in v) && !("__id__" in v);

export class GraphSerializer {
    private objs: any[];
    private refCount: number[];
    private instIdxBySrc = new Map<number, number>();
    private instSrc: number[] = []; // instanceIdx -> srcIndex

    private sharedUuids: string[] = [];
    private uuidMap = new Map<string, number>();
    private sharedStrings: string[] = [];
    private strMap = new Map<string, number>();
    private sharedClasses: any[] = [];
    private classMap = new Map<string, number>();
    private sharedMasks: any[] = [];
    private maskMap = new Map<string, number>();

    private instances: any[] = [];
    private refsObj: Array<[number, number, number]> = []; // [placeholder0, keyStrIdx, targetInst]
    private refsInst: Array<[number, number, number]> = []; // [ownerInst, keyStrIdx, targetInst]
    private dependObjs: number[] = [];
    private dependKeys: number[] = [];
    private dependUuidIdx: number[] = [];

    constructor(objs: any[]) {
        this.objs = objs;
        this.refCount = new Array(objs.length).fill(0);
    }

    serialize(): IFileData {
        this.countRefs();
        // 实例:根(0) + refcount>=2;根固定 instanceIdx 0
        this.assignInstance(0);
        for (let i = 0; i < this.objs.length; i++) {
            if (this.refCount[i] >= 2 && !this.instIdxBySrc.has(i)) this.assignInstance(i);
        }
        // 序列化每个实例(可能在过程中新增 refs/depends)
        for (let inst = 0; inst < this.instSrc.length; inst++) {
            const src = this.instSrc[inst];
            this.instances[inst] = this.encodeObject(this.objs[src], inst);
        }

        const refsFlat: number[] = [];
        for (const r of this.refsObj) refsFlat.push(r[0], r[1], r[2]);
        for (const r of this.refsInst) refsFlat.push(r[0], r[1], r[2]);
        const hasRefs = refsFlat.length > 0;
        if (hasRefs) refsFlat.push(this.refsObj.length); // OFFSET = object-owner 记录数

        const hasDep = this.dependObjs.length > 0;
        // RootInfo:根 = instance 0,无 native 依赖 => 末尾不追加数字(deserializer 默认 root=0)
        return [
            FORMAT_VERSION,
            this.sharedUuids.length ? this.sharedUuids : EMPTY,
            this.sharedStrings.length ? this.sharedStrings : EMPTY,
            this.sharedClasses,
            this.sharedMasks.length ? this.sharedMasks : EMPTY,
            this.instances,
            EMPTY, // InstanceTypes:全部为普通 CCClass 对象
            hasRefs ? refsFlat : EMPTY,
            hasDep ? this.dependObjs : [],
            hasDep ? this.dependKeys : [],
            hasDep ? this.dependUuidIdx : [],
        ];
    }

    // ---- refcount ----
    private countRefs() {
        const visit = (v: any) => {
            if (Array.isArray(v)) {
                for (const e of v) visit(e);
            } else if (v && typeof v === "object") {
                if (isRef(v)) {
                    this.refCount[v.__id__]++;
                    return; // 不深入引用目标(由其自身遍历)
                }
                for (const k in v) visit(v[k]);
            }
        };
        // 从所有对象的属性出发统计(根也算被引用一次以确保成为实例)
        this.refCount[0]++;
        for (const o of this.objs) {
            for (const k in o) if (k !== "__type__") visit(o[k]);
        }
    }

    private assignInstance(src: number): number {
        let idx = this.instIdxBySrc.get(src);
        if (idx !== undefined) return idx;
        idx = this.instSrc.length;
        this.instIdxBySrc.set(src, idx);
        this.instSrc.push(src);
        return idx;
    }

    private strIdx(s: string): number {
        let i = this.strMap.get(s);
        if (i === undefined) {
            i = this.sharedStrings.length;
            this.sharedStrings.push(s);
            this.strMap.set(s, i);
        }
        return i;
    }
    private uuidIdx(uuid: string): number {
        const c = compressUuid(uuid);
        let i = this.uuidMap.get(c);
        if (i === undefined) {
            i = this.sharedUuids.length;
            this.sharedUuids.push(c);
            this.uuidMap.set(c, i);
        }
        return i;
    }

    /** 编码一个 CCClass 对象 -> IClassObjectData [maskIdx, ...values]。ownerInst:若为顶层实例则为其下标,否则 -1(内联) */
    private encodeObject(obj: any, ownerInst: number): any[] {
        const type = obj.__type__;
        const meta = getClassMeta(type);
        if (!meta) throw new GraphUnsupported(`类不在注册表: ${type}`);
        const isInstance = ownerInst >= 0;

        const simple: EncodedProp[] = [];
        const advanced: EncodedProp[] = [];

        for (const prop of meta.v) {
            if (prop.eo) continue;
            const key = prop.k;
            if (!(key in obj)) continue;
            const val = obj[key];

            // 嵌套预制体:PrefabInfo.asset 指向外部子预制体({__uuid__})。
            // sync=false(普通嵌套,已 baked)→ 编辑器置 null;sync=true(同步实例,运行时需实例化)→ 保留为资源依赖。
            if (type === "cc.PrefabInfo" && key === "asset" && isAsset(val) && !obj.sync) continue;

            // 资源引用
            if (isAsset(val)) {
                // 悬空引用(目标资源已删除)→ 编辑器构建会丢弃
                if (!assetExists(val.__uuid__)) continue;
                if (isInstance) {
                    // 顶层实例:移出 keys,记 DependObjs=instanceIdx
                    this.dependObjs.push(ownerInst);
                    this.dependKeys.push(this.strIdx(key));
                    this.dependUuidIdx.push(this.uuidIdx(val.__uuid__));
                } else {
                    // 内联对象:AssetRefByInnerObj,value=depend 下标
                    const di = this.dependObjs.length;
                    this.dependObjs.push(0); // 占位,运行时回填
                    this.dependKeys.push(this.strIdx(key));
                    this.dependUuidIdx.push(this.uuidIdx(val.__uuid__));
                    advanced.push({ key, dataType: DataTypeID.AssetRefByInnerObj, value: di });
                }
                continue;
            }

            // 实例引用
            if (isRef(val)) {
                const targetInst = this.instIdxBySrc.get(val.__id__);
                if (targetInst === undefined) {
                    // 引用了一个被内联的对象 -> 直接内联展开为 Class
                    const sub = this.encodeObject(this.objs[val.__id__], -1);
                    advanced.push({ key, dataType: DataTypeID.Class, value: sub });
                    continue;
                }
                if (isInstance) {
                    // 实例->实例:Refs(instance-owner),移出 keys
                    this.refsInst.push([ownerInst, this.strIdx(key), targetInst]);
                } else {
                    // 内联->实例:负数 InstanceRef(object-owner Refs)
                    const refIdx = this.refsObj.length;
                    this.refsObj.push([0, this.strIdx(key), targetInst]);
                    advanced.push({ key, dataType: DataTypeID.InstanceRef, value: ~refIdx });
                }
                continue;
            }

            // 默认值裁剪(ValueType 按数值分量比较,其余深比较)
            if ("d" in prop) {
                const eq = isValueType(val) ? valueTypeEqualsDefault(val, prop.d) : deepEqual(val, prop.d);
                if (eq) continue;
            }

            // ValueType:默认值是 valuetype 形状(构造函数会预创建实例)→ ValueTypeCreated(写入既有实例);
            // 否则(default null/无,未预创建)→ ValueType(新建实例)。
            if (isValueType(val)) {
                const vtType =
                    prop.d && typeof prop.d === "object" ? DataTypeID.ValueTypeCreated : DataTypeID.ValueType;
                advanced.push({ key, dataType: vtType, value: encodeValueType(val) });
                continue;
            }
            // TRS(_trs)
            if (isTRS(val)) {
                advanced.push({ key, dataType: DataTypeID.TRS, value: val.array });
                continue;
            }
            // 内联 CCClass 对象
            if (isEmbeddedClass(val)) {
                advanced.push({ key, dataType: DataTypeID.Class, value: this.encodeObject(val, -1) });
                continue;
            }
            // 数组(可能是 SimpleType 纯简单数组,需归入 simple)
            if (Array.isArray(val)) {
                const enc = this.encodeArray(key, val);
                (enc.dataType === -1 ? simple : advanced).push(enc);
                continue;
            }
            // 纯 JSON 对象含嵌套引用/值类型(如自定义组件的 _ctrlData 字典)→ Dict,
            // 否则嵌套 {__uuid__} 被当 SimpleType 原样存、运行时不解析成资源 → 组件拿到裸对象崩
            if (isPlainObject(val) && this.needsAdvanced(val)) {
                advanced.push({ key, dataType: DataTypeID.Dict, value: this.encodeDict(val) });
                continue;
            }
            // 其余:SimpleType(基础类型 / 无引用纯 JSON 对象)
            simple.push({ key, dataType: -1, value: val });
        }

        return this.assembleClassObject(type, simple, advanced);
    }

    private encodeArray(key: string, arr: any[]): EncodedProp {
        if (arr.length === 0) return { key, dataType: -1, value: [] };

        const kind = (e: any): "instRef" | "inline" | "asset" | "other" => {
            if (isAsset(e)) return "asset";
            if (isRef(e)) return this.instIdxBySrc.has(e.__id__) ? "instRef" : "inline";
            if (isEmbeddedClass(e)) return "inline";
            return "other";
        };
        const kinds = arr.map(kind);

        // Array_AssetRefByInnerObj:资源引用数组(如 _materials)
        if (kinds.every((k) => k === "asset")) {
            const value = arr.map((e, i) => {
                const di = this.dependObjs.length;
                this.dependObjs.push(0); // owner=数组,运行时回填
                this.dependKeys.push(~i); // 数组下标
                this.dependUuidIdx.push(this.uuidIdx(e.__uuid__));
                return di;
            });
            return { key, dataType: DataTypeID.Array_AssetRefByInnerObj, value };
        }

        // Array_InstanceRef:全部是指向顶层实例的引用(如 _children)
        if (kinds.every((k) => k === "instRef")) {
            const value = arr.map((e, i) => {
                const t = this.instIdxBySrc.get(e.__id__)!;
                const refIdx = this.refsObj.length;
                this.refsObj.push([0, ~i, t]); // owner=数组(运行时回填),keyIndex=~数组下标
                return ~refIdx;
            });
            return { key, dataType: DataTypeID.Array_InstanceRef, value };
        }

        // Array_Class:全部内联对象(嵌入对象 或 指向被内联对象的引用,如 _components)
        if (kinds.every((k) => k === "inline")) {
            const items = arr.map((e) => this.encodeObject(isRef(e) ? this.objs[e.__id__] : e, -1));
            return { key, dataType: DataTypeID.Array_Class, value: items };
        }

        // 纯简单值数组(无引用/资源/值类型)-> SimpleType
        if (arr.every((e) => !isRef(e) && !isAsset(e) && !isValueType(e) && !isTRS(e) && !isEmbeddedClass(e))) {
            return { key, dataType: -1, value: arr };
        }

        // 通用 Array(DataTypeID.Array):逐元素带类型。IArrayData = [values, ...types]
        const values: unknown[] = [];
        const types: number[] = [];
        arr.forEach((e, i) => {
            const enc = this.encodeArrayElement(e, i);
            values.push(enc.value);
            types.push(enc.type);
        });
        return { key, dataType: DataTypeID.Array, value: [values, ...types] };
    }

    /** 通用数组元素编码:返回 {value, type(DataTypeID)} 并按需登记 Refs/Depends(owner=数组) */
    private encodeArrayElement(e: any, i: number): { value: unknown; type: number } {
        if (isAsset(e)) {
            const di = this.dependObjs.length;
            this.dependObjs.push(0);
            this.dependKeys.push(~i);
            this.dependUuidIdx.push(this.uuidIdx(e.__uuid__));
            return { value: di, type: DataTypeID.AssetRefByInnerObj };
        }
        if (isRef(e)) {
            const t = this.instIdxBySrc.get(e.__id__);
            if (t !== undefined) {
                const refIdx = this.refsObj.length;
                this.refsObj.push([0, ~i, t]);
                return { value: ~refIdx, type: DataTypeID.InstanceRef };
            }
            return { value: this.encodeObject(this.objs[e.__id__], -1), type: DataTypeID.Class };
        }
        if (isValueType(e)) return { value: encodeValueType(e), type: DataTypeID.ValueType };
        if (isEmbeddedClass(e)) return { value: this.encodeObject(e, -1), type: DataTypeID.Class };
        if (isPlainObject(e) && this.needsAdvanced(e)) return { value: this.encodeDict(e), type: DataTypeID.Dict };
        return { value: e, type: DataTypeID.SimpleType };
    }

    /** 值(递归)是否含高级类型(资源引用 / 实例引用 / 值类型 / 内嵌 __type__)→ 需 Dict/Array 编码 */
    private needsAdvanced(v: any): boolean {
        if (isAsset(v) || isRef(v) || isValueType(v)) return true;
        if (Array.isArray(v)) return v.some((e) => this.needsAdvanced(e));
        if (v && typeof v === "object") {
            if ("__type__" in v) return true; // 内嵌 class / TRS
            return Object.values(v).some((e) => this.needsAdvanced(e));
        }
        return false;
    }

    /** 纯对象 → Dict(DataTypeID.Dict):[simpleObj, k1,t1,v1, ...],嵌套引用抽进 depend 表 */
    private encodeDict(obj: Record<string, any>): any[] {
        const simpleObj: Record<string, any> = {};
        const adv: any[] = [];
        for (const k of Object.keys(obj)) {
            const val = obj[k];
            if (isAsset(val)) {
                if (!assetExists(val.__uuid__)) continue; // 悬空引用,丢弃
                const di = this.dependObjs.length;
                this.dependObjs.push(0); // 内嵌对象 owner 运行时回填
                this.dependKeys.push(this.strIdx(k));
                this.dependUuidIdx.push(this.uuidIdx(val.__uuid__));
                adv.push(k, DataTypeID.AssetRefByInnerObj, di);
            } else if (isValueType(val)) {
                adv.push(k, DataTypeID.ValueType, encodeValueType(val));
            } else if (isRef(val)) {
                const t = this.instIdxBySrc.get(val.__id__);
                if (t !== undefined) {
                    const refIdx = this.refsObj.length;
                    this.refsObj.push([0, this.strIdx(k), t]);
                    adv.push(k, DataTypeID.InstanceRef, ~refIdx);
                } else {
                    adv.push(k, DataTypeID.Class, this.encodeObject(this.objs[val.__id__], -1));
                }
            } else if (isEmbeddedClass(val)) {
                adv.push(k, DataTypeID.Class, this.encodeObject(val, -1));
            } else if (Array.isArray(val) && this.needsAdvanced(val)) {
                const values: unknown[] = [];
                const types: number[] = [];
                val.forEach((e, i) => {
                    const enc = this.encodeArrayElement(e, i);
                    values.push(enc.value);
                    types.push(enc.type);
                });
                adv.push(k, DataTypeID.Array, [values, ...types]);
            } else if (isPlainObject(val) && this.needsAdvanced(val)) {
                adv.push(k, DataTypeID.Dict, this.encodeDict(val));
            } else {
                simpleObj[k] = val;
            }
        }
        return [simpleObj, ...adv];
    }

    private assembleClassObject(type: string, simple: EncodedProp[], advanced: EncodedProp[]): any[] {
        const keys = [...simple.map((p) => p.key), ...advanced.map((p) => p.key)];
        const numSimple = simple.length;
        const advTypes = advanced.map((p) => p.dataType);

        const iclass = [type, keys, 3 - numSimple, ...advTypes];
        const classIdx = this.internClass(iclass);

        const keyIndices = keys.map((_, i) => i);
        const imask = [classIdx, ...keyIndices, 1 + numSimple];
        const maskIdx = this.internMask(imask);

        return [maskIdx, ...simple.map((p) => p.value), ...advanced.map((p) => p.value)];
    }

    private internClass(iclass: any[]): number {
        const sig = JSON.stringify(iclass);
        let i = this.classMap.get(sig);
        if (i === undefined) {
            i = this.sharedClasses.length;
            this.sharedClasses.push(iclass);
            this.classMap.set(sig, i);
        }
        return i;
    }
    private internMask(imask: number[]): number {
        const sig = JSON.stringify(imask);
        let i = this.maskMap.get(sig);
        if (i === undefined) {
            i = this.sharedMasks.length;
            this.sharedMasks.push(imask);
            this.maskMap.set(sig, i);
        }
        return i;
    }
}

/** 累计被剥离的"缺失类"(脚本已删但 prefab 仍引用),供构建层汇总日志 */
const _strippedMissingClasses = new Map<string, number>();
export function strippedMissingClasses(): Array<[string, number]> {
    return [..._strippedMissingClasses.entries()];
}

/**
 * 剥离"缺失类"组件/引用(对齐编辑器:缺失脚本组件被剔除而非报错丢整资源)。
 * 缺失类 = 对象 __type__ 是 CCClass 但不在注册表(且非 ValueType/TRS)——通常是脚本已删除、
 * prefab 仍残留该组件的 __type__(悬空引用)。处理:把所有指向这些对象的 __id__ 引用
 * 在数组里丢弃、在对象属性里置 null;坏对象随之成孤儿不被序列化。返回是否有剥离。
 */
function stripMissingClasses(objs: any[]): boolean {
    const bad = new Set<number>();
    for (let i = 0; i < objs.length; i++) {
        const o = objs[i];
        if (!o || typeof o !== "object" || typeof o.__type__ !== "string") continue;
        if (isValueType(o) || isTRS(o)) continue;
        if (!getClassMeta(o.__type__)) {
            bad.add(i);
            _strippedMissingClasses.set(o.__type__, (_strippedMissingClasses.get(o.__type__) ?? 0) + 1);
        }
    }
    if (!bad.size) return false;
    const clean = (v: any): any => {
        if (Array.isArray(v)) {
            const out: any[] = [];
            for (const e of v) {
                if (isRef(e) && bad.has(e.__id__)) continue; // 丢弃指向缺失类的数组元素(如 node._components)
                out.push(clean(e));
            }
            return out;
        }
        if (v && typeof v === "object") {
            if (isRef(v) || isAsset(v)) return v;
            for (const k in v) {
                const val = v[k];
                if (isRef(val) && bad.has(val.__id__)) v[k] = null; // 属性引用缺失类 → 置 null
                else v[k] = clean(val);
            }
            return v;
        }
        return v;
    };
    for (let i = 0; i < objs.length; i++) if (!bad.has(i)) clean(objs[i]);
    return true;
}

export function serializeObjectGraph(objs: any[]): IFileData {
    stripMissingClasses(objs);
    return new GraphSerializer(objs).serialize();
}
