/** 压缩 uuid 编解码自测(已知样本 + 往返) */
import { compressUuid, decompressUuid } from "../uuid.js";

const cases: Array<[string, string]> = [
    ["c8435d84-eab3-4a32-979f-28e7520e2395", "c8Q12E6rNKMpefKOdSDiOV"],
    ["0eee16fe-7913-42ba-a080-e00a95b553cc", "0e7hb+eRNCuqCA4AqVtVPM"],
];

let ok = true;
for (const [uuid, expected] of cases) {
    const got = compressUuid(uuid);
    const back = decompressUuid(got);
    const pass = got === expected && back === uuid;
    ok = ok && pass;
    console.log(`${pass ? "✅" : "❌"} ${uuid}`);
    console.log(`   compress -> ${got} (expect ${expected})`);
    console.log(`   decompress -> ${back}`);
}
console.log(ok ? "\n全部通过" : "\n存在失败");
process.exit(ok ? 0 : 1);
