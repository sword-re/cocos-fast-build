/**
 * 类注册表:每个类的可序列化字段(__values__,有序)、默认值、类型、editorOnly、是否自定义序列化。
 * 数据来自运行中的编辑器 dump(见 docs/fast-build/02-class-registry.md),
 * 是编辑器序列化器使用的真相数据。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PropMeta {
    /** 属性名 */
    k: string;
    /** 默认值(用于裁剪);缺省表示无默认值 */
    d?: unknown;
    /** editorOnly:序列化时丢弃 */
    eo?: 1;
    /** 资源/对象类型(如 cc_SpriteFrame / cc_Material / Object) */
    ctor?: string;
    /** 其它类型提示(Enum / Vec3 / Integer / Float / ...) */
    t?: string;
}

export interface ClassMeta {
    /** 有序可序列化字段 */
    v: PropMeta[];
    /** 自定义序列化(prototype._serialize 存在):cc.SpriteFrame / cc.Texture2D / cc.RenderTexture */
    cs?: 1;
}

const REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../data/class-registry.json");

let _registry: Record<string, ClassMeta> | null = null;

export function registry(): Record<string, ClassMeta> {
    if (!_registry) {
        _registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Record<string, ClassMeta>;
    }
    return _registry;
}

export function getClassMeta(type: string): ClassMeta | undefined {
    return registry()[type];
}

export interface AugmentStats {
    newEntries: number; // 新建的类条目数
    augmentedEntries: number; // 被补字段的已有条目数
    addedProps: number; // 累计补入的字段数
}

/**
 * 用项目脚本实测出的类元数据 overlay 增补内存中的注册表(只增不删):
 *  - 已有条目:补齐 overlay 里缺失的字段(按属性名;已有字段及其默认值原样保留)
 *  - 全新「组件」类:整条新建(数据类不新建——基类前缀难可靠推断,保守跳过)
 * 解决静态 dump 陈旧导致新增 @property 被序列化器跳过的问题(详见 scripts/classMeta.ts)。
 */
export function augmentRegistry(overlay: Record<string, ClassMeta & { __comp?: boolean }>): AugmentStats {
    const reg = registry();
    const stats: AugmentStats = { newEntries: 0, augmentedEntries: 0, addedProps: 0 };
    for (const [key, entry] of Object.entries(overlay)) {
        const existing = reg[key];
        if (!existing) {
            // 组件类与数据类都新建:数据类(如 @ccclass 的 inspector 辅助类)若被 prefab 序列化引用
            // 而不在注册表,序列化器会抛 "类不在注册表" → 整个资源被跳过 → 运行时 bundle 缺该资源。
            reg[key] = { v: entry.v.map((p) => ({ ...p })) };
            stats.newEntries++;
            continue;
        }
        const have = new Set(existing.v.map((p) => p.k));
        let added = 0;
        for (const p of entry.v) {
            if (have.has(p.k)) continue;
            existing.v.push({ ...p });
            have.add(p.k);
            added++;
        }
        if (added > 0) {
            stats.augmentedEntries++;
            stats.addedProps += added;
        }
    }
    return stats;
}

export function isCustomSerialize(type: string): boolean {
    return getClassMeta(type)?.cs === 1;
}
