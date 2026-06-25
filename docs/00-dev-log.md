# fast-build 开发日志（方案 D 进度）

> 本文件原为 `tools/fast-build/README.md` 的开发进度记录。工具已通用化为 CLI（见
> [`tools/fast-build/README.md`](../README.md)），此处保留 spike/逆向阶段的进度留痕。

放在狼人项目下，方便直接读取 `library/imports`、`temp`、`build/wechatgame` 等中间产物。

规范文档：[01-serialization-spec.md](01-serialization-spec.md)

## 运行（spike）

```bash
cd tools/fast-build
npm install
npm run test:uuid   # 压缩 uuid 编解码自测
npm run samples     # 扫描 build 产物,统计资源类型分布
npm run spike1      # Spike 1a:SpriteFrame 序列化字节对齐
```

## 进度

- [x] 压缩 UUID 编解码(`src/uuid.ts`)
- [x] 样本配对 / 字节 diff 基础设施(`src/samples.ts` `src/verify.ts`)
- [x] Spike 1a:SpriteFrame(自定义对象路径)字节对齐 —— 118/118
- [x] 类注册表(`data/class-registry.json`,962 类,从编辑器 dump)
- [x] Spike 1b:通用 CCClass 路径 + 默认值裁剪 —— 165/165 字节对齐
      (TTFFont/TextAsset/AudioClip/Material/Texture2D/SpriteFrame)
- [x] Spike 2:对象图(prefab/scene)序列化器 + 引擎反序列化语义校验
      → **188/188 语义完全一致**(详见 03-object-graph.md)
- [x] Spike 3:最小 bundle 端到端组装(import+native+config,md5 正确,import 逐字节一致)
      详见 04-bundle-config.md
- [x] 共享资源归属爬取(`src/crawl.ts`)+ 完整 bundle 装配(`src/assemble.ts`):
      uuids/owned/redirect/deps/paths/types/versions/scenes,SpriteAtlas 装配
- [x] **脚本打包(`src/scripts/`,`npm run scripts:pack`)**:browserify 格式 index.js
      - wrapper 剥离(quick-compile preview → 纯 CommonJS)1417/1417 锚点稳定
      - 项目脚本用 basename 作模块 key(跨 bundle 协议,靠 window.__require fallback 链)
      - node_modules 用数字 ID(node resolve + builtin stub + dist/单 js 兜底)
      - **归属=物理 bundle 位置**:主包脚本→main/index.js,分包→subpackages/<b>/game.js,
        resources→resources/index.js(无共享上浮、无裁剪)
      - 验证:**16/16 bundle 模块数精确匹配真实 build**(main 580/entry514、VoiceRoom190、Social172…)/
        解析自洽 0 失败 / main 自包含 / 语法合法 / **运行时铁证**(真实执行 Md5.digest 正确)
- [x] **game 样板(`src/game.ts`,`npm run game:template`)**:生成 settings.js / ccRequire.js /
      game.json + 模板 game.js/main.js/hook.js/project*.json
      - 数据源:settings/project.json(group/collision/start-scene)、settings/wechatgame.json
        (appid/orientation/startSceneBundle)、discoverBundles(分包/remote)、扫描 isPlugin(jsList)
      - 验证:settings.js 全 11 字段 + game.json + ccRequire.js 模块列表**与真实 build 完全一致**
      - bundleVers 由编排层装配后传入(spike 暂用真实值验证生成逻辑)
- [x] **端到端编排(`src/build.ts`,`npm run build:all`)**:按 priority 降序装配所有 bundle +
      打包脚本 + game 样板 + 拷贝引擎/plugin → 完整 build/wechatgame
      - 布局:资源 内置→assets/分包→subpackages/remote→remote;脚本 内置→assets index.js/
        分包→subpackages game.js/remote→src/scripts index.js
      - cocos 风格构建日志(`src/buildLog.ts`):Start to build / building [X] [===] N% / --- build-asset / Warning / Built successfully(均带时间戳)
      - 验证:21 物理 bundle 全部装配成功,产物关键文件 14/14 齐备
      - 缺口:虚拟主包 main / internal 的**资源**装配未实现(crawl 只覆盖物理 bundle),
        其 bundleVers 暂由外部传入;少量资源因 temp 未缓存图集跳过
- [ ] 补 main/internal 资源装配 + temp 未缓存图集 → 真机加载验证
- [ ] packs(JSON 合并)/ 增量并行编排
- [ ] 真机加载验证

运行:`npm run spike1b`(叶子资源全绿)、`npm run spike2:batch`(对象图覆盖)、
`npm run scripts:pack`(脚本打包,带时间戳日志)。
spike2 校验需配合编辑器桥用 `cc._deserializeCompiled` 反序列化深比较。

## 结构（早期）

```
src/
  uuid.ts        压缩 uuid 编解码
  paths.ts       项目根/缓存/产物路径解析
  samples.ts     library 源 ↔ build 产物 配对、扫描
  format.ts      压缩 JSON 文件格式常量/类型(File / DataTypeID)
  verify.ts      字节级 diff
  serialize/     序列化器(逐类型/逐路径)
  spikes/        可运行的验证脚本
```
