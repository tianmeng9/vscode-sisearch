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

## M9 trial-package findings

Local `npx @vscode/vsce package` run (2026-04-22):

- VSIX size: **12 MB** (2666 files) — down from an accidental 31 MB when
  `.worktrees/` leaked in.
- `.vscodeignore` now excludes `.worktrees/`, `.sisearch/`, `docs/`,
  `scripts/`, `BUILD.md`, dev-only `node_modules` (typescript, @types,
  mocha, @vscode/test-electron, @vscode/vsce, @electron/rebuild), plus
  better-sqlite3 `deps/` / `src/` / `docs/` / `benchmark/`.
- Bundled `better_sqlite3.node` is the **Node build** (2.0 MB), not Electron
  — sufficient for VSIX-shape validation (this task) but end users will need
  a matching Electron prebuild. That is delivered by the GitHub Actions
  matrix in `.github/workflows/prebuild.yml`, not by this local package.
- Warnings at pack time (non-fatal, tracked for real publish):
  - `LICENSE / LICENSE.md / LICENSE.txt not found` — add a LICENSE file
    before `vsce publish`.
  - 426 JS files, no bundler — Marketplace performance nag; bundling with
    esbuild / webpack is a future optimization, not a blocker.
- Added to `package.json`: `repository` field pointing at
  `https://github.com/tianmeng9/vscode-sisearch.git` (vsce requires it for
  publish). URL is a placeholder — confirm the real repo URL before publish.
- `.vsix` is already excluded from git via `.gitignore`.

### Before running `vsce publish`

1. Add a `LICENSE` file at repo root.
2. Confirm `repository.url` in `package.json` points at the real GitHub repo.
3. Replace the local-Node `.node` with matching Electron prebuilds from the
   CI matrix (see *CI release workflow* above) — don't publish the local
   VSIX, it won't load in VS Code.
