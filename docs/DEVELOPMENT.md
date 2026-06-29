# cocos-fast-build 开发文档（总）

> 脱离 Cocos Creator 编辑器的 **Cocos 2.x 小游戏快速构建管线**。本文是对 `docs/00`~`docs/08`
> 各专题文档的总纲：先讲清 **cocos 打包后的内部数据模型**，再 **列出各模块**，最后 **逐模块讲工作流程与原理**。
> 想直接上手用工具，请看 [USAGE.md](USAGE.md)；想深挖某一专题，文中会指向对应的 `0x-*.md`。

---

## 0. 一页纸总览

工具做的事，一句话：**直接读项目的 `assets/ + .meta + library/imports`，复刻编辑器构建器的资源装配、脚本打包、图集打包、game 模板生成，再用 swc 压缩**——产出与官方 `build/<platform>` 同构、可在小游戏真机加载的目录。它**只替代官方构建里最慢的那段**（资源序列化 + 脚本编译 + 压缩），引擎/适配层（`adapter-min.js` / `cocos/`）由 `--engine-pack` 指向一份现成官方 build 复用。

```
                        cocos-fast-build 数据流
┌─────────────────────────── 输入（项目中间产物）────────────────────────────┐
│  assets/**/*.meta        library/imports/<uuid>.json     assets/**/*.ts      │
│  (uuid/路径/图集归属)     (verbose 序列化资源)            (项目脚本源)         │
│  settings/*.json         .pac (auto-atlas 定义)          data/class-registry │
└───────┬──────────────────────┬──────────────────────┬──────────────┬────────┘
        │                       │                       │              │
   ┌────▼─────┐          ┌──────▼──────┐         ┌──────▼─────┐  ┌─────▼──────┐
   │ metaScan │          │ libraryIndex│         │  scripts/  │  │  registry  │
   │ 一趟扫盘  │          │ import 中间层│         │ 自编译+打包 │  │ 类元数据    │
   └────┬─────┘          └──────┬──────┘         └──────┬─────┘  └─────┬──────┘
        │   ┌───────────┐       │   ┌────────────┐      │              │
        └──▶│ atlasPack │       └──▶│ serialize/ │◀─────┼──────────────┘
            │ 图集打包   │           │ 压缩格式序列化│     │
            └─────┬─────┘           └──────┬─────┘      │
                  │                        │            │
            ┌─────▼────────────────────────▼────────────▼─────┐
            │  crawl  →  assemble  →  game  →  minify          │
            │ 归属爬取  bundle装配  样板生成   swc压缩          │
            └──────────────────────┬──────────────────────────┘
                                   ▼
                    build/fast-<platform>/  （可加载产物）
```

编排顺序（[orchestrate.ts](../src/orchestrate.ts) → [build.ts](../src/build.ts)）：
**图集打包 → 清理输出 → crawl 爬依赖图 → 刷新脚本类注册表 → 装配各 bundle 资源 → 打包脚本 → 生成 game 样板 → 拷贝引擎/plugin → swc 压缩 →（可选）上传 remote**。

---

## 1. cocos 打包后的内部数据模型

这是整个工具的「逆向真相」。要复刻产物，先得读懂产物。真相来源是开源运行时引擎的反序列化器
`cocos2d/core/platform/deserialize-compiled.ts`——**我们的序列化器就是它的逆**。详见
[01-serialization-spec.md](01-serialization-spec.md)。

### 1.1 产物目录解剖（`build/<platform>/`）

```
build/wechatgame/
├── game.js / main.js / ccRequire.js     启动样板（静态模板 + 少量注入）
├── game.json / project.config.json      小游戏平台配置
├── adapter-min.js                       适配层（引擎自带，--engine-pack 拷贝）
├── hook.js                              本地预览注入（remoteBundleUrlDev 等）
├── cocos/                               引擎 js（裁剪后的 cocos2d-js，拷贝）
├── src/
│   ├── settings.js                      全局 settings（启动场景/bundle列表/md5map…）
│   └── assets/                          plugin 脚本（拷贝 + 从源覆盖）
├── assets/<bundle>/                     内置 bundle：main / resources / internal
└── subpackages/<bundle>/                微信分包 bundle：Home / VoiceRoom / …
    ├── config.<md5>.json                bundle 清单（§1.4）
    ├── index.js | game.js               该 bundle 脚本包（browserify，§1.5）
    ├── import/<2hex>/<uuid>.<md5>.json  序列化资源（§1.2）
    └── native/<2hex>/<uuid>.<md5>.<ext> 原始资源（png/mp3/plist…）
```

**一个 bundle = 清单(config) + 脚本包 + 序列化资源(import) + 原始资源(native)。** 三种物理布局：
内置 bundle → `assets/<b>`，微信分包 → `subpackages/<b>`，远程包 → `remote/<b>`。

### 1.2 压缩 JSON 序列化格式（核心）

每个 `import/*.json` 是一个 **下标语义固定的数组** `IFileData`（运行时按下标取）：

```
IFileData = [
  0 Version            版本号(1) 或 FileInfo 对象(packed)
  1 SharedUuids        依赖资源的压缩 uuid 表        | 无→0
  2 SharedStrings      共享字符串表(属性名等)        | 无→0
  3 SharedClasses      类表：IClass 或类名字符串
  4 SharedMasks        对象布局掩码表 IMask[]        | 无→0
  5 Instances          一维对象数据数组 + 末尾 RootInfo
  6 InstanceTypes      与 Instances 尾部对应的类型 id | 无→0
  7 Refs               对象间交叉引用表              | 无→0
  8 DependObjs         需按 uuid 加载资源的宿主对象
  9 DependKeys         对应属性名
  10 DependUuidIndices 对应依赖资源的 uuid
]
```

属性值按 `DataTypeID` 编码（13 种）：SimpleType(0,纯JSON)、InstanceRef(1)、Class(4)、
ValueTypeCreated(5)、AssetRefByInnerObj(6)、TRS(7)、ValueType(8)、Dict(11)、Array(12)… 各类型的
解析函数（`ASSIGNMENTS`）与字节布局见 [01 §2.4](01-serialization-spec.md)。

**两种打包模式：**
- **A. 简单/自定义单对象**——`SpriteFrame` / `Texture2D` / `RenderTexture`（全工程仅这 3 类有
  `_serialize`）走 `packCustomObjData` 模板，content 直接是 `_serialize` 产出。
- **B. 完整对象图**——`Prefab` / `Scene`：多节点、多组件、大量 `InstanceRef`/`Refs`，
  `SharedClasses`/`Masks` 非空。这是难点（spike 2）。

```
       两种序列化路径
                                  ┌─ 有 _serialize (3 类) ─▶ customObj / spriteFrame
library import {__type__,content} ┤
                                  ├─ 有 __type__ 注册类   ─▶ genericClass / leafClass
                                  └─ 无 __type__ (对象图)  ─▶ objectGraph (GraphSerializer)
```

### 1.3 压缩 UUID

22 字符压缩串 ↔ 标准 36 字符 uuid：前 2 字符原样，其后每 2 个 base64 字符解码 3 个 hex。
`config.uuids` / `packs` 键 / `SharedUuids` 全用压缩形式。实现 [uuid.ts](../src/uuid.ts)，逆运算
（encode）对样本验证可逆。

### 1.4 `config.<md5>.json`（bundle 清单）

```jsonc
{
  "uuids":   ["压缩uuid", ...],         // bundle 内资源；下方所有 index 指这里
  "paths":   { "0": ["images/x", 2] }, // 可寻址资源：index→[路径(无扩展), typeIndex, 子资源?]
  "types":   ["cc.SpriteFrame", ...],  // paths[*][1] 索引这里
  "scenes":  { "db://...X.fire": idx },
  "packs":   { "<packId>": [idx, ...] },// 合并 import 文件（减请求数；可选优化）
  "redirect":[idx, depBundleIdx, ...], // 该资源实际住在 deps[depBundleIdx] 里
  "deps":    ["resources","internal"], // 依赖的其它 bundle
  "name":"main", "importBase":"import", "nativeBase":"native",
  "versions":{ "import":[idx,"md5",...], "native":[idx,"md5",...] } // md5=文件名 hash 段
}
```

`config.uuids = 该 bundle 拥有的资源 ∪ 全传递闭包里的外部引用`；外部引用即 `redirect`。这条等式
是 crawl 模块的核心（§3.5）。文件名里的 `<md5> = md5(文件内容)[:5]`（import/native/config 同规则）。

### 1.5 脚本包（`index.js` / `game.js`）

标准 **browserify CommonJS bundle**：`window.__require = function(...)({ 模块表 }, {}, [入口])`。
- 模块体 = 各 `.ts` 编译出的 JS，外层包 `cc._RF.push/pop`（require framework，注册组件类）。
- 项目脚本用 **basename**（去扩展、cocos 强制全局唯一）作模块 key——这是**跨 bundle 协议**：
  本地表找不到就 fallback 到 `window.__require`（主包 main 的表）。
- node_modules 用**数字 ID** 作 key，全部并入 main 表。

---

## 2. 模块清单

按数据流上下游分层。每个模块在 §3 有「工作流程 + 原理」详解。

| 层 | 模块 | 职责 | 专题文档 |
|----|------|------|----------|
| **入口/编排** | [cli.ts](../src/cli.ts) | 参数解析 → 注入 `CFB_*` env → 动态 import 编排 | — |
| | [orchestrate.ts](../src/orchestrate.ts) | 端到端流程（图集→构建→压缩→上传） | — |
| | [build.ts](../src/build.ts) | 构建编排（crawl→装配→脚本→样板→拷贝） | 08 |
| | [config.ts](../src/config.ts) / [paths.ts](../src/paths.ts) / [platforms.ts](../src/platforms.ts) | 项目/平台/路径配置（脱离单一项目的关键） | — |
| **读盘索引** | [metaScan.ts](../src/metaScan.ts) | `.meta` 一趟扫盘 + 并行解析缓存 | — |
| | [libraryIndex.ts](../src/libraryIndex.ts) | 资源对象统一索引（import 主源 / library 回退） | — |
| | [assetGraph.ts](../src/assetGraph.ts) | 资源依赖图 + 物理归属 | 07 |
| **资源 import** | [import/](../src/import/) | 从 `assets`源+`.meta` 自生成 import 中间对象（脱离编辑器） | 09* |
| **序列化** | [serialize/](../src/serialize/) | verbose → §1.2 压缩格式（逐类型/逐路径） | 01,02,03 |
| | [registry.ts](../src/registry.ts) | 类元数据（可序列化字段/默认值/类型） | 02 |
| | [scripts/classMeta.ts](../src/scripts/classMeta.ts) | 构建时静态解析 `@property` 增补注册表 | 02 |
| **图集** | [atlasPack/](../src/atlasPack/) | 自研 auto-atlas 打包（sharp + 内容哈希缓存） | 06 |
| | [atlas.ts](../src/atlas.ts) | 图集帧映射（`atlasFrameMap`） | 06 |
| **归属/装配** | [crawl.ts](../src/crawl.ts) | 共享资源归属爬取（uuids/redirect/deps） | 07 |
| | [bundles.ts](../src/bundles.ts) | bundle 发现（扫 `isBundle` meta） | 04,07 |
| | [assemble.ts](../src/assemble.ts) | bundle 装配（config + import/ + native/） | 04 |
| **脚本打包** | [scripts/](../src/scripts/) | 自编译（TS4.1.3 worker 池）+ browserify 打包 | 05 |
| **game 样板** | [game.ts](../src/game.ts) | settings.js/ccRequire.js/game.json/模板/拷贝 | — |
| **压缩** | [minify.ts](../src/minify.ts) | swc 并行压缩（替代 terser） | — |
| **校验** | [spikes/](../src/spikes/) | 可运行的等价性回归 / oracle 对照 | 全部 |

> `09*`：import 子系统的专题（`docs/09-asset-import.md`）在源码注释中被引用，是脱离编辑器
> `library/imports` 的演进方向（详见 §3.3）。

---

## 3. 各模块工作流程与原理

### 3.1 入口与编排层

**cli.ts** 的关键设计：本文件**只静态 import node 内置**，先解析参数、`process.env.CFB_PROJECT_ROOT=…`，
**再动态 `import('./orchestrate.js')`**。这样 `paths.ts`/`config.ts` 的模块级常量在加载时即读到正确的
projectRoot/platform——实现「单进程单项目、配置免穿参」。

**config.ts / paths.ts**：取值优先级 `CLI 注入的 CFB_* env > 项目根 cfb.config.json > 内置默认`。
`paths.ts` 放最底层（被广泛依赖，避免环依赖），auto-detect 判据通用化为「同时含 `assets/` 与
`library/imports/` 的目录即 cocos 项目根」，不写死任何单一项目。`platforms.ts` 把微信/抖音的
game.js/main.js/game.json 差异收成有限枚举表，新增平台 = 加一条 spec。

**orchestrate.ts → build.ts**：见 §0 的编排顺序。`build.ts` 内部按 **bundle priority 降序**装配
（复刻 cocos：internal>Audio>resources>main>…），bundle 间**有界并发**（各写自己的 outDir、共享只读
crawl/meta 索引），让 A 的写盘 IO 与 B 的序列化 CPU 重叠。退出码：有 bundle 装配失败 → 1。

### 3.2 读盘索引层（性能基座）

老代码里 `assetMetaMap`/`uuidDirMap`/`atlasMembersMap` 各自全量遍历 `assets/` 重复读同一批 ~5000 个
`.meta`（≥3 趟）。重构成：
- **metaScan**：一趟扫盘，`primeMetaScan()` 构建前用 worker 池并行 read+parse，各消费者从内存派生映射。
- **libraryIndex**：资源对象统一索引，**import 模块为主源、library/imports 为回退**；只解析未被
  import 覆盖的那部分 json。`toRec()` 抽 `{type,name,deps}`，对 import 对象与 library 对象同构，故
  crawl/assetGraph 零改动。
- **同步/异步双模**：`prime*()` 并行预热；同步取数未预热时回退单线程，保证任何调用路径都正确。

**assetGraph**（[07](07-dependency-crawl.md)）：纯内存派生两个函数——
`directDeps(uuid)`（该资源直接引用的 uuid = library import 里所有 `__uuid__` + SpriteAtlas 成员帧）
和 `bundleOf(uuid)`（最深的 `isBundle` 祖先目录 = 物理归属）。SpriteAtlas 成员特判：library 里
SpriteAtlas 是空壳，成员关系构建时才生成（plist 用 `.meta` subMetas；auto-atlas 用 atlasFrameMap）。

### 3.3 资源 import 子系统（脱离编辑器的核心演进）

**目的**：替代「读 cocos 编辑器预生成的 `library/imports`」——直接从 `assets/` 源 + `.meta`
**自生成** import 中间对象。覆盖率随里程碑推进（M1 texture…/M3 bitmap-font·spine/M4 effect），
library 回退趋零；全覆盖后即可彻底删除 library 读盘依赖。

```
rawMetaScan() ─▶ 每条 meta ─▶ importerFor(meta.importer) ─▶ imp.import() ─▶ uuid→ImportResult
                                                                              + 引擎内置快照补入
```

`import/importers/` 下逐类型实现：`texture` / `spriteAtlas` / `bitmapFont` / `spine` / `effect` /
`objectGraph` / `plainJson` / `simple`。产出的「反序列化中间对象」与 `library/imports/<uuid>.json`
解析后**同构**，再喂给现有 `serialize/`。`import/effect/` 是最重的一块——自带 GLSL 预处理/chunk
内联/反射/murmur 哈希，复刻编辑器对 `.effect` 的编译。

### 3.4 序列化层（最大风险，已验证）

按 library 资源的 `__type__` 分发（[serialize/index.ts](../src/serialize/index.ts)）：

| 路径 | 适用 | 文件 |
|------|------|------|
| 自定义单对象 | SpriteFrame（含图集感知）| `spriteFrame.ts` |
| `packCustomObjData` | Texture2D / RenderTexture | `customObj.ts` |
| 通用 CCClass | 其它注册类（叶子资源）| `genericClass.ts` / `leafClass.ts` |
| 对象图 | prefab / scene（无 `__type__`）| `objectGraph.ts`（`GraphSerializer`）|

**registry + classMeta**（[02](02-class-registry.md)）：通用路径需要每个类的**有序可序列化字段 +
默认值 + 类型**。这是编辑器序列化器的真相数据，静态部分由编辑器 dump 到 `data/class-registry.json`
（962 类）。但**项目脚本一旦新增 `@property` 就会陈旧** → 序列化器跳过该字段 → 运行时引用为 null →
崩。故构建时（序列化前）由 `classMeta.ts` 用 ts413 解析 `assets` 下所有 `.ts` 的 `@ccclass`/
`@property`，展开继承链，经 `augmentRegistry()` **只增不删**地增补内存注册表。

**对象图编码机制**（[03](03-object-graph.md)，188/188 语义一致）：实例提升（被引用≥2次 + 根 →
顶层 Instance）、引用（实例↔实例→Refs；内联→实例→负数 InstanceRef）、资源引用、高级类型
（Class/Array_*/ValueType/TRS）、**默认值裁剪**（`deepEqual(值,默认)` 为真则丢弃）+ ValueType 归一化。

**嵌套引用统一编码**（[08 §1](08-realdevice-fixes.md)，真机修复）：嵌套在对象/数组/字典里的
`{__uuid__}` 曾被当 SimpleType 原样存 → 组件拿到裸对象崩。统一改用 **Dict(11) + AssetRefByInnerObj**
编码（覆盖 Material/AnimationClip/SkeletonData/对象图自定义组件）。**不变量**：任何资源序列化后不得
残留嵌套 `{__uuid__}`。

### 3.5 归属与装配层（完整构建器的大脑）

**crawl**（[07](07-dependency-crawl.md)）——决定每个 bundle 装哪些资源。归属模型：
1. **membership**：bundle 文件夹下物理资源 ∩ 有 library import ∩ 未被自动图集消耗。
2. **closure**：从每 bundle 物理根出发，沿（图集重写过的）forward 依赖图求传递闭包 = `config.uuids`。
3. **bundle 依赖图**：`depEdge(A→B)` 当且仅当 `priority(B)>priority(A)` 且 A 闭包到达物理属 B 的资源。
   priority 门控阻止共享资源的物理宿主漏进引用者依赖集。
4. **ownership**：`covering(R)={闭包含 R 的 bundle}`；priority 最高者唯一则它拥有；最高并列（多个同级
   叶子共享）→ **各自复制**（[08 §2](08-realdevice-fixes.md) 修正：早期「下沉公共依赖」是错误模型，
   会造成「拥有资源但缺依赖」断链）。
5. **redirect/deps**：闭包里 owner≠B 的资源 → redirect 到 owner，`deps(B)` = 这些 owner。

**assemble**：用 crawl 结果生成 `config + import/ + native/`。要点：被上浮 redirect 走的资源，**path 仍
登记在物理宿主包**（否则 `bundle.load(path)` 报 "doesn't contain"）；native 布局分两种——原名文件
（字体 `_native="X.ttf"`）用目录布局，`.mp3`/`.plist` 用扁平 `<uuid>.<md5><ext>`。

### 3.6 图集层

**atlasPack**（[06](06-atlas.md)）——自研 auto-atlas 打包，**完全脱离编辑器 temp/TexturePacker**：
发现 `.pac` → 收集 packable 帧（源图取 library native、几何取 `.meta` subMeta）→ bin-pack →
sharp 合成大图。要点：bleed（每帧四周边缘像素扩散 padding 避免双线性采样漏色）、**按 .pac 维度内容
哈希增量缓存**（命中跳过 sharp）、sharp libvips 原生线程池吃满多核、v1 禁用旋转（rect 语义零风险）。
产出 `.atlas-cache/manifest.json` 供 `atlas.ts` 的 `atlasFrameMap()` 同步读取。

**自洽 id**：cocos 给图集大图用加密哈希算 9 位 id（不复现）；我们给每张大图分配自洽 id，只需保证
**spriteframe.texture ↔ 图集 Texture2D import ↔ native png 名 ↔ config** 四处一致即可正确加载
（代价：id 与 cocos 不同、热更 diff 变大，不影响运行）。未 temp 缓存的图集**不消耗**（走原图，
放弃图集优化），否则会重写到无页图的兜底大图 → 404。

### 3.7 脚本打包层

**scripts/compile**（自编译）——用 cocos 同款 **TypeScript 4.1.3** 的 `transpileModule` 把 `assets`
下所有 `.ts` 编成 CommonJS，套 cocos 的 `cc._RF` 包装，产出与编辑器 `quick-scripts` **逐字节一致**
的代码（已对 1342 文件验证）。性能：worker_threads 池并行 + 内容哈希增量缓存。

**scripts/pack**（[05](04-bundle-config.md)）——把编译产物打成各 bundle 的 browserify `index.js`/
`game.js`。归属 = **物理 bundle 位置**（无共享上浮、无裁剪）：resources 脚本→resources，其余全→main。
`entry` 列出该 bundle 全部脚本 basename，确保每个脚本被执行以 `cc._RF.push` 注册类。**无脚本分包**
（Entry/Audio）也必须有空 `game.js` 壳，否则 game.json 编译报错。

### 3.8 game 样板与压缩层

**game.ts**——产出启动样板。文件分三类：① 生成（依赖项目数据）`settings.js`/`ccRequire.js`/
`game.json`；② 模板（基本固定）`game.js`/`main.js`/`hook.js`/`project*.json`；③ 拷贝（引擎/plugin）
`adapter-min.js`/`cocos/`/`src/assets/`——由编排层从 `--engine-pack` 拷。数据源：`settings/project.json`
（group/collision/start-scene）、`settings/<platform>.json`（appid/orientation）、`discoverBundles()`、
扫 `isPlugin` 的 jsList、编排层装配后传入的 `bundleVers`。

**minify.ts**——用 `@swc/core`（Rust）替代 terser：同档压缩设置（compress passes=2 + mangle
toplevel），体积持平/略小、速度 ~14×（9.4s→~0.7s）。再加并发池铺满多核。排除 `*min.js` 与
`minigame-rtc.js`；单文件失败保留原文件、不中断整体。

---

## 4. 校验体系（spikes/）

工具最大的杠杆是**能把产物喂回引擎反序列化器断言等价**——这是用 TS/Node 而非 C++ 的根本理由
（[01 §8](01-serialization-spec.md)）。分两档校验：

| 档 | 含义 | 入口 |
|----|------|------|
| **字节级一致** | 非图集叶子资源，与真实 import json 逐字节相同 | `spike1` / `spike1b`（165/165）|
| **语义等价** | 对象图经 `cc._deserializeCompiled` 反序列化后深比较 | `spike2:batch`（188/188）|
| **全量基线** | build 里全部 import 文件重建 + 深比较 | `validate:all` |
| **oracle 对照** | 与官方 build 逐 bundle 比 | `formal-build.ts` |
| **真机不变量** | 健全性/无埋引用/依赖自洽/跳过收敛 | `verify:regression`（[08 §5](08-realdevice-fixes.md)）|

> 语义等价（而非字节对齐）已足以驱动一个可运行的构建器：md5 会不同，但运行时加载等价。字节对齐需
> 复刻编辑器内部的 Refs/Class/String 排序启发式（顺序相关、不影响正确性），列为后续优化。

---

## 5. 已知缺口与边界

- **平台**：微信小游戏（`wechatgame`）、抖音小游戏（`bytedance`）。新增平台只需加 `platforms.ts` 一条 spec。
- **Cocos 版本**：序列化格式对照 **2.4.13** 逆向；其它 2.x 小版本跨版本前需用真实项目回归。
- **序列化缺口**：`cc.SpriteAtlas` 容器（未 temp 缓存的 .pac）个别延后；packs（JSON 合并）暂不做
  （不合并也是合法 config，多几个文件）。
- **引擎包**：不自产 `adapter-min.js` / `cocos/`，由 `--engine-pack` 复用一份官方 build；引擎升级后重产一次。
- 生产前建议在小游戏开发者工具验证一次预览构建（[README](../README.md) 适用范围）。

---

## 6. 专题文档索引

| 文档 | 主题 |
|------|------|
| [00-dev-log.md](00-dev-log.md) | 开发日志 / spike 进度留痕 |
| [01-serialization-spec.md](01-serialization-spec.md) | 产物格式与序列化规范（数据模型真相）|
| [02-class-registry.md](02-class-registry.md) | 类注册表 / 构建时增补 |
| [03-object-graph.md](03-object-graph.md) | prefab/scene 对象图序列化 |
| [04-bundle-config.md](04-bundle-config.md) | bundle 装配与 config.json |
| [05-validation-status.md](05-validation-status.md) | 全量正确性校验状态 |
| [06-atlas.md](06-atlas.md) | 图集打包与缓存复用 |
| [07-dependency-crawl.md](07-dependency-crawl.md) | 依赖爬取 / 归属规则 |
| [08-realdevice-fixes.md](08-realdevice-fixes.md) | 真机修复与回归不变量 |
</content>
</invoke>
