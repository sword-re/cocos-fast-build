/** 用于默认值裁剪的深比较(基础类型/数组/纯对象) */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    if (typeof a === "object" && typeof b === "object") {
        const ka = Object.keys(a as object);
        const kb = Object.keys(b as object);
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
            if (!deepEqual((a as any)[k], (b as any)[k])) return false;
        }
        return true;
    }
    return false;
}
