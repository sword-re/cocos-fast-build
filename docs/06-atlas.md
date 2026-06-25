# 图集 / 纹理打包 —— 设计与缓存复用

## 两类"图集"要分清

全量校验里 370 个 spriteframe 与真实不同,实际是**两种不同机制**:

| 机制 | 数量 | 我们的现状 | 处理 |
|------|------|-----------|------|
| **自动图集(AutoAtlas / .pac)** | 313 | ❌ 错(指向原纹理+原坐标;原纹理被打进大图、不单独 ship) | **必须重写**(复用缓存) |
| **texture-pack 合并**(独立小纹理被 cocos 合进 pack) | 57 | ✅ 实际正确(原纹理仍存在,我们不合并、直接指向独立纹理) | 不合并即可,后续可选优化 |

> 关键结论:**缓存 100% 覆盖了"必须重写"的 313 个自动图集帧**;57 个 texture-pack 帧按"不合并"输出就是合法可加载的(只是少了合并优化,多几个文件)。

## 自动图集:复用 cocos 缓存

cocos 把每个 `.pac` 的打包结果缓存在
`temp/TexturePacker/build/native/<...>.pac/info.json` 的 `result` 里:
- `result.atlases[].imagePath`:打包后大图 png(可直接作 native 复用)。
- `result.atlases[].files[]`:每帧几何,其中 **`uuid` = SpriteFrame 的 uuid**(已验证),
  含 `textureUuid`(原图)、`x/y`(大图内位置)、`width/height`、`rotatedWidth/Height`(判断旋转)、
  `trim`(裁剪框)、`rawWidth/Height`(原图尺寸)。

解析器:`src/atlas.ts` → `atlasFrameMap(): Map<spriteFrameUuid, AtlasFrame>`(共 1105 条记录)。

## 自洽 id(不复现 cocos 哈希)

cocos 把图集大图作为 **pack/group 资源**,用 9 位 hash 合成 id(如 native 文件名 `1d0edef2f.da5af.png`、
spriteframe 指向的 texture id `1252b8d48`)。该哈希算法在加密代码里,**不复现**——
我们给每张图集大图分配**自洽 id**(如基于 .pac uuid 派生),保证:
spriteframe.texture 引用 ↔ 图集 Texture2D import ↔ native png 名 ↔ config 四处一致即可正确加载。
(代价:产物 id 与 cocos 不同,不影响运行;热更 diff 会变大,首次全量构建无碍。)

## 实现计划(自动图集重写)

1. 每个 .pac → 生成一张图集 Texture2D(自洽 uuid)+ 复制其打包 png 为 native。
2. 每个成员 spriteframe → 重写 content:`texture` = 图集纹理 id,`rect` = 大图内坐标
   (由 `x/y + trim` 推算),`offset` = trim 偏移,`rotated` = 是否旋转,`originalSize` = rawWidth/Height。
3. 原成员纹理不再单独 ship(已并入大图)。
4. SpriteAtlas(.pac 对应的 cc.SpriteAtlas)`_spriteFrames` = {name: spriteframe} 字典(Dict+AssetRef)。

### 已标定并验证的公式(312/313 几何与真实一致)

spriteframe content(顺序固定 `{name, rect, offset, originalSize, [rotated], capInsets}`):
- `rect = [trim.x, trim.y, trim.width, trim.height]`(缓存,大图内坐标;旋转时仍用非旋转宽高)
- `rotated: 1` 仅当缓存 rotated=true(否则省略该键)
- `name / offset / originalSize / capInsets`:取自**原始 spriteframe(library)的 content**(内在属性,缓存给不出 offset)
- `texture`:自洽图集大图 id = `atlasTextureUuid(frame)`(md5(打包大图路径)→uuid 形)

校验:`npm run atlas:verify` → 312/313 content 完全一致;1 例因 library meta 陈旧(originalSize 差 1px)忽略。
实现:`src/atlas.ts`(缓存解析 + atlasTextureUuid)、`src/serialize/spriteFrame.ts`(图集感知)。

### 待做(装配,并入完整构建器阶段)

1. **图集大图 Texture2D**:每张大图生成一个 Texture2D import(content 形如 `"0,9729,9729,33071,33071,1,0,1"`,
   **premultiplyAlpha=1**——result.premultiplyAlpha 为 true,影响渲染),native 依赖 = 复用 `result.atlases[].imagePath` 的打包 png。
2. **SpriteAtlas 资产**:`_spriteFrames` = {帧名: spriteframe}(Dict + AssetRef)。
3. **原成员纹理**不再单独 ship(已并入大图);依赖爬取阶段据图集成员剔除。
4. 自洽 id 四处一致(spriteframe.texture ↔ 大图 Texture2D ↔ native png 名 ↔ config)。
