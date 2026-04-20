// test/runTest.ts
// 仓库的测试是一组 Mocha (tdd UI) 测试。许多测试间接导入 `vscode`,
// 只能在扩展宿主里跑(有 @vscode/test-electron 可接入,但该项目目前没用)。
// 本 runner 只跑不依赖 vscode 的 test 文件,它们覆盖了 storage / sync /
// worker pool / parser 等非 UI 路径,也就是 streaming shard-write 重构影响的所有表面。
//
// VSCODE_HOST_SUITE=1 时跑全部文件,用于日后接入 test-electron 再扩展。
import * as path from 'path';
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mocha = require('mocha');

// 需要 vscode 运行时的测试——在纯 Node 下必然失败
const VSCODE_ONLY_TESTS = new Set<string>([
    'commands.test.js',
    'composition.test.js',
    'navigation.test.js',
    'searchEngine.test.js',
    'searchEngineAbort.test.js',
    'searchEngineParsing.test.js',
    'symbolIndexFacade.test.js',
]);

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true });
    const testsRoot = path.resolve(__dirname, 'suite');
    const includeHost = process.env.VSCODE_HOST_SUITE === '1';

    return new Promise<void>((resolve, reject) => {
        const files = fs.readdirSync(testsRoot)
            .filter((f: string) => f.endsWith('.test.js'))
            .filter((f: string) => includeHost ? true : !VSCODE_ONLY_TESTS.has(f));
        files.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));

        mocha.run((failures: number) => {
            if (failures > 0) {
                reject(new Error(`${failures} tests failed.`));
            } else {
                resolve();
            }
        });
    });
}

// 直接 node 执行时自调用(之前的版本只 export 就结束了,所以 npm test 是个空操作)。
if (require.main === module) {
    run().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(err);
        process.exit(1);
    });
}
