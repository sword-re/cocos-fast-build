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
        _registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    }
    return _registry;
}

export function getClassMeta(type: string): ClassMeta | undefined {
    return registry()[type];
}

export function isCustomSerialize(type: string): boolean {
    return getClassMeta(type)?.cs === 1;
}
