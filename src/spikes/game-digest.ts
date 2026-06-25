import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeGameTemplate } from "../game.js";
import { crawl } from "../crawl.js";
import { PROJECT_ROOT } from "../paths.js";
// 用真实 bundleVers 占位(顺序无关,这里给每个 bundle 一个稳定假 md5 仅测模板生成)
const vers: Record<string,string> = {};
for (const b of crawl().bundles) vers[b.name] = "deadbeef";
const out = join(PROJECT_ROOT, "build/_game-digest");
rmSync(out, { recursive: true, force: true });
writeGameTemplate(out, { bundleVers: vers });
const files = readdirSync(out, { recursive: true } as any).filter((f:any)=>{try{return readFileSync(join(out,f));}catch{return false}});
const lines:string[]=[];
const walk=(d:string,pre=""):void=>{for(const e of readdirSync(d,{withFileTypes:true})){if(e.isDirectory())walk(join(d,e.name),pre+e.name+"/");else lines.push(pre+e.name+":"+createHash("md5").update(readFileSync(join(d,e.name))).digest("hex"))}};
walk(out);
console.log("digest=" + createHash("md5").update(lines.sort().join("\n")).digest("hex"));
for (const l of lines.sort()) console.log("  "+l);
rmSync(out, { recursive: true, force: true });
