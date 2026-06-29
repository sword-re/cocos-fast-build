# cocos-fast-build 使用文档

> 脱离 Cocos Creator 编辑器的 **Cocos 2.x 小游戏快速构建管线**。本文讲「怎么用」；想了解内部原理、
> 数据模型与模块设计，看 [DEVELOPMENT.md](DEVELOPMENT.md)。

---

## 1. 它是什么 / 不是什么

- **是**：替代官方构建里最慢的那段——**资源装配（config/import/native）+ 脚本编译打包 + 图集打包 +
  game 模板生成 + 压缩**。同项目（23 bundle）实测：装配+脚本+序列化 ~67s → **~6s 暖缓存 / ~11s 冷**；
  压缩 terser ~9s → swc **~0.5s**。
- **不是**：不自产引擎与适配层（`adapter-min.js` / `cocos/`）——它们稳定、不常变，由 `--engine-pack`
  指向一份现成官方 build 复用。

---

## 2. 环境要求

- Node ≥ 18
- 一个**已在编辑器里打开过 / 构建过一次**的 Cocos 2.x 项目（需要 `library/imports/` 与 `assets/`）
- 一份现成的官方 build 目录作为**引擎包**来源（`--engine-pack`，见 §6）
- 原生依赖 `sharp`（图集）、`@swc/core`（压缩）按当前平台安装

---

## 3. 安装

```bash
git clone <this-repo> cocos-fast-build
cd cocos-fast-build
npm ci    # 按当前平台装原生依赖(sharp / @swc/core)；勿提交他平台的 node_modules
```

> CI 上务必 `npm ci`（而非拷贝 `node_modules`），让 sharp / @swc/core 现装对应平台二进制。

---

## 4. 快速开始

```bash
# 安装后(bin 已链接)：
cocos-fast-build --project <cocos项目根> --engine-pack <一份官方build> [选项]

# 或源码直接跑：
npx tsx src/cli.ts --project <cocos项目根> --engine-pack <一份官方build> [选项]
```

最小示例（微信）：

```bash
cocos-fast-build \
  --project /path/proj \
  --engine-pack /path/proj/build/wechatgame \
  --out /path/proj/build/fast
```

抖音小游戏（引擎包用一份官方 `build/bytedance/`，平台配置自动从 `settings/builder.json` 的
`bytedance` 段读取）：

```bash
cocos-fast-build --project /path/proj --platform bytedance \
  --engine-pack /path/proj/build/bytedance --out /path/proj/build/fast-bytedance
```

---

## 5. 命令行选项

| 选项 | 说明 |
| --- | --- |
| `-p, --project <dir>` | cocos 项目根（含 `assets/` 与 `library/imports/`）。默认当前目录 |
| `--platform <name>` | 目标平台：`wechatgame`（默认）/ `bytedance` |
| `-o, --out <dir>` | 产物目录。默认 `<project>/build/fast-<platform>` |
| `--engine-pack <dir>` | 引擎/plugin 拷贝来源（一份现成官方 build）。省略则产物缺引擎包、**不可直接运行** |
| `--no-minify` | 跳过 swc 压缩 |
| `--remote-upload-cmd <cmd>` | 远程 bundle 上传命令（CI）。构建末尾对 `out/remote` 执行，注入 `CFB_REMOTE_DIR`/`CFB_OUT`/`CFB_PLATFORM`；成功后移除 `remote/` |
| `--keep-remote` | 上传后保留 `out/remote`（默认移除） |
| `-h, --help` | 帮助 |

退出码：有 bundle 装配失败时为 **1**。

---

## 6. 引擎包（`--engine-pack`）

工具不自产引擎/适配层。**首次**用编辑器或官方流程构建一次得到 `build/<platform>/`，之后把它作为
引擎包复用：工具会从中拷贝 `adapter-min.js`、`cocos/`、`src/assets/`、`hook.js`。

- **引擎升级后**重新产一次即可。
- 省略 `--engine-pack` 时构建仍跑完（用于校验序列化/装配），但产物缺引擎包、不能直接运行，
  汇总会打印 `⚠ 未提供 enginePack`。

---

## 7. 项目配置 `cfb.config.json`

放在 **cocos 项目根**，覆盖平台/项目级设置（优先级：`CFB_* 环境变量 > cfb.config.json > 内置默认`）：

```json
{
  "platform": "wechatgame",
  "projectName": "my-game",
  "libVersion": "3.8.9",
  "bootExtras": [
    { "global": "MinigameRtc", "module": "./src/assets/Script/Lib/RTC/minigame-rtc.min.js" }
  ],
  "remoteUploadCmd": "bash ./scripts/upload-remote-bundle.sh"
}
```

| 字段 | 含义 | 缺省 |
|------|------|------|
| `platform` | 目标平台 | `wechatgame` |
| `projectName` | 写入 `project.config.json` 的 projectname | 项目目录名 |
| `libVersion` | 微信开发者工具 libVersion | `3.8.9` |
| `bootExtras` | game.js 启动注入的项目级 plugin 全局（`window.<global> = require(<module>)`）| `[]` |
| `remoteUploadCmd` | 远程 bundle 上传命令（CLI `--remote-upload-cmd` 优先）| 无 |

> `mainCompressionType`（主包是否打成 `subpackages/main` 分包以绕开微信主包 4MB 上限）从项目
> `settings/builder.json` 读取，无需在此配置。

---

## 8. CI / Jenkins 示例

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

远程包上传：配 `--remote-upload-cmd`（或 `cfb.config.json` 的 `remoteUploadCmd`），构建末尾若
`out/remote` 非空则执行，注入 `CFB_REMOTE_DIR`/`CFB_OUT`/`CFB_PLATFORM`；OSS/CDN 细节由该命令负责。

---

## 9. 产物结构

```
build/fast-<platform>/
├── game.js / main.js / ccRequire.js   启动样板
├── game.json / project.config.json    平台配置
├── adapter-min.js / cocos/ / hook.js  引擎/适配层(来自 --engine-pack)
├── src/settings.js                    全局 settings
├── assets/<bundle>/                   内置 bundle：main / resources / internal
├── subpackages/<bundle>/              微信分包
└── remote/<bundle>/                   远程包(若有；上传后默认移除)
```

每个 bundle = `config.<md5>.json` + 脚本包(`index.js`/`game.js`) + `import/`(序列化资源) +
`native/`(原始资源)。详见 [DEVELOPMENT.md §1](DEVELOPMENT.md)。

---

## 10. 适用范围与已知限制

- **平台**：微信（`wechatgame`）、抖音（`bytedance`）。
- **Cocos 版本**：序列化格式对照 **2.4.13** 逆向；其它 2.x 小版本跨版本前请用真实项目回归。
- **已知缺口**：少量高级类型序列化延后；packs（JSON 合并）暂不做（不影响加载）；个别 bundle 与官方
  config 仍有结构差异。**生产前建议在小游戏开发者工具验证一次预览构建。**

---

## 11. 故障排查

| 现象 | 排查 |
|------|------|
| 产物不能运行 / 缺 `cocos/`、`adapter-min.js` | 没传 `--engine-pack`，或引擎包目录不含这些文件 |
| 真机加载报 `readFile:fail subpackages/.../<uuid>.json` | 归属/redirect 问题，跑 `npm run verify:regression` 看依赖自洽 |
| 某组件运行时字段为 null / `_renderComponent` 崩 | 新增 `@property` 未进注册表——构建时 classMeta 会自动增补，若仍崩检查脚本是否在 `assets/` 下 |
| 图集精灵显示错乱 / native png 404 | 图集未 temp 缓存或 atlasPack 缓存陈旧，删 `.atlas-cache/` 重跑 |
| `npx tsc` 类型检查报错 | `npx tsc` 解析到的是脚本编译用的 4.1.3；类型检查用 `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck` |

---

## 12. 开发者自检命令

| 命令 | 作用 |
|------|------|
| `npm run validate:all` | 全量 import 文件重建 + 引擎反序列化深比较 |
| `npm run verify:regression` | 真机不变量回归（健全性/无埋引用/依赖自洽/跳过收敛）|
| `npx tsx src/spikes/formal-build.ts` | 与官方 build 逐 bundle oracle 对照 |
| `npm run spike1b` / `spike2:batch` | 叶子资源字节对齐 / 对象图语义等价 |
| `npm run scripts:pack` / `game:template` / `atlas:pack` | 单子系统验证 |

更多见 [package.json](../package.json) 的 `scripts` 与 [DEVELOPMENT.md §4](DEVELOPMENT.md)。
</content>
