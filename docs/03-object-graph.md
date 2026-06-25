# 对象图(prefab / scene)序列化 —— spike 2

## 结论:方案 D 对对象图证实可行(188/188 语义一致)

对全部 **188 个有 library 源的对象图**做序列化 + 引擎反序列化深比较(排除运行时随机 `_id`):

| 指标 | 数 |
|------|----|
| 序列化成功(无报错) | 188 / 188 |
| 反序列化后**语义完全一致** | **188 / 188** ✅ |
| 反序列化崩溃 | 0 |

> 判据是**语义等价**(产物经引擎 `cc._deserializeCompiled` 反序列化后,节点树/组件/值类型/资源依赖与真实产物一致),而非字节对齐——字节对齐需复刻编辑器内部的 Refs/Class/String 排序启发式(顺序相关,不影响运行时正确性),作为后续优化项。
> 校验工具:Node 侧 `npm run spike2:batch` 生成产物到 `.out/`;编辑器桥(scene 上下文)用 `cc._deserializeCompiled` 反序列化双方并深比较。

## 已实现的编码机制

- **实例提升**:被引用 ≥2 次的对象 + 根 → 顶层 Instance;单引用对象内联。
- **引用**:实例↔实例 → Refs 表(instance-owner,属性移出 keys);内联→实例 → 负数 InstanceRef(object-owner Refs)。正确性优先,统一延迟(不区分前/后向)。
- **资源引用**:顶层实例属性 → 移出 + DependObjs(instanceIdx);内联对象/数组元素 → AssetRefByInnerObj。
- **高级类型**:Class、Array_Class、Array_InstanceRef、Array_AssetRefByInnerObj、通用 Array(逐元素带类型)、ValueTypeCreated、TRS、InstanceRef。
- **默认值裁剪** + ValueType 归一化(Color→`_val`,Size/Vec 按数值分量,缺失分量按 0)。

## 关键发现

1. **压缩格式必须用 `cc._deserializeCompiled` 反序列化**;编辑器 scene 上下文的 `cc.deserialize` 是 editor 格式,喂压缩格式返回空对象。
2. **脚本组件按 class-id(压缩 uuid)序列化**,引擎类按类名。注册表需同时按 name 和 class-id 索引(见 [02-class-registry.md](02-class-registry.md))。
3. `_id` 是 CCObject 每次反序列化随机生成的运行时 id,**不参与语义比较**。
4. **自定义序列化类全工程仅 3 个**(Texture2D/RenderTexture/SpriteFrame)。

## 收尾时补全的 4 条编码规则(已全部解决,125→188)

1. **数组 SimpleType 路由 bug**:`encodeArray` 对纯简单数组返回内部标记 `-1`,却被塞进 advanced,导致非法 type id `-1`、反序列化崩溃。修复:`-1` 归入 simple。
2. **嵌套预制体 PrefabInfo.asset**:asset 指向外部子预制体(`{__uuid__}`)时——`sync=false`(普通嵌套,已 baked)→ 编辑器置 null,不作依赖;`sync=true`(同步实例,运行时需实例化)→ 保留为资源依赖。
3. **ValueType vs ValueTypeCreated**:属性默认值是 valuetype 形状(构造函数预创建实例)→ `ValueTypeCreated(5)`;默认 null/无(未预创建)→ `ValueType(8)`。否则写入 null 实例会崩(“Cannot set property 'width' of null”)。
4. **悬空资源引用**:指向已删除资源(library 中不存在)的引用,编辑器构建会丢弃 → 用 `assetExists()`(扫 library/imports)跳过。

> 注:`_materials`(资源引用数组,Array_AssetRefByInnerObj)和 `clickEvents`(`cc.ClickEvent` 内联 → Array_Class)在补全前后均正确,非缺口。

均为有界的编码规则,无架构级障碍。后续若新增组件类/资源类型,可能需补对应规则。

## 后续(字节对齐 / 完整构建)

- 若追求字节对齐:需复刻编辑器的 Instances/SharedClasses/SharedStrings/Refs 排序与正/负 InstanceRef(前后向)选择。
- 语义等价已足以驱动一个**可运行的构建器**(md5 会不同,但运行时加载等价)。下一步可推进 spike 3:端到端最小 bundle 真机加载。
