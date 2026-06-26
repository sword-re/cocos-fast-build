/**
 * effect 编译用枚举(取自引擎 renderer/build/mappings/offline-mappings.ts + gfx/define.ts + gfx/enums.js)。
 */

/** GLSL 类型名 → GFXType 数值(gfx/define.ts 的 GFXType 枚举,0 基) */
export const TYPE_MAP: Record<string, number> = {
    bool: 1, // BOOL
    int: 5, // INT
    ivec2: 6, // INT2
    ivec3: 7, // INT3
    ivec4: 8, // INT4
    float: 13, // FLOAT
    vec2: 14, // FLOAT2
    vec3: 15, // FLOAT3
    vec4: 16, // FLOAT4
    mat2: 18, // MAT2
    mat3: 22, // MAT3
    mat4: 26, // MAT4
    sampler2D: 29, // SAMPLER2D
    samplerCube: 32, // SAMPLER_CUBE
};

/** 每类型分量数(标量 value 包数组时用;sampler 不入 value 数组) */
export const TYPE_COMPONENTS: Record<number, number> = {
    1: 1, // bool
    5: 1, // int
    6: 2,
    7: 3,
    8: 4,
    13: 1, // float
    14: 2,
    15: 3,
    16: 4,
    18: 4,
    22: 9,
    26: 16,
};

/**
 * pass 状态枚举字符串(大写)→ 数值(offline-mappings.passParams + gfx/enums.js)。
 * YAML 里小写值查表时先 toUpperCase。
 */
export const PASS_PARAMS: Record<string, number> = {
    // cull mode
    NONE: 0, // CULL_NONE
    FRONT: 1028, // CULL_FRONT
    BACK: 1029, // CULL_BACK
    // blend op
    ADD: 32774, // BLEND_FUNC_ADD
    SUB: 32778, // BLEND_FUNC_SUBTRACT
    REV_SUB: 32779, // BLEND_FUNC_REVERSE_SUBTRACT
    // blend factor
    ZERO: 0,
    ONE: 1,
    SRC_COLOR: 768,
    ONE_MINUS_SRC_COLOR: 769,
    DST_COLOR: 774,
    ONE_MINUS_DST_COLOR: 775,
    SRC_ALPHA: 770,
    ONE_MINUS_SRC_ALPHA: 771,
    DST_ALPHA: 772,
    ONE_MINUS_DST_ALPHA: 773,
    CONSTANT_COLOR: 32769,
    ONE_MINUS_CONSTANT_COLOR: 32770,
    CONSTANT_ALPHA: 32771,
    ONE_MINUS_CONSTANT_ALPHA: 32772,
    SRC_ALPHA_SATURATE: 776,
    // compare func
    NEVER: 512,
    LESS: 513,
    EQUAL: 514,
    LEQUAL: 515,
    GREATER: 516,
    NOTEQUAL: 517,
    GEQUAL: 518,
    ALWAYS: 519,
    // stencil op
    KEEP: 7680,
    REPLACE: 7681,
    INCR: 7682,
    DECR: 7683,
    INVERT: 5386,
    INCR_WRAP: 34055,
    DECR_WRAP: 34056,
};
