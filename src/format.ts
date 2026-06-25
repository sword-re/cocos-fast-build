/**
 * 压缩 JSON 文件格式的类型与常量。
 * 规范见 docs/fast-build/01-serialization-spec.md §2,源自 engine deserialize-compiled.ts。
 */

export const FORMAT_VERSION = 1;
export const EMPTY = 0; // EMPTY_PLACEHOLDER

/** 顶层文件结构下标(File 枚举) */
export const File = {
    Version: 0,
    SharedUuids: 1,
    SharedStrings: 2,
    SharedClasses: 3,
    SharedMasks: 4,
    Instances: 5,
    InstanceTypes: 6,
    Refs: 7,
    DependObjs: 8,
    DependKeys: 9,
    DependUuidIndices: 10,
} as const;

/** 一个 import json 就是这样一个数组(下标语义见 File) */
export type IFileData = any[];

/** 属性类型 id(DataTypeID) */
export const DataTypeID = {
    SimpleType: 0,
    InstanceRef: 1,
    Array_InstanceRef: 2,
    Array_AssetRefByInnerObj: 3,
    Class: 4,
    ValueTypeCreated: 5,
    AssetRefByInnerObj: 6,
    TRS: 7,
    ValueType: 8,
    Array_Class: 9,
    CustomizedClass: 10,
    Dict: 11,
    Array: 12,
} as const;
