# 08 · 真机调试修复与不变量(WeChat 开发者工具实测)

自研构建管线(`tools/fast-build`)产出的 `build/fast-wechatgame` 在微信开发者工具里逐界面
实测,暴露并修复了一批运行时 bug。本文沉淀这些修复、根因、以及固化它们的回归不变量。

> 一键回归:`npm run verify:regression`(全 PASS 退出 0)。一键打包:`npm run build:formal`。

---

## 0. 分层:构建流程 vs 构建脚本

- **构建流程**(`src/build.ts` `buildWechatgame`)= 只替代 cocos 构建那部分 → 产出 wechatgame 结构
  (含 `remote/` 输出)。**保持纯净**,不含 terser、不起服务器。
- **构建脚本**(`formal-build.sh`,脚本层)= 调用构建流程,再做后处理(复刻 `build-uploadwx.sh`):
  terser 压缩 → 移 `remote/` 到 `build/remote` → 起 `http-server:7788` 服务 remote 包 → 改 `hook.js`
  的 `remoteBundleUrlDev` 为本机 IP。

误区:不要把部署/服务器/压缩关注点混进构建流程。

---

## 1. 嵌套引用序列化(三层统一 Dict + AssetRefByInnerObj)

**bug 类**:`genericLeaf` / `objectGraph` 原先只抽**顶层**资源引用。嵌套在对象/数组/字典里的
`{__uuid__}` 被当 SimpleType 原样存、运行时不解析成资源 → 组件/材质拿到裸 `{__uuid__}` 对象 → 崩。

| 类型 | 嵌套结构 | 真机症状 |
|---|---|---|
| `cc.Material` | `_techniqueData.props` 含纹理 `{__uuid__}` + `cc.Color` | `e.getImpl is not a function` |
| `cc.AnimationClip` | `curveData.comps["cc.Sprite"].spriteFrame` 逐帧 `{frame,value:{__uuid__}}` | `t.textureLoaded is not a function`,每帧刷屏 + 高频上报阿里云日志 |
| `sp.SkeletonData` | 纹理/图集嵌套引用 | 同类 |
| 对象图(prefab/scene)自定义组件 | 纯 JSON 字典属性 `_ctrlData={id:{idx:{字段:Vec3/Color/{__uuid__}}}}` | Sprite `_spriteFrame` 成裸对象 → `textureLoaded` 崩(BroadcastExtraSingle/MultipleItem) |

**修复**:统一用 **Dict(DataTypeID.Dict=11)+ AssetRefByInnerObj** 编码嵌套引用
(`cc.Color`/`Vec3`→ValueType、`{__id__}`→InstanceRef、内嵌 class→Class;无引用退回 SimpleType)。
- 叶子资源:`serialize/leafClass.ts`(`serializeLeafClass`),`serialize/index.ts` 路由 Material/
  AnimationClip/SkeletonData。判据:真实 class 形如 `["cc.AnimationClip",[...,"curveData"],-1,11]`。
  无嵌套时字节级一致(如 Material 的 Round_bg)。
- 对象图:`serialize/objectGraph.ts` 的 `GraphSerializer` 加 `needsAdvanced` + `encodeDict`。

**附带**:`cc.EffectAsset` 实测走通用 `genericLeaf` 即语义等价(shaders/techniques 是 SimpleType
数据块,无 `__uuid__`),已解禁(`DEFERRED_TO_SPIKE2` 只剩 `cc.SpriteAtlas`)。

**不变量(回归检查 2)**:任何资源序列化后不得残留嵌套 `{__uuid__}`。

---

## 2. 归属(ownership):并列复制 ≠ 下沉公共依赖

**bug**:tie-break 原"多个同级叶子共享 → 下沉到公共可服务 bundle(Common 等)"是**错误模型**。
公共依赖不是 coverer,其根闭包不含该资源、也不含该资源的传递依赖 → 出现"拥有资源但缺依赖"的断链。

> 实例:嵌套预制体 `ec9f9055`(物理 VoiceRoom,仅 Home/VoiceRoom 引用)被下沉归 Common,但它
> 引用的 `icon_random`(812f2065,归 SpyGameRemote)不在 Common 闭包/uuids → 创建临时房打开
> VRoomCreateUI 时 812f2065 解析回退 Common → `readFile:fail subpackages/Common/.../812f2065.json`。

**修复**(`crawl.ts` ownerOf):并列时各 coverer **各自复制**(每个拥有一份),不下沉。叶子的物理
根闭包必含该资源及其传递依赖,自洽。**真实 cocos 即此**(`ec9f9055` 被 Home+VoiceRoom 各自 OWNED)。
改后 crawl-validate own漏/多双降(199→124 / 161→124),不健全=0。

**不变量(回归检查 3)**:owned 资源序列化出的物理依赖 uuid 都必在本 bundle 的 config.uuids 内。

### 其它归属/加载要点
- **path 登记**:物理属于本 bundle 但被上浮 redirect 走的资源,path 仍登记在物理宿主包
  (import/native 在 owner)。真实 cocos 即此(VoiceRoom 的 msgIcons redirect→SpyGameRemote 但宿主留 path)。
  否则 `bundle.load(path)` 报 "Bundle X doesn't contain <path>"。见 `assemble.ts`。
- **remote 物理资源**:remote 包的物理资源可上浮到其它 remote(真实亦然,msgIcons/room_type_public →
  SpyGameRemote);物理宿主留 path 即可加载。
- **散落 assets 根的非场景资源**(Proto/MSDF):按 covering 归属(被谁引用归谁,无人引用则剪掉)。
- **引擎内嵌 default_sprite 等**:当普通共享资源按 covering 归属(真实 Common 确 own)。

---

## 3. 图集

- 消耗从 `atlasFrameMap`(.pac 已打包帧 = 消耗真相)完整填充 consumed/rewrite/groupBigTex
  (只靠 .pac walk 的 packable meta 检测会漏)。
- 未 temp 缓存的图集**不消耗**(纹理走原图,放弃图集优化);否则会重写到无页图的兜底大图 → 404。
- **plist 图集**成员从 `.meta` subMetas 取(`atlasMembers` 覆盖 plist + 自动图集);否则 plist 容器
  无成员被跳过 → 运行时按无版本请求 import → 404。
- **SpriteFrame 序列化必须传 uuid**(`serializeAsset(lib, uuid)`),否则图集成员的 texture 不会改写到
  合成大图,运行时引用被消耗的原始纹理 → 404。
- 陈旧 temp 帧(已删资源,无 library、项目无引用、源 .pac 不含)自动排除。

**不变量(回归检查 4)**:owned 跳过的只能是"未缓存 .pac SpriteAtlas 容器"(已知无害)。

---

## 4. native 布局 / 分包 / remote

- **原名文件 native**(字体 `_native="X.ttf"`,非 `.` 开头)用目录布局
  `native/<sub>/<uuid>.<md5>/<原文件名>`,源在 `library/imports/<sub>/<uuid>/<原文件名>`;
  `.mp3`/`.plist`(以 `.` 开头)用扁平 `<uuid>.<md5><ext>`。
- **无脚本分包**(Entry/Audio)也必须有入口 `game.js`(空 browserify 壳),否则 game.json 编译报
  "未找到 .../game.js"。
- **remote 包加载**:版本来自 `window.bundleVers`(=settings.bundleVers,我们的 md5),URL 来自 hook.js
  `remoteBundleUrlDev`(本地 7788 服务器,服务我们自己构建的 remote 包)。settings 的 md5 与
  `build/remote/<name>/config.<md5>.json` 文件名必须一致。

---

## 5. 回归检查(`npm run verify:regression`)

`src/spikes/regression.ts` 固化上述不变量(1 健全性 / 2 无埋引用 / 3 依赖自洽 / 4 跳过收敛),
crawl/serialize 改动后跑一遍即可防回退。负向测试已验证其有效性(移除 AnimationClip 路由 →
检查 2 准确报埋引用)。

**已知剩余(暂无害)**:个别未 temp 缓存的 .pac 图集容器被跳过(精灵走原图);crawl-validate 仍有
uuid/own 残差(非字节级一致,但不健全=0、依赖自洽)。
