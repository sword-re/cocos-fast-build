/**
 * cocos-fast-build CLI(跨平台,Jenkins 可下载即用)。
 *
 * 关键:本文件只静态 import node 内置;先解析参数 + 设 CFB_* 环境变量,再**动态 import**
 * 构建模块——这样 paths.ts/config.ts 在加载时即读到正确的 projectRoot/platform。
 *
 * 用法:
 *   tsx src/cli.ts --project <cocos项目根> [--platform wechatgame] [--out <目录>]
 *                  [--engine-pack <一份官方build目录>] [--no-minify]
 */
import { resolve } from "node:path";

interface Args {
    project: string;
    platform?: string;
    out?: string;
    enginePack?: string;
    minify: boolean;
    help: boolean;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { project: process.cwd(), minify: true, help: false };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        const next = () => argv[++i];
        switch (v) {
            case "-h":
            case "--help":
                a.help = true;
                break;
            case "--project":
            case "-p":
                a.project = resolve(next());
                break;
            case "--platform":
                a.platform = next();
                break;
            case "--out":
            case "-o":
                a.out = resolve(next());
                break;
            case "--engine-pack":
                a.enginePack = resolve(next());
                break;
            case "--no-minify":
                a.minify = false;
                break;
            default:
                if (v.startsWith("-")) throw new Error(`未知参数: ${v}`);
        }
    }
    return a;
}

const HELP = `cocos-fast-build —— 脱离编辑器的 cocos 2.x 小游戏快速构建

用法:
  cocos-fast-build --project <cocos项目根> [选项]
  (源码运行: npx tsx src/cli.ts --project <cocos项目根> [选项])

选项:
  -p, --project <dir>     cocos 项目根目录(含 assets/ 与 library/imports/)。默认当前目录
      --platform <name>   目标平台,目前仅 wechatgame(默认)
  -o, --out <dir>         产物目录。默认 <project>/build/fast-<platform>
      --engine-pack <dir> 引擎/plugin 拷贝来源(一份现成官方 build);省略则产物缺引擎包
      --no-minify         跳过 swc 压缩
  -h, --help              显示帮助

项目可放 cfb.config.json(项目根)覆盖 platform/projectName/libVersion/bootExtras。`;

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(HELP);
        return;
    }
    // 先注入环境变量,再动态 import 构建模块(paths.ts 加载时即读到)
    process.env.CFB_PROJECT_ROOT = args.project;
    if (args.platform) process.env.CFB_PLATFORM = args.platform;

    const { runBuild } = await import("./orchestrate.js");
    const r = await runBuild({ out: args.out, enginePack: args.enginePack, minify: args.minify });
    if (r.skipped > 0) process.exitCode = 1;
}

main().catch((e) => {
    console.error("✗ 构建失败:", e instanceof Error ? e.message : e);
    process.exit(1);
});
