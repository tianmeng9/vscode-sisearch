const fs = require('fs');
const path = require('path');

const wasmDir = path.join(__dirname, '..', 'wasm');
if (!fs.existsSync(wasmDir)) {
    fs.mkdirSync(wasmDir, { recursive: true });
}

const files = [
    ['node_modules/web-tree-sitter/web-tree-sitter.wasm', 'wasm/web-tree-sitter.wasm'],
    ['node_modules/tree-sitter-c/tree-sitter-c.wasm', 'wasm/tree-sitter-c.wasm'],
    ['node_modules/tree-sitter-cpp/tree-sitter-cpp.wasm', 'wasm/tree-sitter-cpp.wasm'],
];

const root = path.join(__dirname, '..');
for (const [src, dest] of files) {
    const srcPath = path.join(root, src);
    const destPath = path.join(root, dest);
    if (!fs.existsSync(srcPath)) {
        console.error(`Missing: ${srcPath}`);
        process.exit(1);
    }
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied ${src} -> ${dest}`);
}
