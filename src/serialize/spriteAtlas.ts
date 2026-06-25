/**
 * cc.SpriteAtlas 序列化。
 * _spriteFrames 是 Dict<name, SpriteFrame 资源引用>。library 里 SpriteAtlas 是空壳
 * (成员 build 时生成),故由调用方传入(name, spriteFrameUuid)有序列表。
 *
 * 真实产物结构(N 个成员):
 *   [1, [N 压缩uuid], [N 名字], [["cc.SpriteAtlas",["_spriteFrames"],3,11]], [[0,0,1]],
 *    [[0,[{}, name0,6,0, name1,6,1, ...]]], 0, 0, [0×N], [0..N-1], [0..N-1]]
 *  - instance:类0(SpriteAtlas),_spriteFrames = dict(空模板 {} + 每项 name,6,depIdx)
 *  - depIdx → dependObjs/Keys/UuidIndices 第 i 项:obj=实例0,key=i,uuid=sharedUuids[i]
 */
import { compressUuid } from "../uuid.js";
import { FORMAT_VERSION, type IFileData } from "../format.js";

export interface AtlasMember {
    uuid: string; // SpriteFrame uuid
    name: string; // 帧名(_spriteFrames 的 key)
}

export function serializeSpriteAtlas(members: AtlasMember[]): IFileData {
    const n = members.length;
    const sharedUuids = members.map((m) => compressUuid(m.uuid));
    const sharedStrings = members.map((m) => m.name);
    const dict: unknown[] = [{}];
    for (let i = 0; i < n; i++) dict.push(members[i].name, 6, i);

    return [
        FORMAT_VERSION,                                   // 0 Version
        sharedUuids,                                      // 1 SharedUuids
        sharedStrings,                                    // 2 SharedStrings
        [["cc.SpriteAtlas", ["_spriteFrames"], 3, 11]],   // 3 SharedClasses
        [[0, 0, 1]],                                      // 4 SharedMasks
        [[0, dict]],                                      // 5 Instances
        0,                                                // 6 InstanceTypes
        0,                                                // 7 Refs
        members.map(() => 0),                             // 8 DependObjs(均指实例0)
        members.map((_, i) => i),                         // 9 DependKeys
        members.map((_, i) => i),                         // 10 DependUuidIndices
    ] as unknown as IFileData;
}
