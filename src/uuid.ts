/**
 * 压缩 UUID 编解码。
 * 规范来源:engine/cocos2d/core/utils/decode-uuid.js + misc.js(BASE64_KEYS)。
 * 详见 docs/fast-build/01-serialization-spec.md §3。
 *
 * 压缩串(22 字符)= 前 2 个 hex 字符原样 + 其后每 2 个 base64 字符编码 3 个 hex。
 */

const BASE64_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Array<number>(128).fill(0);
for (let i = 0; i < BASE64_KEYS.length; i++) BASE64_VALUES[BASE64_KEYS.charCodeAt(i)] = i;

const HEX = "0123456789abcdef";
const HEX_VAL: Record<string, number> = {};
for (let i = 0; i < HEX.length; i++) HEX_VAL[HEX[i]] = i;

/** 标准 uuid(带或不带连字符)→ 22 字符压缩串 */
export function compressUuid(uuid: string): string {
    const hex = uuid.replace(/-/g, "");
    if (hex.length !== 32) return uuid; // 非标准 uuid 原样返回(与引擎一致)
    let out = hex[0] + hex[1];
    for (let i = 2; i < 32; i += 3) {
        const x = HEX_VAL[hex[i]];
        const y = HEX_VAL[hex[i + 1]];
        const z = HEX_VAL[hex[i + 2]];
        const lhs = (x << 2) | (y >> 2);
        const rhs = ((y & 3) << 4) | z;
        out += BASE64_KEYS[lhs] + BASE64_KEYS[rhs];
    }
    return out;
}

/**
 * cc._RF.push 专用的脚本 UUID 压缩(与资源引用的 compressUuid 不同!)。
 * 规则:前 **5** 个 hex 原样 + 其后每 3 个 hex 编码为 2 个 base64(剩余 27 hex → 18 字符),共 23 字符。
 * 已对 quick-scripts 的 cc._RF 值逐字节验证。
 * (对比:compressUuid 是前 2 个 hex 原样 + 其后每 3→2,共 22 字符,用于资源引用。)
 */
export function compressUuidRF(uuid: string): string {
    const hex = uuid.replace(/-/g, "");
    if (hex.length !== 32) return uuid;
    let out = hex.slice(0, 5);
    for (let i = 5; i < 32; i += 3) {
        const x = HEX_VAL[hex[i]];
        const y = HEX_VAL[hex[i + 1]];
        const z = HEX_VAL[hex[i + 2]];
        const lhs = (x << 2) | (y >> 2);
        const rhs = ((y & 3) << 4) | z;
        out += BASE64_KEYS[lhs] + BASE64_KEYS[rhs];
    }
    return out;
}

/** 22 字符压缩串 → 标准 uuid(带连字符)。引擎 decode-uuid.js 的等价实现 */
export function decompressUuid(base64: string): string {
    if (base64.length !== 22) return base64;
    const t = ["", "", "", ""];
    const template = t.concat(t, "-", t, "-", t, "-", t, "-", t, t, t);
    const indices = template.map((x, i) => (x === "-" ? NaN : i)).filter((n) => isFinite(n)) as number[];
    template[0] = base64[0];
    template[1] = base64[1];
    let j = 2;
    for (let i = 2; i < 22; i += 2) {
        const lhs = BASE64_VALUES[base64.charCodeAt(i)];
        const rhs = BASE64_VALUES[base64.charCodeAt(i + 1)];
        template[indices[j++]] = HEX[lhs >> 2];
        template[indices[j++]] = HEX[((lhs & 3) << 2) | (rhs >> 4)];
        template[indices[j++]] = HEX[rhs & 0xf];
    }
    return template.join("");
}
