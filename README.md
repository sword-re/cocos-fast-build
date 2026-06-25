# cocos-fast-build

脱离 Cocos Creator 编辑器的 **Cocos 2.x 小游戏快速构建管线**。直接读取项目的 `library/imports`、`assets/*.meta` 等中间产物，复刻编辑器构建器的资源装配（config / import / native）、脚本打包（cc._RF）、图集打包与 game 模板生成，再用 swc 压缩。

**它替代官方构建里最慢的那部分**（资源装配 + 脚本编译 + 压缩），不替代引擎本身——引擎/适配层包（adapter / cocos2d-js）由 `--engine-pack` 指向一份现成的官方 build 复用。

## 为什么

同一项目（23 个 bundle）实测：

| 阶段 | 官方 cocos 构建 | 本工具 |
| --- | --- | --- |
| 资源装配 + 脚本 + 序列化 | ~67s | **~6s（暖缓存）/ ~11s（冷）** |
| JS 压缩 | terser ~9s | **swc ~0.5s** |

## 环境要求

- Node ≥ 18
- 一个**已在编辑器里打开过 / 构建过一次**的 Cocos 2.x 项目（需要 `library/imports/` 与 `assets/`）
- 一份现成的官方 build 目录作为引擎包来源（`--engine-pack`，见下）
- 原生依赖 `sharp`（图集）、`@swc/core`（压缩）按当前平台安装

## 安装

```bash
git clone <this-repo> cocos-fast-build
cd cocos-fast-build
npm ci          # 按当前平台安装原生依赖(sharp / @swc/core);勿提交他平台的 node_modules
```

> CI 上务必 `npm ci`（而非拷贝 node_modules），让 sharp / @swc/core 现装对应平台二进制。

## 用法

```bash
# 安装后(bin 已链接):
cocos-fast-build --project <cocos项目根> --engine-pack <一份官方build> [选项]

# 或源码直接跑:
npx tsx src/cli.ts --project <cocos项目根> --engine-pack <一份官方build> [选项]
```

### 选项

| 选项 | 说明 |
| --- | --- |
| `-p, --project <dir>` | cocos 项目根目录（含 `assets/` 与 `library/imports/`）。默认当前目录 |
| `--platform <name>` | 目标平台，目前仅 `wechatgame`（默认） |
| `-o, --out <dir>` | 产物目录。默认 `<project>/build/fast-<platform>` |
| `--engine-pack <dir>` | 引擎/plugin 拷贝来源（一份现成官方 build）。省略则产物缺引擎包、不可直接运行 |
| `--no-minify` | 跳过 swc 压缩 |
| `-h, --help` | 帮助 |

### 项目配置 `cfb.config.json`

放在 **cocos 项目根**，覆盖平台/项目级设置：

```json
{
  "platform": "wechatgame",
  "projectName": "my-game",
  "libVersion": "3.8.9",
  "bootExtras": [
    { "global": "MinigameRtc", "module": "./src/assets/Script/Lib/RTC/minigame-rtc.min.js" }
  ]
}
```

- `bootExtras`：game.js 启动时注入的项目级 plugin 全局（`window.<global> = require(<module>)`），对应官方 boot 序列里手写的那些 require。
- 缺省：`platform=wechatgame`、`projectName=项目目录名`、`libVersion=3.8.9`、`bootExtras=[]`。

## 引擎包（`--engine-pack`）

工具不自产引擎/适配层（它们稳定、不常变）。**首次**用编辑器或官方流程构建一次得到 `build/wechatgame/`，之后把它作为引擎包复用：

```bash
cocos-fast-build --project /path/proj --engine-pack /path/proj/build/wechatgame --out /path/proj/build/fast
```

工具会从引擎包拷贝 `adapter-min.js`、`cocos/`、`src/assets/`、`hook.js`。引擎升级后重新产一次即可。

## Jenkins 示例

```groovy
stage('fast-build') {
  sh '''
    git clone <this-repo> cfb && cd cfb && npm ci
    node bin/cocos-fast-build.mjs \
      --project "$WORKSPACE/cocos-proj" \
      --engine-pack "$WORKSPACE/engine-pack" \
      --out "$WORKSPACE/dist"
  '''
}
```

退出码：装配有 bundle 失败时为 1。

## 适用范围与已知限制

- **平台**：目前仅微信小游戏（`wechatgame`）。平台差异已抽象，后续可加抖音等。
- **Cocos 版本**：序列化格式对照 **2.4.13** 逆向；其它 2.x 小版本可能有差异，跨版本前请用真实项目回归。
- **已知缺口**：少量高级类型（如 `cc.EffectAsset`）序列化延后；个别 bundle 与官方 config 仍有结构差异（见 oracle 对照）。生产前建议在微信开发者工具验证一次预览构建。

## 结构

```
bin/cocos-fast-build.mjs   可执行入口(tsx 加载 cli.ts)
src/
  cli.ts            参数解析 + 注入 CFB_* env + 动态 import 编排
  orchestrate.ts    端到端流程(图集→构建→swc 压缩)
  config.ts         平台/项目配置(cfb.config.json + CFB_* env)
  paths.ts          项目根/缓存/产物路径(CFB_PROJECT_ROOT 优先 + auto-detect)
  crawl.ts          共享资源归属爬取(依赖图 + 归属)
  assemble.ts       bundle 装配(config / import / native)
  scripts/          脚本自编译 + cc._RF 打包(TS4.1.3 worker 池)
  atlasPack/        自带图集打包(sharp + 内容哈希缓存)
  game.ts           game 模板生成(settings/ccRequire/game.json/...)
  minify.ts         swc 压缩
  serialize/        序列化器(逐类型/逐路径)
  spikes/           可运行的验证 / oracle 对照脚本
```

## 开发 / 校验

- 规范文档：[docs/01-serialization-spec.md](docs/01-serialization-spec.md)
- 等价性回归：`src/spikes/{crawl,assemble,game}-digest.ts`（对产物求指纹）
- oracle 对照（与官方 build 逐 bundle 比）：`npx tsx src/spikes/formal-build.ts`
- 类型检查用 TS 5：`node node_modules/typescript/bin/tsc --noEmit --skipLibCheck`
  （注意 `npx tsc` 解析到的是脚本编译用的 4.1.3，不能用来类型检查）
