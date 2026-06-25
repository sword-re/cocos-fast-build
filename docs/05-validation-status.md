# 全量正确性校验状态 —— 序列化基线

`npm run validate:all` 对 build 里**全部 1024 个 import 文件**尝试用我们的序列化器重建,
再经引擎 `cc._deserializeCompiled` 反序列化深比较(排除运行时随机 `_id`)。

## 覆盖与结果

| 类别 | 数量 | 状态 |
|------|------|------|
| 序列化成功、0 错误 | 723 | — |
| ├ 与真实产物**逐字节一致**(非图集叶子资源) | 165 | ✅ |
| ├ 对象图(prefab/scene)语义一致 | ~187 | ✅ |
| └ **图集 spriteframe** | ~371 | ❌ 见下 |
| pack 合并文件(暂不支持) | 270 | ⏳ |
| deferred(SpriteAtlas/EffectAsset) | 31 | ⏳ |

> 非图集的序列化(对象图 + 叶子)已全面正确。

## 唯一的序列化正确性缺口:图集 spriteframe

图集内的 spriteframe,真实产物与我们的差异:
- `texture` 指向**图集大图**(real 用合成 id 如 `1252b8d48`),我们指向原图;
- `rect` 是图集内坐标(real 改写过),`_rotated` 可能为 true(我们恒 false)。

**纠缠两个子系统:**
1. **图集打包几何**:每帧的图集坐标/旋转/trim —— 数据已在
   `temp/TexturePacker/build/native/.../*.pac/info.json` 的 `result.atlases[].files[]`,**可复用缓存**。
2. **合成纹理 id**:图集大图作为 pack/group 资源,用 hash 生成 9 位 id(与 config.packs 的 packId 同源)。
   复现需 **packs/group 子系统**(group-manager 的分组 + id 哈希算法)。

## 距离"一次完整正确打包"的剩余工作

| 子系统 | 必需性 | 难度 | 备注 |
|--------|--------|------|------|
| 图集帧重写 + 合成纹理 id | 必需(否则图集显示错乱) | ★★★★ | 与 packs 共用合成 id |
| packs 分组 + pack 文件生成 | 可选(不合并也合法,但图集 id 依赖它) | ★★★★ | |
| 依赖爬取(成员/redirect/deps) | 必需 | ★★★★ | |
| paths 推导 | resources 类必需 | ★★ | |
| 脚本打包(browserify) | 必需 | ★★ | 可复用 temp/quick-scripts |
| game 样板(settings.js/game.json/引擎) | 必需 | ★★ | 多为静态/可复用 |

## 路线选择(见对话)

- **方案 H(混合,最快达成一次正确打包)**:图集/packs/脚本/样板复用 cocos 缓存或现有产物,
  我们的快序列化器负责 prefab/scene/叶子资源;先得到可加载的完整包,再逐步替换。
- **方案 F(全自研)**:实现图集打包 + 合成 id + 依赖爬取 + 脚本 + 样板,真正不依赖 cocos;多轮工作量。
