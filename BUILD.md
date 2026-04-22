# Build & Release

SI Search depends on `better-sqlite3`, a native module. The version shipped to
each end user must match their VS Code Electron ABI, so releases are packaged
per-platform via a GitHub Actions matrix.

## Local development

```bash
npm install            # runs better-sqlite3 build for local Node
npm run compile        # tsc
npm test               # downloads VS Code test runner, which triggers rebuild
```

If a VS Code Electron upgrade breaks the module locally:

```bash
npm run rebuild-electron   # @electron/rebuild against installed VS Code
```

Fallback command available inside VS Code: `SI Search: Rebuild Native (SQLite)`.

## CI release workflow

1. Push a tag starting with `v` (e.g. `git tag v1.0.1 && git push --tags`),
   or manually trigger the `Prebuild Native Modules` workflow via the
   GitHub Actions UI (`workflow_dispatch`).
2. The matrix builds 4 VSIX files (linux-x64, darwin-x64, darwin-arm64,
   win32-x64). Each bundles its own rebuilt `better-sqlite3.node`.
3. Download the VSIX artifacts from the workflow run.
4. Publish each one:

   ```bash
   npx @vscode/vsce publish --packagePath sisearch-linux-x64.vsix
   npx @vscode/vsce publish --packagePath sisearch-darwin-x64.vsix
   npx @vscode/vsce publish --packagePath sisearch-darwin-arm64.vsix
   npx @vscode/vsce publish --packagePath sisearch-win32-x64.vsix
   ```

   Marketplace routes each user to the VSIX matching their platform.

## Manual smoke test on a platform

```bash
npm run rebuild-electron
npm run package
code --install-extension sisearch-*.vsix
```

## Known limits

- Electron target version in `.github/workflows/prebuild.yml` is a placeholder
  (`34.0.0`); update when `engines.vscode` moves.
- `linux-arm64` and `win32-arm64` are not yet built. Users on those platforms
  must fall back to the `SI Search: Rebuild Native (SQLite)` command after
  install, or use the universal VSIX (no native rebuild).
