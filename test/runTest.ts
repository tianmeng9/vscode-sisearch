// test/runTest.ts
import * as path from 'path';
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mocha = require('mocha');

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true });
    const testsRoot = path.resolve(__dirname, 'suite');

    return new Promise<void>((resolve, reject) => {
        const files = fs.readdirSync(testsRoot).filter((f: string) => f.endsWith('.test.js'));
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
