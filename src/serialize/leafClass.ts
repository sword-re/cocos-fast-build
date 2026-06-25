/**
 * 叶子 CCClass 序列化(支持嵌套高级类型)。
 *
 * 相比 genericClass.ts(只处理顶层 SimpleType + 顶层资源引用),本编码器额外支持:
 *  - 含嵌套资源引用 / 值类型的对象属性 → Dict(DataTypeID.Dict),
 *    嵌套 {__uuid__} → AssetRefByInnerObj(进 depend 表),cc.Color 等 → ValueType。
 *
 * 动机:cc.Material 的 _techniqueData.props 里有纹理 {__uuid__} 与 cc.Color。若按 SimpleType
 * 原样存,运行时 props.texture 是未解析的 {__uuid__} 对象,Material.onLoad 设置 pass 属性时
 * 调 texture.getImpl() 崩溃(e.getImpl is not a function)。
 *
 * 规则与真实产物对照(Entry/04288d393 pack 的 label-gradient_two):
 *  - 不含任何嵌套高级类型的对象 → 仍按 SimpleType 原样存(与无纹理材质 Round_bg 真实产物一致)。
 *  - Material class:["cc.Material",["_name","_techniqueData"],propTypeOffset, ...advTypes];
 *    _effectAsset 抽为顶层 depend(不入 keys);_techniqueData 视内容为 SimpleType 或 Dict。
 */
import { DataTypeID, EMPTY, FORMAT_VERSION, type IFileData } from "../format.js";
import { getClassMeta } from "../registry.js";
import { compressUuid } from "../uuid.js";
import { deepEqual } from "../util/deepEqual.js";
import { assetExists } from "../assetExists.js";
import { encodeValueType, isValueType } from "./valueType.js";

const isAsset = (v: any): v is { __uuid__: string } => !!v && typeof v === "object" && typeof v.__uuid__ === "string";
const isPlainObject = (v: any): boolean =>
    !!v && typeof v === "object" && !Array.isArray(v) && !("__type__" in v) && !("__uuid__" in v) && !("__id__" in v);

class LeafClassSerializer {
    private sUuids: string[] = [];
    private uMap = new Map<string, number>();
    private sStrings: string[] = [];
    private strMap = new Map<string, number>();
    private dObjs: number[] = [];
    private dKeys: number[] = [];
    private dUuid: number[] = [];

    private strIdx(s: string): number {
        let i = this.strMap.get(s);
        if (i === undefined) {
            i = this.sStrings.length;
            this.sStrings.push(s);
            this.strMap.set(s, i);
        }
        return i;
    }
    private uuidIdx(u: string): number {
        const c = compressUuid(u);
        let i = this.uMap.get(c);
        if (i === undefined) {
            i = this.sUuids.length;
            this.sUuids.push(c);
            this.uMap.set(c, i);
        }
        return i;
    }

    /** 值(递归)是否含高级类型(资源引用 / 值类型 / 内嵌 __type__)→ 需 Dict/Array 编码而非 SimpleType */
    private needsAdvanced(v: any): boolean {
        if (isAsset(v) || isValueType(v)) return true;
        if (Array.isArray(v)) return v.some((e) => this.needsAdvanced(e));
        if (v && typeof v === "object" && "__type__" in v) return true; // 内嵌 class(非值类型)
        if (isPlainObject(v)) return Object.values(v).some((e) => this.needsAdvanced(e));
        return false;
    }

    /** 内嵌资源引用 → 登记 depend(owner 占位 0,运行时回填),返回 depend 下标。key 为字符串属性名或 ~数组下标 */
    private innerAssetRef(key: number, uuid: string): number {
        const di = this.dObjs.length;
        this.dObjs.push(0); // 内嵌对象 owner 运行时回填
        this.dKeys.push(key);
        this.dUuid.push(this.uuidIdx(uuid));
        return di;
    }

    /** plain object → Dict(DataTypeID.Dict):[simpleObj, k1,t1,v1, ...] */
    private encodeDict(obj: Record<string, any>): any[] {
        const simpleObj: Record<string, any> = {};
        const adv: any[] = [];
        for (const k of Object.keys(obj)) {
            const val = obj[k];
            if (isAsset(val)) {
                if (!assetExists(val.__uuid__)) continue; // 悬空引用
                adv.push(k, DataTypeID.AssetRefByInnerObj, this.innerAssetRef(this.strIdx(k), val.__uuid__));
            } else if (isValueType(val)) {
                adv.push(k, DataTypeID.ValueType, encodeValueType(val));
            } else if (Array.isArray(val) && this.needsAdvanced(val)) {
                adv.push(k, DataTypeID.Array, this.encodeArray(val));
            } else if (isPlainObject(val) && this.needsAdvanced(val)) {
                adv.push(k, DataTypeID.Dict, this.encodeDict(val));
            } else {
                simpleObj[k] = val;
            }
        }
        return [simpleObj, ...adv];
    }

    /** 通用数组(DataTypeID.Array):[values, ...types];数组元素的资源引用 depend key 用 ~下标 */
    private encodeArray(arr: any[]): any[] {
        const values: any[] = [];
        const types: number[] = [];
        arr.forEach((e, i) => {
            if (isAsset(e)) {
                if (!assetExists(e.__uuid__)) {
                    values.push(null);
                    types.push(DataTypeID.SimpleType);
                    return;
                }
                values.push(this.innerAssetRef(~i, e.__uuid__));
                types.push(DataTypeID.AssetRefByInnerObj);
            } else if (isValueType(e)) {
                values.push(encodeValueType(e));
                types.push(DataTypeID.ValueType);
            } else if (isPlainObject(e) && this.needsAdvanced(e)) {
                values.push(this.encodeDict(e));
                types.push(DataTypeID.Dict);
            } else {
                values.push(e);
                types.push(DataTypeID.SimpleType);
            }
        });
        return [values, ...types];
    }

    serialize(type: string, lib: any): IFileData {
        const meta = getClassMeta(type);
        if (!meta) throw new Error(`类未注册: ${type}`);

        const simpleKeys: string[] = [];
        const simpleVals: any[] = [];
        const advKeys: string[] = [];
        const advTypes: number[] = [];
        const advVals: any[] = [];

        for (const prop of meta.v) {
            if (prop.eo) continue;
            const key = prop.k;
            if (!(key in lib)) continue;
            const val = lib[key];

            // 顶层资源引用 → depend(owner = 根实例 0),不入 class keys
            if (isAsset(val)) {
                if (!assetExists(val.__uuid__)) continue;
                this.dObjs.push(0);
                this.dKeys.push(this.strIdx(key));
                this.dUuid.push(this.uuidIdx(val.__uuid__));
                continue;
            }
            // 默认值裁剪(值类型不在此裁剪)
            if ("d" in prop && !isValueType(val) && deepEqual(val, prop.d)) continue;

            if (isValueType(val)) {
                advKeys.push(key);
                advTypes.push(DataTypeID.ValueType);
                advVals.push(encodeValueType(val));
            } else if (Array.isArray(val) && this.needsAdvanced(val)) {
                advKeys.push(key);
                advTypes.push(DataTypeID.Array);
                advVals.push(this.encodeArray(val));
            } else if (isPlainObject(val) && this.needsAdvanced(val)) {
                advKeys.push(key);
                advTypes.push(DataTypeID.Dict);
                advVals.push(this.encodeDict(val));
            } else {
                simpleKeys.push(key);
                simpleVals.push(val);
            }
        }

        const keys = [...simpleKeys, ...advKeys];
        const numSimple = simpleKeys.length;
        const iclass = [type, keys, 3 - numSimple, ...advTypes];
        const keyIdx = keys.map((_, i) => i);
        const imask = [0, ...keyIdx, 1 + numSimple];
        const objectData = [0, ...simpleVals, ...advVals];

        const hasNative = typeof lib._native === "string" && lib._native.length > 0;
        const instances: any[] = [objectData];
        if (hasNative) instances.push(~0); // RootInfo:根=0 且有 native 依赖

        const hasDep = this.dObjs.length > 0;
        return [
            FORMAT_VERSION,
            this.sUuids.length ? this.sUuids : EMPTY,
            this.sStrings.length ? this.sStrings : EMPTY,
            [iclass],
            [imask],
            instances,
            EMPTY, // InstanceTypes:普通 CCClass(用 mask)
            EMPTY, // Refs
            hasDep ? this.dObjs : [],
            hasDep ? this.dKeys : [],
            hasDep ? this.dUuid : [],
        ];
    }
}

export function serializeLeafClass(type: string, lib: any): IFileData {
    return new LeafClassSerializer().serialize(type, lib);
}
