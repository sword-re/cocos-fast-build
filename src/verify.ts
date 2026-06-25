/**
 * 字节级校验:把自研序列化产物与真实 build 产物逐字符对比。
 * 产物 JSON 用紧凑格式(无空格),与 cocos 一致。
 */
import { readFileSync } from "node:fs";

export function stringify(data: unknown): string {
    return JSON.stringify(data);
}

export interface DiffResult {
    equal: boolean;
    firstDiffAt?: number;
    expected: string;
    actual: string;
    expectedSnippet?: string;
    actualSnippet?: string;
}

export function byteDiff(actual: unknown, expectedFile: string): DiffResult {
    const actualStr = stringify(actual);
    const expectedStr = readFileSync(expectedFile, "utf8");
    if (actualStr === expectedStr) {
        return { equal: true, expected: expectedStr, actual: actualStr };
    }
    let i = 0;
    const n = Math.min(actualStr.length, expectedStr.length);
    while (i < n && actualStr[i] === expectedStr[i]) i++;
    const around = (s: string, at: number) => s.slice(Math.max(0, at - 30), at + 30);
    return {
        equal: false,
        firstDiffAt: i,
        expected: expectedStr,
        actual: actualStr,
        expectedSnippet: around(expectedStr, i),
        actualSnippet: around(actualStr, i),
    };
}

export function printDiff(label: string, d: DiffResult): boolean {
    if (d.equal) {
        console.log(`✅ ${label}: 字节级一致 (${d.actual.length} bytes)`);
        return true;
    }
    console.log(`❌ ${label}: 不一致,首个差异在第 ${d.firstDiffAt} 字符`);
    console.log(`   expected: ...${d.expectedSnippet}...`);
    console.log(`   actual  : ...${d.actualSnippet}...`);
    return false;
}
