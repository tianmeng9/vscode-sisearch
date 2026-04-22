const fs = require('fs');
const path = require('path');

const wasmDir = path.join(__dirname, '..', 'wasm');
if (!fs.existsSync(wasmDir)) {
    fs.mkdirSync(wasmDir, { recursive: true });
}

const mediaDir = path.join(__dirname, '..', 'media');
if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
}

const files = [
    ['node_modules/web-tree-sitter/web-tree-sitter.wasm', 'wasm/web-tree-sitter.wasm'],
    ['node_modules/tree-sitter-c/tree-sitter-c.wasm', 'wasm/tree-sitter-c.wasm'],
    ['node_modules/tree-sitter-cpp/tree-sitter-cpp.wasm', 'wasm/tree-sitter-cpp.wasm'],
    // VS Code codicon font for the in-panel find widget. Shipped into media/
    // so the results-webview stylesheet can @font-face it without adding a
    // second localResourceRoots entry.
    ['node_modules/@vscode/codicons/dist/codicon.ttf', 'media/codicon.ttf'],
    ['node_modules/@vscode/codicons/dist/codicon.css', 'media/codicon.css'],
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
