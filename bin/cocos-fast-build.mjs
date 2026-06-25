#!/usr/bin/env node
/**
 * cocos-fast-build CLI 可执行入口。
 *
 * 工具源码是 TS,运行时用 tsx 直接加载(免预编译 dist)。tsImport 把 TS 加载器
 * 限定在本次导入,不污染全局。cli.ts 的 main() 在导入时执行。
 */
import { tsImport } from "tsx/esm/api";

await tsImport("../src/cli.ts", import.meta.url);
