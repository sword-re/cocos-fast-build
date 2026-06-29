# 脱离编辑器的 Cocos 2.x 小游戏快速构建管线

### 技术报告

**项目** cocos-fast-build　**版本** 0.1.0　**目标引擎** Cocos Creator 2.4.x（格式对照 2.4.13）
**关键词** 增量构建 · 序列化逆向 · 资源依赖归属 · 图集打包 · 小游戏

---

## 摘要

Cocos Creator 2.x 的官方构建在中等规模项目（23 个 bundle）上耗时约 67 秒，其中编辑器冷启动、脚本
编译与资源序列化占绝大部分。本文报告 **cocos-fast-build**——一套脱离 Cocos Creator 编辑器、直接消费
项目中间产物（`assets/`、`*.meta`、`library/imports/`）的命令行构建管线。该工具以开源运行时引擎的
反序列化器（`deserialize-compiled.ts`）为唯一真相，逆向出产物的压缩 JSON 序列化格式并实现其逆变换；
复刻了编辑器构建器的资源归属爬取、bundle 装配、脚本编译打包、自动图集打包与 game 启动样板生成，
并以 swc 替代 terser 完成压缩。在同一参考项目上，构建最慢的「资源装配 + 脚本 + 序列化」阶段由
约 67 秒降至约 6 秒（暖缓存）/ 11 秒（冷启动），压缩阶段由约 9 秒降至约 0.5 秒。正确性以「字节级
对齐」与「引擎反序列化语义等价」双重判据验证，并在微信开发者工具中逐界面真机回归。本文阐述其数据
模型、系统架构、关键算法与工程权衡，并讨论局限与边界。

---

## 1. 背景与动机

### 1.1 问题

官方构建慢的根因不在「单次算得不够快」，而在三处结构性开销（实测分布，约 65s 基线）：

| 阶段 | 耗时 | 性质 |
|------|------|------|
| 编辑器冷启动 + 引擎初始化 | ~10s | 拉起 Electron，固定成本 |
| 编译脚本 | ~22s | tsc + 包装 |
| 资源序列化 | ~27s | verbose → 压缩格式 |
| 收尾 | ~6s | 写盘 / 配置 |

### 1.2 提速假设

工具的提速并非来自「重写一个更快的序列化器」，而来自三条结构性杠杆：

1. **免冷启动**——不拉起 Electron 编辑器，直接以 Node 进程消费中间产物，省约 10s。
2. **增量**——复用已序列化的 `library/imports`（中间产物）与已编译脚本的内容哈希缓存，只重算变更项。
3. **并行**——以 `worker_threads` 池吃满多核做脚本 transpile、`.meta` 解析与图集合成。

### 1.3 设计边界

工具**只替代构建中最慢、最易变的那段**（资源装配 + 脚本 + 图集 + 样板 + 压缩），**不自产**稳定的
引擎与适配层（`adapter-min.js`、`cocos/`）——后者由 `--engine-pack` 指向一份现成官方 build 复用，
引擎升级时重产一次即可。此边界把「逆向风险」收敛在确实多变的资源/脚本层，避免重写稳定的运行时。

---

## 2. 数据模型

复刻产物的前提是读懂产物。本节定义官方构建产物的内部数据模型，其权威来源是运行时引擎的反序列化器
`cocos2d/core/platform/deserialize-compiled.ts`——**我们的序列化器即其逆**（format version = 1）。

### 2.1 产物的组成

一个 bundle 由四部分构成，三种物理布局：

```
bundle ≜ { config 清单, 脚本包, import 序列化资源, native 原始资源 }
布局：内置→assets/<b>　微信分包→subpackages/<b>　远程→remote/<b>
```

### 2.2 压缩 JSON 序列化格式

每个 `import/*.json` 是一个**下标语义固定**的数组 `IFileData`（运行时按下标取，无键名开销）：

```
[ Version, SharedUuids, SharedStrings, SharedClasses, SharedMasks,
  Instances, InstanceTypes, Refs, DependObjs, DependKeys, DependUuidIndices ]
```

- **共享表**（uuid/字符串/类/掩码）去重并以下标引用，是压缩的主要来源；
- **Instances** 是一维对象数据数组，末元素编码 `RootInfo`（根对象下标 + 是否有 native 依赖）；
- 属性值按 13 种 `DataTypeID` 编码——`SimpleType` 纯 JSON、`InstanceRef` 对象引用、`Class` 内嵌、
  `ValueType`/`ValueTypeCreated`、`TRS`、`AssetRefByInnerObj` 资源引用、`Dict`、`Array` 等；
- **Refs** 表承载循环引用与多处引用（owner/key/target 三元组）；
- **Depend\*** 三表平行，把「按 uuid 加载的资源」回填到宿主对象属性。

序列化分两种打包模式：

```
                                  ┌─ 有 _serialize（全工程仅 3 类：
                                  │   SpriteFrame/Texture2D/RenderTexture）
library 资源 {__type__, content} ─┤      → packCustomObjData 模板（A：单对象）
                                  ├─ 其它注册类 → 通用 CCClass 路径（叶子资源）
                                  └─ 无 __type__（prefab/scene）→ 对象图（B：多实例 + Refs）
```

### 2.3 标识与清单

- **压缩 UUID**：22 字符 ↔ 标准 36 字符，前 2 字符原样、其后每 2 个 base64 解码 3 个 hex；
  `config.uuids`、`SharedUuids`、pack 键全用压缩形式。
- **`config.<md5>.json`**：`uuids` 索引表 + `paths`（可寻址路径）+ `types` + `scenes` + `packs` +
  `redirect`（资源住在依赖 bundle）+ `deps` + `versions`（文件名 md5）。核心等式：
  **`config.uuids = 该 bundle 拥有的资源 ∪ 传递闭包中的外部引用`**，外部引用即 `redirect`。
- **文件名 md5**：`md5(文件内容)[:5]`，import/native/config 同规则。

### 2.4 脚本包

标准 browserify CommonJS bundle（`window.__require(...)({模块表},{},[入口])`）。项目脚本以 **basename**
（cocos 强制全局唯一）作模块 key，构成**跨 bundle 协议**——本地表未命中即 fallback 到主包 main 表；
node_modules 用数字 ID 并入 main 表。组件类由外层 `cc._RF.push/pop` 注册。

---

## 3. 系统架构

管线分九层，数据自上而下流经：

```
输入：assets/**/*.meta · library/imports · assets/**/*.ts · settings/*.json · .pac · class-registry
  │
  ├─ 读盘索引层      metaScan（一趟扫盘）/ libraryIndex（import 主源 + library 回退）/ assetGraph
  ├─ 资源 import 层  import/*（从源 + meta 自生成中间对象，脱离 library）
  ├─ 序列化层        serialize/*（→ §2.2 压缩格式）+ registry/classMeta（类元数据）
  ├─ 图集层          atlasPack（自研 bin-pack + sharp 合成）/ atlas（帧映射）
  ├─ 归属/装配层     crawl（共享资源归属）→ assemble（config + import/ + native/）
  ├─ 脚本打包层      scripts/compile（TS4.1.3 worker 池自编译）→ scripts/pack（browserify）
  ├─ 样板层          game（settings.js / ccRequire.js / game.json / 模板 / 引擎拷贝）
  └─ 压缩层          minify（swc 并行）
  │
输出：build/fast-<platform>/
```

编排（`orchestrate.ts → build.ts`）固定顺序：**图集打包 → 清理输出 → crawl 爬依赖图 → 刷新脚本类
注册表 → 按 priority 降序装配各 bundle（有界并发）→ 打包脚本 → 生成 game 样板 → 拷贝引擎/plugin →
swc 压缩 →（可选）上传 remote**。

**配置注入机制**：`cli.ts` 只静态 import node 内置，先解析参数并写 `process.env.CFB_*`，**再动态
import** 构建模块——使 `paths.ts`/`config.ts` 的模块级常量在加载时即读到正确 projectRoot/platform，
实现单进程单项目、配置免穿参。取值优先级 `CFB_* env > cfb.config.json > 内置默认`。

---

## 4. 关键算法

### 4.1 序列化逆向（最大风险）

通用 CCClass 路径需要每个类的**有序可序列化字段 + 默认值 + 类型**，这是编辑器序列化器的真相数据。
静态部分由编辑器一次性 dump（962 类）。**风险点**：项目脚本一旦新增 `@property` 即陈旧——序列化器
跳过该字段，运行时引用为 null 而崩。解法：构建时（序列化前）由 `classMeta.ts` 以 TS4.1.3 静态解析
`assets` 下全部 `.ts` 的 `@ccclass`/`@property`，展开继承链，**只增不删**地增补内存注册表。

对象图编码的核心规则：**实例提升**（被引用 ≥2 次的对象与根提为顶层 Instance，其余内联）、**引用
延迟统一**（实例↔实例入 Refs 表，内联→实例用负数 InstanceRef）、**默认值裁剪**（`deepEqual(值,默认)`
为真即丢弃）与 ValueType 归一化。**嵌套引用不变量**：任何资源序列化后不得残留嵌套 `{__uuid__}`——
统一以 `Dict + AssetRefByInnerObj` 编码（此前真机暴露 Material/AnimationClip/SkeletonData 因裸
`{__uuid__}` 崩溃）。

### 4.2 共享资源归属爬取

完整构建器的「大脑」——决定每个 bundle 装哪些资源、哪些 redirect 到依赖 bundle。模型：

1. **membership**：bundle 文件夹下物理资源 ∩ 有 library import ∩ 未被自动图集消耗；
2. **closure**：从物理根沿（图集重写后的）forward 依赖图求传递闭包 = `config.uuids`；
3. **bundle 依赖图**：`depEdge(A→B) ⟺ priority(B)>priority(A) ∧ A 闭包到达物理属 B 的资源`——
   priority 门控阻止共享资源的物理宿主漏进引用者依赖集；
4. **ownership**：`covering(R) = {闭包含 R 的 bundle}`；priority 最高者唯一则它拥有；**最高并列
   （多 bundle 共享）→ 各自复制**（每个拥有一份）。早期「下沉到公共依赖 bundle」被证伪——公共依赖
   的根闭包不含该资源及其传递依赖，会造成「拥有资源但缺依赖」的运行时断链；
5. **redirect/deps**：闭包中 owner≠B 者 redirect 到 owner，`deps(B)` 即这些 owner。健全性由构造
   保证——redirect 目标取 B 可服务者。被 redirect 走的资源**path 仍登记在物理宿主包**，否则
   `bundle.load(path)` 失败。

### 4.3 自动图集打包

完全脱离编辑器 `temp/TexturePacker`：发现 `.pac` → 收集 packable 帧（源图取 library native、几何取
`.meta` subMeta）→ bin-pack → sharp 合成大图。工程要点：**bleed**（每帧四周边缘像素扩散 padding，
避免双线性采样跨帧漏色）、**按 .pac 内容哈希增量缓存**（命中跳过 sharp）、sharp 底层 libvips 原生
线程池吃满多核、v1 禁旋转（rect 语义零风险）。**自洽 id**：cocos 给图集大图用加密哈希算 9 位 id
（不复现），我们改用自洽 id，只需保证「spriteframe.texture ↔ 图集 Texture2D ↔ native png ↔ config」
四处一致即可正确加载（代价：热更 diff 变大，不影响运行）。

### 4.4 脚本自编译

以 cocos 同款 **TypeScript 4.1.3** 的 `transpileModule` 编译 `assets` 下全部 `.ts` 为 CommonJS，
套 `cc._RF` 包装，产出与编辑器 `quick-scripts` **逐字节一致**的代码（1342 文件验证）。worker_threads
池并行 + 内容哈希增量缓存（仅重编改动文件）。脚本归属取物理 bundle 位置（无共享上浮），`entry` 列出
全部 basename 确保每脚本被执行以注册类。

---

## 5. 评估

### 5.1 性能

同参考项目（23 bundle）：

| 阶段 | 官方构建 | 本工具 | 加速比 |
|------|---------|--------|--------|
| 资源装配 + 脚本 + 序列化 | ~67s | ~6s（暖）/ ~11s（冷） | ~6–11× |
| JS 压缩 | terser ~9s | swc ~0.5s | ~14× |

swc 在同档压缩设置（compress passes=2 + mangle toplevel）下体积与 terser 持平/略小。

### 5.2 正确性

采用两档判据，互为补充：

| 判据 | 含义 | 结果 |
|------|------|------|
| **字节级对齐** | 非图集叶子资源与真实 import json 逐字节相同 | 165 / 165 ✅ |
| **语义等价** | 对象图经 `cc._deserializeCompiled` 反序列化后深比较（排除运行时随机 `_id`）| 188 / 188 ✅ |
| **真机回归** | 微信开发者工具逐界面实测 | 通过（暴露并修复嵌套引用、归属断链等）|

> 字节对齐需复刻编辑器内部 Refs/Class/String 排序启发式（顺序相关、不影响运行时正确性），列为后续
> 优化；语义等价已足以驱动可运行构建器（md5 不同但加载等价）。

工具最大的杠杆是**能把产物喂回引擎反序列化器断言等价**——这是选用 TS/Node 而非 C++ 的根本理由：
可直接复用引擎自身的反序列化语义做正确性校验，对齐数字格式化/键顺序等微妙约定，是 C++ 拿不到的。

回归不变量（`verify:regression`）固化四条：① 健全性、② 无嵌套埋引用、③ 依赖自洽（owned 资源的物理
依赖必在本 bundle uuids 内）、④ 跳过收敛。负向测试已验证其有效性。

---

## 6. 局限与边界

- **平台**：微信小游戏（`wechatgame`）、抖音小游戏（`bytedance`）；平台差异收在 `platforms.ts`
  描述表，新增平台 = 加一条 spec。
- **引擎版本**：序列化格式对照 2.4.13 逆向，其它 2.x 小版本跨版本前需用真实项目回归。
- **序列化缺口**：个别 `cc.SpriteAtlas` 容器（未 temp 缓存的 .pac）延后；packs（JSON 合并）暂不做
  （不合并亦为合法 config，仅多几个文件请求）。
- **引擎包依赖**：不自产 `adapter-min.js`/`cocos/`，依赖 `--engine-pack` 复用一份官方 build。
- **首次前提**：需项目已在编辑器构建过一次（具备 `library/imports`）；import 子系统正逐里程碑
  从源 + meta 自生成，覆盖率提升后 library 回退趋零，最终可彻底脱离 library 读盘。

生产前建议在小游戏开发者工具验证一次预览构建。

---

## 7. 未来工作

1. **彻底脱离 library**：推进 `import/` 子系统覆盖 effect/spine/bitmap-font/plist 全类型，删除
   library 读盘回退；
2. **字节级对齐对象图**：复刻编辑器 Instances/SharedClasses/SharedStrings/Refs 排序启发式，使热更
   diff 最小；
3. **packs 分组**：实现 group-manager 启发式合并小 import，减少请求数并复现合成 atlas id；
4. **增量编排**：以源 mtime/hash diff 精确定位受影响资源与其 bundle，把暖构建推向亚秒级。

---

## 8. 结论

cocos-fast-build 证明：通过**以运行时引擎反序列化器为真相逆向产物格式**、**复用编辑器已产出的中间
缓存**、**并行化 CPU 密集子任务**三条路径，可在不重写稳定引擎层的前提下，将 Cocos 2.x 小游戏构建中
最慢的资源/脚本/压缩阶段提速约一个数量级，且产物在真机加载等价。其方法论——把逆向风险收敛在多变层、
用引擎自身做正确性 oracle、以语义等价而非字节对齐作为可用性门槛——对同类「脱离 IDE 的构建加速」具有
一般参考价值。

---

## 附录：文档索引

总开发文档 [DEVELOPMENT.md](DEVELOPMENT.md) ｜ 使用文档 [USAGE.md](USAGE.md) ｜
专题 [01 序列化规范](01-serialization-spec.md) · [02 类注册表](02-class-registry.md) ·
[03 对象图](03-object-graph.md) · [04 bundle 装配](04-bundle-config.md) ·
[05 校验状态](05-validation-status.md) · [06 图集](06-atlas.md) ·
[07 依赖爬取](07-dependency-crawl.md) · [08 真机修复](08-realdevice-fixes.md)
</content>
