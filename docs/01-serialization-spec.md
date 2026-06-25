# 自研 Cocos Creator 2.4.13 构建管线 —— 产物格式与序列化规范

> 目标:自研一套构建器替换 cocos 自带构建,核心收益来自 **增量 + 并行 + 免编辑器冷启动**。
> 本文是「方案 D」的第一份规范文档,后续 spike/实现以此为准。
>
> 规范来源:开源运行时引擎 `.../Resources/engine`(= `cocos-creator-js` 2.4.13),其反序列化器即产物格式的唯一真相来源。
> 关键文件:`cocos2d/core/platform/deserialize-compiled.ts`(1099 行,本文大量引用其行号)、`cocos2d/core/utils/decode-uuid.js`。

---

## 0. 为什么是「增量 + 并行」而不是「单次更快」

实测自带构建 ~65s,分布:编辑器冷启动+引擎初始化 ~10s、**编译脚本 ~22s**、**资源序列化 ~27s**、收尾 ~6s。

自研构建器**单次**不一定比 cocos 快(它内部也用缓存),真正的提速来自:

1. **增量**:复用 `library/imports`(已序列化的中间产物,5430 个 json)和 `temp/quick-scripts`(已编译 JS),只重算变更项。
2. **并行**:全核 `worker_threads` 处理资源转换 / 打包,cocos 的 worker 并行度有限。
3. **免冷启动**:不拉起 Electron 编辑器,省 ~10s。

热重建(改几个脚本/资源)从 65s 压到个位数秒级是现实目标。

---

## 1. 构建产物解剖(build/wechatgame)

```
build/wechatgame/
├── game.js / main.js / ccRequire.js   # 启动样板(静态模板 + 少量注入)
├── game.json / project.config.json    # 微信小游戏配置
├── adapter-min.js                     # 小游戏适配层(引擎自带,固定)
├── hook.js                            # 本地预览注入(remoteBundleUrlDev 等)
├── cocos/                             # 引擎 js(按 excluded-modules 裁剪后的 cocos2d-js)
├── src/settings.js                    # 全局 settings(启动场景、bundle 列表、md5map 等)
├── assets/<bundle>/                   # 内置 bundle:main / resources / internal
└── subpackages/<bundle>/              # 分包 bundle:Home / Game / VoiceRoom ...
    ├── config.<md5>.json              # bundle 清单(见 §4)
    ├── index.js | game.js             # 该 bundle 的脚本包(browserify bundle,见 §5)
    ├── import/<2hex>/<uuid>.<md5>.json # 序列化资源(场景/预制体/spriteframe/atlas...,见 §2)
    └── native/<2hex>/<uuid>.<md5>.<ext># 原始资源(png/mp3/plist...,基本是 library 里拷贝+md5)
```

一个 bundle = **清单(config) + 脚本包 + 序列化资源(import) + 原始资源(native)**。
`native/` 几乎是 `library` 里对应文件的拷贝 + md5 改名(廉价)。
`import/` 是难点核心:从 `library/imports` 的 verbose 格式**编译**成下面 §2 的压缩数组格式。

---

## 2. 压缩 JSON 序列化格式(核心规范)

运行时用 `deserialize-compiled.ts` 反序列化;我们要写的序列化器是它的**逆**。format version = `1`(`SUPPORT_MIN_FORMAT_VERSION`)。

### 2.1 顶层文件结构 `IFileData`(`File` 枚举,L407–457)

一个 import json 是一个数组,下标语义固定:

| 下标 | `File` 名 | 含义 |
|------|-----------|------|
| 0 | `Version` | 版本号(数字 1);也可是 `FileInfo` 对象(packed 时) |
| 1 | `SharedUuids` | 依赖资源的(压缩)uuid 字符串表;无则 `0`(EMPTY_PLACEHOLDER) |
| 2 | `SharedStrings` | 共享字符串表(属性名等);无则 `0` |
| 3 | `SharedClasses` | 类表:`IClass` 或类名字符串 |
| 4 | `SharedMasks` | 对象布局掩码表 `IMask[]`;无则 `0` |
| 5 | `Instances` | 一维对象数据数组,布局 `[...IClassObjectData[], ...OtherObjectData[], RootInfo?]` |
| 6 | `InstanceTypes` | 与 Instances 尾部对应的类型 id 表;无则 `0` |
| 7 | `Refs` | 对象间交叉引用表 `IRefs`;无则 `0` |
| 8 | `DependObjs` | 需按 uuid 加载资源的宿主对象(instance 下标 或 对象) |
| 9 | `DependKeys` | 对应的属性名(string 下标 或 `~数字`) |
| 10 | `DependUuidIndices` | 对应依赖资源的 uuid(SharedUuids 下标 或 string) |

> 解析入口 `deserialize()` L917;`parseInstances()` L747;`parseResult()`(回填 depend)L877;`dereference()`(回填 Refs)L559。

### 2.2 RootInfo 编码(L751–761)

`Instances` 末元素若为 `number` 即 `RootInfo`:
- `>= 0`:根对象下标 = 该值,且**无 native 依赖**;
- `< 0`:根对象下标 = `~值`,且**有 native 依赖**(如带贴图的资源)。
- 若末元素不是 number,则根对象 = `Instances[0]` 且无 native dep。
- `hasNativeDep()` L1008 据此判断;config 的 `versions.native` 也据此。

### 2.3 类 / 掩码 / 对象数据

**IClass**(L299–309):`[类名|Ctor, [属性名...], propTypeOffset, ...AdvancedTypeID[]]`
- `CLASS_KEYS` 为属性名数组;前若干个是 SimpleType,后面是 Advanced。
- 解析时属性 `keys[x]` 的类型 = `IClass[x + propTypeOffset]`(仅 Advanced 有)。
- 序列化时 `propTypeOffset = CLASS_PROP_TYPE_OFFSET(2) + 1 - SimpleType 个数`。

**IMask**(L316–323):`[classIndex, ...属性在IClass中的下标, OFFSET]`
- 同一个类的不同实例可能因「默认值被裁剪」而有不同 Mask。
- 末元素是 OFFSET:OFFSET 之前的属性是 SimpleType,之后是 Advanced。

**IClassObjectData**(L326–331):`[maskIndex, ...各属性值]`(从下标 1 起,顺序对应 Mask)。
解析见 `deserializeCCObject()` L593:先按 mask 顺序赋 simple,再按 type 调 `ASSIGNMENTS[type]`。

### 2.4 属性类型 `DataTypeID`(L184–242)及其解析函数(`ASSIGNMENTS` L729–743)

| ID | 名称 | 解析函数 | 数据形态 |
|----|------|----------|----------|
| 0 | SimpleType | `assignSimple` | 任意纯 JSON(含 null);唯一允许 null 的类型 |
| 1 | InstanceRef | `assignInstanceRef` | `>=0`→`Instances[v]`;`<0`→登记到 Refs(`~v`) |
| 2 | Array_InstanceRef | 数组版 1 | InstanceRef 数组 |
| 3 | Array_AssetRefByInnerObj | 数组版 7 | |
| 4 | Class | `parseClass` | 内嵌 `IClassObjectData` |
| 5 | ValueTypeCreated | `parseValueTypeCreated` | `IValueTypeData`,写入已存在对象 |
| 6 | AssetRefByInnerObj | `parseAssetRefByInnerObj` | 数字=DependObjs 下标;置 null 并登记依赖 |
| 7 | TRS | `parseTRS` | `[10 个 number]`,写 Node 的 TypedArray |
| 8 | ValueType | `parseValueType` | `IValueTypeData`,新建 ValueType |
| 9 | Array_Class | 数组版 4 | Class 数组 |
| 10 | CustomizedClass | `parseCustomClass` | `[classIndex, content]`,走 `_deserialize` |
| 11 | Dict | `parseDict` | `[jsonLayout, key,type,val, key,type,val ...]` |
| 12 | Array | `parseArray` | `[[值...], ...各元素type]` |

**ValueType 编码**(`IValueTypeData` L345,`BuiltinValueTypes` L48):`[typeId, ...分量]`
typeId: 0=Vec2 1=Vec3 2=Vec4 3=Quat 4=Color(`[4,_val]`) 5=Size 6=Rect 7=Mat4。
引擎甚至导出了 `serializeBuiltinValueTypes()`(L97)可直接参考。

### 2.5 Refs 交叉引用(L386–404, `dereference` L559)

`IRefs = [owner, keyIndex, target, owner, keyIndex, target, ..., OFFSET]`,每条 3 元素(`EACH_RECORD_LENGTH=3`)。
- 前 `OFFSET*3` 条的 owner 是对象,之后的 owner 是 instance 下标。
- `keyIndex >= 0`→`SharedStrings[keyIndex]`;`< 0`→`~keyIndex`(数组下标)。
- 用于循环引用 / 同一对象被多处引用的场景。

### 2.6 依赖资源回填(`parseResult` L877)

`DependObjs[i]` / `DependKeys[i]` / `DependUuidIndices[i]` 三表平行:
把 `宿主对象[属性] = 按 uuid 加载的资源`。三表元素若是 number 则分别解读为 instance 下标 / string 表下标(或 `~数字`)/ SharedUuids 下标。

### 2.7 两种打包模式

**A. 简单/自定义单对象**(SpriteFrame、Texture2D、AudioClip 等,走 `_serialize`/`_deserialize`)
直接用 `packCustomObjData()`(L997)模板:
```js
[1, EMPTY, EMPTY, [type], EMPTY, (hasNativeDep ? [data, ~0] : [data]), [0], EMPTY, [], [], []]
```
实测 SpriteFrame 样本(含贴图依赖):
```json
[1, ["195545df5"], ["_textureSetter"], ["cc.SpriteFrame"], 0,
 [{"name":"lv5_lock","rect":[663,69,293,60],"offset":[0.5,0],
   "originalSize":[296,60],"capInsets":[0,0,0,0]}],
 [0], 0, [0], [0], [0]]
```
解读:SharedUuids=贴图压缩uuid;SharedStrings=`_textureSetter`(setter 属性名);Class=`cc.SpriteFrame`;Instances=`_serialize` 产出的 content;InstanceTypes=`[0]`(指向 custom class 0);DependObjs=`[0]`(instance 0)、DependKeys=`[0]`(→`_textureSetter`)、DependUuidIndices=`[0]`(→贴图)。
> ⚠️ `rect` 在图集场景被改写为**图集内坐标**(library 原值 `[2,0,..]` → 产物 `[663,69,..]`)。说明序列化与图集打包耦合,见 §7。**spike 选非图集 spriteframe 做字节对齐。**

**B. 完整对象图**(Prefab / Scene:多节点、多组件、交叉引用)
同样的 `IFileData` 结构,但 `Instances` 含多个 `IClassObjectData`,大量 `InstanceRef`/`Refs`,SharedClasses/Masks 非空。这是 spike 2 的攻坚目标。

### 2.8 packed(合并)文件 `unpackJSONs`(L977)

多个小 import json 可合并进一个 pack 文件以减请求数:共享 `SharedUuids/Strings/Classes/Masks`,`Instances` 段变成 `IFileData[]` 数组。运行时 `unshift` 共享头还原。对应 config 的 `packs` 字段(§4)。

---

## 3. 压缩 UUID 算法(`decode-uuid.js`)

22 字符压缩串 → 标准 uuid:**前 2 字符原样**,其后每 2 个 base64 字符解码出 3 个 hex(共 20 字符 → 30 hex)。
```
hex[0..1] = base64[0..1]
for i in 2,4,...,20:
  lhs=B64[ base64[i] ]; rhs=B64[ base64[i+1] ]
  out += hex(lhs>>2), hex(((lhs&3)<<2)|(rhs>>4)), hex(rhs&0xF)
```
`B64` = `misc.BASE64_VALUES`。**序列化器需实现其逆(encode),并对样本验证可逆。**
config 的 `uuids`、`packs` 键、`SharedUuids` 全用压缩形式。

---

## 4. config.<md5>.json(bundle 清单)

```jsonc
{
  "uuids":   ["压缩uuid", ...],          // 资源索引表;下面所有 index 都指这里
  "paths":   { "0": ["相对路径(无扩展)", typeIndex], ... }, // 仅可寻址资源(如 resources)
  "types":   ["cc.Prefab","cc.SpriteFrame","cc.Texture2D", ...], // paths[*][1] 索引这里
  "scenes":  { "db://assets/Startup.fire": 0 },   // 场景路径 → uuids 下标
  "packs":   { "packUuid": [资源index, ...] },     // 合并文件 → 其包含的资源
  "redirect":[index, depBundleIndex, ...],         // 该资源实际在 deps[depBundleIndex] 里
  "deps":    ["resources","internal"],             // 依赖的其它 bundle 名
  "name":"main", "importBase":"import", "nativeBase":"native",
  "debug":false, "isZip":false, "encrypted":false,
  "versions":{ "import":[index,"md5", ...], "native":[index,"md5", ...] } // md5 即文件名里的 hash
}
```
- `versions.import/native` 是 `[资源index, md5]` 交替的扁平数组;md5 即 `import/native` 文件名中的 hash 段。
- 生成依据:bundle 成员资源 + 各资源依赖关系(决定 `deps`/`redirect`)+ meta 中的可寻址路径(决定 `paths`)。
- 运行时格式定义见引擎 `cocos2d/core/asset-manager/config.js`(后续实现时通读)。

---

## 5. 脚本包(index.js / game.js)

标准 **browserify CommonJS bundle**:
```js
window.__require = function e(t,i,o){ ... }({
  1:[function(e,t,i){ /* 模块体 */ }, { "依赖名": 模块id }],
  2:[...],
}, {}, [入口id...]);
```
- 模块体 = 各 TS 文件编译出的 JS(可直接复用 `temp/quick-scripts` 的产物,**免重编译**)。
- 组件类通过 `cc._RF.push/pop`(require framework)注册,产物里已包含,按原样保留即可。
- 我们要做的:按 bundle 收集其脚本模块 → browserify 风格拼接 → 注入 `__require`。
- 压缩交给 §8 的 minifier(已并行化的 terser,或换 esbuild)。

---

## 6. 可复用的输入数据(避免重算)

| 来源 | 内容 | 复用方式 |
|------|------|----------|
| `library/imports/<2hex>/<uuid>.json` | verbose `{__type__,content}` 序列化资源 | 转换成 §2 压缩格式的**输入** |
| `library/uuid-to-mtime.json` | uuid→mtime | 增量判定:mtime 没变就跳过 |
| `temp/quick-scripts/` | 已编译 JS | 脚本包直接用,免 tsc |
| `temp/TexturePacker/` | 已打包图集缓存 | 图集未变则复用,免重打包 |
| `assets/**/*.meta` | uuid、可寻址路径、图集归属、压缩配置 | 生成 config 的 paths/types/packs |
| `settings/*.json` | bundle 划分、启动场景、平台配置 | 生成 settings.js / config 的 deps |

增量核心:对 (源资源 mtime/hash) vs (上次构建记录) 做 diff,只重建受影响的资源及其所在 bundle 的 config。

---

## 7. 自动图集(Auto Atlas / .pac)

- `.pac` 定义一组贴图打进一张大图;打包后**每个 spriteframe 的 rect 被改写为图集内坐标**(见 §2.7 警告)。
- 自带构建用 maxrects(加密的 `texture-packer/algorithm/maxrects.ccc`)。
- 策略二选一:
  1. **复用缓存**:`temp/TexturePacker` 有现成结果,图集源未变则直接拷贝 + 沿用其 rect 映射(优先,省事且快)。
  2. **自实现 maxrects**:公开算法,但要和 cocos 的 bleeding/padding/排序完全一致才能字节对齐,成本高。
- 建议:**先只支持「复用缓存」**,图集源变更时回退到调用 cocos 重打包该图集,其余增量自研。

---

## 8. 技术栈评估:TypeScript/Node vs C++

构建器的工作画像:**读 ~5430 个 JSON → 格式转换 → 写**、JS 打包(browserify)、图集图像处理、md5、生成 config。瓶颈在 **I/O + JSON 解析/序列化**,CPU 重活只有图集图像处理。

**推荐:TypeScript + Node + `worker_threads`,而非 C++。** 理由:
1. **可复用引擎自身的 `deserialize-compiled.ts` 做正确性校验** —— 序列化产物喂回引擎反序列化器,断言等价。这是 C++ 拿不到的最大杠杆(对齐 JS 的数字格式化、key 顺序等微妙语义,C++ 复刻成本极高且易错)。
2. **生态**:browserify / 图像库 `sharp`(libvips,原生速度)/ minifier 全是现成 npm。
3. **瓶颈不在裸 CPU**:增量后单次只处理少量资源,I/O 主导;`worker_threads` 已能吃满多核。C++ 的吞吐优势对「秒级、增量、I/O 密集」的工具是边际收益,却换来数倍开发成本和无法复用 JS 校验。
4. **何时才上 native**:仅当某个**已证实**的热点(如全量图集打包)成为瓶颈,再用 N-API/Rust 写**单点**原生模块,而不是整条管线。

**附带优化(与 C++ 无关)**:第二部分压缩可把 `terser` 换成 **esbuild/swc** 的 minify,原生实现,通常快 10–100×;若产物可接受,比并行 terser 更狠。

> 结论:C++ 不划算。TS/Node + worker_threads(+ 必要时单点 native 模块)是正解。

---

## 9. Spike 计划(逐级 de-risk,验收=字节级 diff 对齐)

| Spike | 目标 | 验收 |
|-------|------|------|
| **1. 叶子资源序列化** | 取一个**非图集** spriteframe / texture,写序列化器产出 §2.7-A 格式 | 与真实 `import` json **字节级一致**(忽略文件名 md5) |
| **2. 完整预制体** | 一个含嵌套节点/组件/交叉引用的 prefab | 字节级一致;过不了则**重评 D**(生死判定) |
| **3. 端到端最小 bundle** | 复刻一个最小 bundle(config+脚本+import+native) | 在微信小游戏真机加载成功、无报错 |
| 4+ | 增量调度、图集复用、config 生成、并行、全量 bundle | 全量产物与 cocos 等价、能跑通预览 |

字节对齐的校验脚本:`node 序列化器 <uuid>` → 与 `build/wechatgame/**/<uuid>.*.json` 做 `diff`;同时喂回引擎 `deserialize` 断言对象等价(双保险)。

---

## 10. 风险与未决问题

1. **序列化器与编辑器的隐藏约定**:key 顺序、默认值裁剪(Mask 怎么决定哪些属性被省)、数字精度/取整。需用大量真实样本回归。← 最大风险
2. **图集耦合**:rect 改写依赖打包结果;先走「复用缓存」规避。
3. **Mask 去重逻辑**:同类不同实例的属性裁剪规则需逆向(对照多个同类对象样本)。
4. **SharedClasses/Strings/Uuids 的排序与去重规则**:影响下标,必须和编辑器一致才能字节对齐(若只求「语义等价」可放宽,但用户要求字节级)。
5. **custom `_serialize` 资源清单**:哪些类型走 packCustomObjData(自定义)、哪些走通用对象图,需枚举(SpriteFrame/Texture2D/AudioClip/TTF... 通常自定义)。
6. **settings.js / game.json 的全部字段**:需逐字段对照生成。

---

## 附:关键源码位置(本机)

- 反序列化器(格式真相):`.../engine/cocos2d/core/platform/deserialize-compiled.ts`
- 压缩 uuid:`.../engine/cocos2d/core/utils/decode-uuid.js`
- bundle 运行时配置:`.../engine/cocos2d/core/asset-manager/config.js`(待通读)
- 现成产物样本:`<project>/build/wechatgame/`
- 中间缓存:`<project>/library/imports`、`<project>/temp/quick-scripts`、`<project>/temp/TexturePacker`
