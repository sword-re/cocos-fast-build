# 类注册表(class registry)—— 序列化所需的类元数据

通用 CCClass 序列化路径需要每个类的**可序列化字段(有序)+ 默认值 + 类型 + editorOnly**。
这正是编辑器序列化器使用的真相数据,来自运行中的编辑器 `cc` 运行时,无法从加密的构建管线获取。

## 来源与采集方式

通过 cocos-mcp 桥在编辑器 **scene 上下文**执行 JS dump(`cc` 在 scene 上下文):

- 类列表:`cc.js._registeredClassNames`(name → ctor),本项目 1043 个,其中 **962 个**带 `__values__`。
- 字段顺序:`ctor.__values__`(CCClass 沿继承链 CCObject→Asset→子类计算出的有序可序列化字段)。
- 字段元数据:`cc.Class.attr(ctor, prop)` → `{ default, type, ctor, editorOnly }`。
- 自定义序列化判定:`ctor.prototype._serialize` 是否存在。全工程仅 **3 个**:
  `cc.Texture2D` / `cc.RenderTexture` / `cc.SpriteFrame`。其余全走通用路径。

产物落地于 `tools/fast-build/data/class-registry.json`,精简结构:

```jsonc
{
  "cc.AudioClip": {
    "v": [                               // __values__,有序
      {"k":"_name","d":""},
      {"k":"_objFlags","d":0},
      {"k":"_native","d":""},
      {"k":"duration","d":0},
      {"k":"loadMode","d":0,"t":"Enum"}
    ]
  },
  "cc.Texture2D": { "v":[...], "cs":1 }   // cs=1 表示自定义序列化
}
```

字段:`k`=属性名,`d`=默认值(缺省即无默认/计算属性),`eo`=editorOnly,
`ctor`=对象/资源类型(如 `cc_SpriteFrame`/`cc_Material`/`Object`),`t`=其它类型提示(`Enum`/`Vec3`/`Integer`...)。

## 重新生成

当**项目脚本(组件类)变动**或**引擎升级**时需要重新 dump(新增/改名的组件类会改变 `__values__`)。
步骤:在 Cocos 编辑器打开项目并连接 cocos-mcp 面板,在 scene 上下文执行 dump 脚本(见
`docs/fast-build/scripts/dump-class-registry.js`),把返回的 JSON 写入
`tools/fast-build/data/class-registry.json`。

> ⚠️ 增量构建若涉及"新组件类",必须保证注册表是最新的,否则通用序列化会因缺字段/字段顺序错位而产出错误产物。
> 后续可在构建器启动时校验注册表版本(如与 `temp/quick-scripts` 的 mtime 比对),过期则提示重 dump。

## 默认值裁剪 = 最大风险点(对照本表)

样本验证已确认:`_objFlags:0`、`_native:""`、`loadMode:0`、`_techniqueIndex:0`、`properties:null`
等于默认值的字段都被裁剪。裁剪规则:`deepEqual(值, 该字段默认值)` 为真则丢弃。
ValueType(Vec3/Color/Size...)的默认比较需归一化(留待 spike 2 的高级类型编码器)。
