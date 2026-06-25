/**
 * ValueType 编码与默认值归一化。
 * BuiltinValueTypes 顺序(engine deserialize-compiled.ts L48):
 *   Vec2=0 Vec3=1 Vec4=2 Quat=3 Color=4 Size=5 Rect=6 Mat4=7
 * IValueTypeData = [setterIndex, ...分量]
 */

export const VALUE_TYPE_NAMES: Record<string, number> = {
    "cc.Vec2": 0,
    "cc.Vec3": 1,
    "cc.Vec4": 2,
    "cc.Quat": 3,
    "cc.Color": 4,
    "cc.Size": 5,
    "cc.Rect": 6,
    "cc.Mat4": 7,
};

export function isValueType(v: any): boolean {
    return !!v && typeof v === "object" && typeof v.__type__ === "string" && v.__type__ in VALUE_TYPE_NAMES;
}

/** library 值类型对象 → IValueTypeData 数组 */
export function encodeValueType(v: any): number[] {
    const id = VALUE_TYPE_NAMES[v.__type__];
    switch (id) {
        case 0: // Vec2
            return [0, v.x, v.y];
        case 1: // Vec3
            return [1, v.x, v.y, v.z];
        case 2: // Vec4
        case 3: // Quat
            return [id, v.x, v.y, v.z, v.w];
        case 4: // Color -> _val
            return [4, colorVal(v)];
        case 5: // Size
            return [5, v.width, v.height];
        case 6: // Rect
            return [6, v.x, v.y, v.width, v.height];
        case 7: // Mat4
            return [7, ...mat4Array(v)];
        default:
            throw new Error(`未知 ValueType: ${v.__type__}`);
    }
}

/**
 * ValueType 默认值比较:把值归一化后,与注册表默认按数值分量比较,缺失分量视为 0。
 * (注册表里 Vec2 默认可能含 z:0,而值只有 x,y;需按 0 对齐)
 */
export function valueTypeEqualsDefault(val: any, def: any): boolean {
    if (!def || typeof def !== "object") return false;
    const nv = normalizeForDefault(val) as Record<string, number>;
    const keys = new Set([...Object.keys(nv), ...Object.keys(def)]);
    for (const k of keys) {
        if ((nv[k] ?? 0) !== ((def as Record<string, number>)[k] ?? 0)) return false;
    }
    return true;
}

/** Color {r,g,b,a} -> _val (engine: r | g<<8 | b<<16 | a<<24, >>>0) */
export function colorVal(c: any): number {
    if (typeof c._val === "number") return c._val >>> 0;
    const r = c.r ?? 255;
    const g = c.g ?? 255;
    const b = c.b ?? 255;
    const a = c.a ?? 255;
    return ((r | (g << 8) | (b << 16) | (a << 24)) >>> 0);
}

function mat4Array(m: any): number[] {
    const a: number[] = [];
    for (let i = 0; i < 16; i++) a.push(m["m" + (i < 10 ? "0" + i : i)] ?? 0);
    return a;
}

/**
 * 归一化值类型为可与注册表默认值比较的形式。
 * 注册表默认:Color={_val}, Size={width,height}, Vec2={x,y}, Vec3={x,y,z} ...
 */
export function normalizeForDefault(v: any): unknown {
    if (!isValueType(v)) return v;
    switch (VALUE_TYPE_NAMES[v.__type__]) {
        case 4:
            return { _val: colorVal(v) };
        case 5:
            return { width: v.width, height: v.height };
        case 0:
            return { x: v.x, y: v.y };
        case 1:
            return { x: v.x, y: v.y, z: v.z };
        case 2:
        case 3:
            return { x: v.x, y: v.y, z: v.z, w: v.w };
        case 6:
            return { x: v.x, y: v.y, width: v.width, height: v.height };
        default:
            return v;
    }
}
