# Bundle 组装与 config.json —— spike 3

## 结论:组装层打通

最小自洽 bundle 端到端组装验证(`npm run spike3`):选取已字节对齐的叶子资源 →
生成 `import/` + `native/` + `config.<md5>.json`,结果:

- import 文件与真实产物**逐字节一致**;
- **md5 命名正确**(文件名 hash = `md5(文件内容)` 前 5 位,import/native/config 同);
- `config.versions` 引用的文件齐全、config 自身 md5 正确。

序列化(spike 1/2)+ 组装(spike 3)= 单资源到完整 bundle 产物的链路已贯通。

## md5 命名规则

```
import:  import/<2hex>/<uuid>.<md5>.json       md5 = md5(content)[:5]
native:  native/<2hex>/<uuid>.<md5>.<ext>      md5 = md5(rawBytes)[:5]
config:  config.<md5>.json                     md5 = md5(content)[:5]
```
native 原始文件在 `library/imports/<2hex>/<uuid>.<ext>`(与 import json 同目录的非 .json 同名文件)。

## config.json 字段语义(实测自 assets/resources)

```jsonc
{
  "uuids":   ["压缩uuid", ...],          // bundle 内资源;下方所有 index 指这里的下标
  "paths":   { "0": ["images/loading_bg", 2], "5": ["images/loading_bg", 1, 1] },
                                          // 可寻址资源:index -> [路径(无扩展), typeIndex, 子资源标记?]
                                          // 同一路径可映射多个资源(Texture2D + SpriteFrame + Material)
  "types":   ["cc.EffectAsset","cc.SpriteFrame","cc.Texture2D","cc.Material"], // paths[*][1] 索引
  "scenes":  { "db://.../X.fire": uuidIndex },
  "packs":   { "<packId>": [uuidIndex, ...] },  // 合并 import 文件:多个小资源并入一个 pack json
  "redirect":[uuidIndex, depBundleIndex, ...],  // 该资源实际在 deps[depBundleIndex] 里
  "deps":    ["resources","internal"],          // 依赖的其它 bundle
  "name":"resources", "importBase":"import", "nativeBase":"native",
  "debug":false, "isZip":false, "encrypted":false,
  "versions":{
    "import":[uuidIndex|packId, "md5", ...],     // 每个独立 import 文件 + 每个 pack 文件;被 pack 的资源不单列
    "native":[uuidIndex, "md5", ...]
  }
}
```
- **packs**:编辑器把多个小 import json 合并成 pack 文件减请求数;被合并的资源在 `versions.import` 里只出现 packId,不单列。**可选优化**——不合并(全独立)也是合法 config。
- **paths**:仅 resources/可寻址 bundle 需要;按 uuid 加载的分包可为空。
- 纯脚本 bundle:除 `name` 外几乎全空。

## 脚本包(index.js / game.js)

标准 browserify CommonJS bundle(`window.__require=function...({modules})`)。
即使无用户脚本也有 ~8KB 的 runtime shim + 共享模块。

## 距离"完整可用构建器"还差的子系统(均与序列化解耦)

| 子系统 | 作用 | 难度 |
|--------|------|------|
| **依赖爬取** | 从场景/预制体爬可达资源,定 bundle 成员 + redirect + deps | ★★★★ |
| **paths 推导** | 由 meta/资源路径生成可寻址 paths + types | ★★ |
| **packs 分组** | 小 import 合并成 pack(group-manager 启发式);可先不做 | ★★★ |
| **脚本打包** | 收集 bundle 脚本 → browserify;可复用 temp/quick-scripts | ★★ |
| **game 级样板** | settings.js / game.json / 引擎 js / adapter / main.js | ★★ |
| **构建编排** | 增量(mtime/hash diff)+ 并行(worker_threads),省时核心 | ★★★ |

> 序列化(最大风险)已验证;以上为工程组装,无格式逆向难点。SpriteAtlas/EffectAsset 归到资源处理阶段。
