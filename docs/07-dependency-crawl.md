# 依赖爬取 / Bundle 装配 —— 设计

完整构建器的"大脑":决定每个 bundle 装哪些资源、哪些 redirect 到依赖 bundle、过滤未用资源。

## Bundle 发现(已完成)

`src/bundles.ts` 扫描 `assets/**/*.meta` 中 `isBundle=true` 的文件夹 → 21 个 bundle:
`{name, rootDir, dbPath, priority, compressionType(subpackage/merge_all_json/default), isRemote}`。
`src/spikes/bundles-check.ts` 对照真实 config 量化(见对话)。

## membership 过滤的主力是"图集消耗",不是场景可达性(已定位)

全工程仅 2 个 .fire 场景,但每 bundle 有大量运行时动态加载资源 → 使用集 ≠ 场景闭包。
实测 Common 的 576 个"物理独有(不在 real)"= **406 个被自动图集消耗的原始 Texture2D**
(spriteframe 改指图集大图,原图不再 ship)+ 170 个无 library import 的(原始 image/.pac 主资源)。

→ **简化的 membership 规则**:bundle 成员 ≈ 物理资源中「有 library import 且未被图集消耗」的,
再加「图集生成的大图 Texture2D」。"filter unused" 的场景可达性影响很小,主因是图集消耗。

## 实测揭示的规则(对照真实 config.uuids)

| 现象 | 含义 |
|------|------|
| real 有、物理无(redirect) | 本 bundle 引用了"住在依赖 bundle 里"的资源 → config.redirect + deps |
| 物理有、real 无 | 该资源**未被任何场景/预制体引用**(filter unused 剔除),或被分到更高优先级共享 bundle |
| Game/Activity/SpyGame real=0 | 纯脚本/无资源 bundle(只打脚本) |

例:Home real=362 物理=320 命中=213 → 149 个 redirect(引用别处),107 个物理资源未用被剔。

## 爬取算法(待实现)

1. **资源依赖图**:asset uuid → 其引用的 asset uuid 集合。
   数据源:library import(spriteframe→texture、material→effect、prefab→各 spriteframe/组件引用…)。
   可复用我们序列化时already解析出的依赖(DependUuidIndices + 对象图 refs)。
2. **可达性**:从每个 bundle 的"根"(场景 + 直接放在 bundle 下被用的资源)出发遍历依赖图,得到该 bundle 的可达集。未可达的物理资源 → 丢弃(filter unused)。
3. **归属分配**:每个可达 asset 分到唯一 bundle。规则(需进一步标定):大致按"物理所在 bundle";被多 bundle 引用的共享资源留在其物理 bundle;高优先级 bundle(如 Common p6)承接跨 bundle 共享。
4. **redirect / deps**:bundle X 引用了归属 bundle Y 的资源 → X.config.redirect 加 (assetIndex, depIndex),X.deps 含 Y。
5. **图集**:成员原纹理不 ship,改 ship 图集大图(见 06);成员归属随其 spriteframe。
6. **paths**:可寻址 bundle(resources 等)由 meta 路径生成(见 04)。

## 验证

每个 bundle:我们算出的成员集 == 真实 config.uuids(解压后)集合;redirect/deps 一致。
最终:整包用微信开发者工具加载跑通(延续 build/wechatgame-verify 的验证方式)。

## 核心模型已验证(crawl-check)

`src/assetGraph.ts`(directDeps:library 递归收集 __uuid__;bundleOf:最深 bundle 祖先)+
`src/spikes/crawl-check.ts` 用真实 config 当"使用集"oracle 验证:

- **config.uuids = 拥有 ∪ 全传递闭包的外部引用**;外部引用即 redirect(连 redirect 资源的依赖也列入,
  使加载时无需跨 bundle 查 config)。
- **零误报(多=0)**:directDeps + bundleOf 不会算错 redirect。
- 命中率高(Recharge/ActivityPage 全中);剩余"漏"两类:
  1. **SpriteAtlas → 成员帧**:library 里 SpriteAtlas 是空的(`{__type__,_name}`),成员关系 build 时才生成。
     需特判:SpriteAtlas 的依赖 = 其成员 spriteframe(plist 用 subMetas;auto-atlas 用 .pac/atlasFrameMap)。
  2. **合成 atlas/pack id**(bundleOf=null):我们自洽生成并归属本 bundle,非真漏。

## 归属规则关键发现:共享资源上浮(已定位)

实测根因:`bundleOf` 用**物理位置**判归属,对共享资源是错的。例:
spriteframe `01bcf49d` 物理在 Social,但被 **Social 和 Common 同时引用** →
真实构建把它**上浮(promote)到高优先级共享 bundle `Common`(priority 6)**,
Social 改为 redirect 到 Common。我们仍判它属 Social → Common 漏掉这条 redirect。

→ **归属规则 = group-manager 的传递式自动分组(已标定到此程度)**:
- 反推统计(`npm run owner:rule`):2438 个 owner 中 2236 物理==owner,**135 上浮**,5 重复,67 合成。
  上浮去向**不固定**:Social→Common(50)、VoiceRoom→MainBundle(34)、Entry/Mine→Common、Social→VoiceRoom 等。
- 假设"owner=直接引用者中最高优先级"(`npm run owner:rule2`)命中 2247/2371,仍 124 错。
- **根因 = 传递传播**:例 01bcf49d 物理 Social、只被 Social 的 prefab `2d3643ce` 引用,但 `2d3643ce`
  自身被上浮到 Common(被多处引用),其专属依赖(01bcf49d 及其 texture)**跟着下沉到 Common**。
- 即:资源沉到"递归引用它的所有东西所共同依赖的 bundle";直接引用者/物理位置都不够,需**传递闭包**。

**待实现的正确算法**:以"场景(各属一 bundle)"为根 → 传递求每个资源被哪些 bundle 的根闭包引用 →
owner = 这些 bundle 在 bundle 依赖图上的"最近公共依赖/最高优先级公共 dep";无公共 dep → 在各引用 bundle 重复。
对纯加载正确性,只需"放进一个所有引用者都依赖的 bundle"即可(不必与 cocos 完全一致)。

`bundleOf`(物理)适合"单引用"判定;共享判定需上述全局分析。当前 crawl-check 的"漏"绝大多数
就是这些上浮到 Common 的共享资源(零误报,只是归属判在物理 bundle)。

## SpriteAtlas 成员特判(已完成)

`directDeps` 对 SpriteAtlas 追加成员帧(plist 用 `.meta` subMetas;auto-atlas 用 atlasFrameMap)。
见 `src/assetGraph.ts` `atlasMembers`。
