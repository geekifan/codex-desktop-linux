# AGENTS.md

## Purpose

This repository adapts the official macOS ChatGPT Desktop DMG into a runnable
Linux app, packages it as `.deb`, `.rpm`, pacman, and AppImage artifacts, and
ships a local Rust update manager that can rebuild future Linux packages from
newer upstream DMGs.

The build flow: `install.sh` downloads/extracts `Codex.dmg`, patches the
extracted app through core and enabled Linux feature descriptors, rebuilds
native modules, downloads Linux Electron, stages bundled resources, writes
`codex-app/start.sh`, and lets package builders produce native artifacts or
AppImage. Native packages also include `codex-update-manager` and an
update-builder bundle.

## Remote Web Host Initiative

This fork is also the development base for an opt-in remote Web implementation
on branch `feature/remote-web-host`. The goal is to expose the existing Codex
Desktop renderer experience to a browser while retaining the real Linux
Electron main process and its complete App Host services.

### Confirmed Architecture

- Keep the patched `codex-desktop-linux` Electron main process. Do not recreate
  the Electron main API with Node.js stubs.
- Keep the upstream App Host RPC protocol opaque. Current upstream bundles run
  the RPC connection over a transport with `send`, `receive`, and `abort`; the
  MessagePort adapters exchange string frames and reject non-string messages.
- Replace only the outer MessagePort transport with a WebSocket-backed,
  MessagePort-compatible adapter. Do not parse, translate, or reimplement App
  Host service calls as `{ service, method, args }` requests.
- Use the browser and Electron main bundles from the exact same upstream DMG.
  Include the upstream build identity in the WebSocket handshake and reject a
  stale browser bundle rather than supporting cross-version RPC.
- Preserve bidirectional RPC. Renderer-owned services, callbacks, streams,
  reference counting, release, abort, and `onRpcBroken` must continue to use the
  upstream RPC implementation unchanged.
- App Host RPC is not the only Electron communication path. Bridge the small
  set of ordinary preload/IPC channels needed by the browser separately; do not
  mix their envelopes into opaque App Host RPC frames.

### Session Model

- Treat each independent browser tab or installed PWA instance as one remote
  surface session.
- Give each remote surface a distinct hidden Electron `WebContents` lifecycle
  owner. The upstream AppView registry is keyed by `webContents.id`; sharing one
  owner would let later clients overwrite earlier clients and would conflate
  subscriptions, presented state, downloads, notifications, and cleanup.
- Create hidden owners through the upstream window/window-context lifecycle
  where possible. Do not fake arbitrary `WebContents` objects.
- Frontend state is isolated per surface, including route, composer draft,
  selection, and sidebar state. Backend state remains shared through the same
  WindowContext, app-server connection registry, execution hosts, thread
  catalog, workspace files, local environments, SQLite state, and account.
- A short WebSocket reconnect must reattach to the existing RPC session,
  App Host, and hidden owner. Do not create a new RPC connection while the old
  connection still owns callbacks or remote references. After the resume grace
  period, abort and dispose the old session before creating a replacement.

### Development Boundaries

- Implement this work as an optional, disabled-by-default feature under
  `linux-features/remote-web-host/`. Browser-specific code stays in that
  feature directory.
- If the feature needs a core touchpoint, add only the smallest generic hook to
  core and keep WebSocket, authentication, browser shim, and session policy out
  of core.
- Reuse proven concepts from the sibling `codex-web` repository selectively:
  its reliable WebSocket bridge, browser Electron shim, HTTP/authentication
  server, PWA/mobile patches, and focused IPC tests. Do not import its Electron
  main-process stub architecture.
- Prefer one WebSocket connection per App Host RPC connection so RPC string
  frames can remain unwrapped. Authentication, connection identity, build
  identity, and resume metadata belong in the upgrade/handshake layer.
- Do not expose the Web endpoint without authentication. Remote access can run
  commands and read or modify files with the permissions of the desktop host.
- Do not add Web-native replacements for browser sidebar, clipboard, file
  picker, drag-and-drop, notifications, or Computer Use until a concrete
  required flow demonstrates that the transparent host bridge is insufficient.

### Upstream Version Policy

- Normal repository behavior follows the current DMG at the persistent
  upstream URL. During initial Web transport development, use an explicit DMG
  path or `CODEX_DMG_REFRESH_MODE=pinned` so transport regressions are not
  confused with upstream drift.
- Keep one known-good pinned-DMG test for local regression detection and one
  latest-DMG compatibility test for detecting changes to `connect-app-host`,
  MessagePort frame types, preload IPC channels, or bootstrap structure.
- Electron should continue to be detected from the DMG. Do not introduce a
  separate Web-specific Electron version pin.

### Web Acceptance Criteria

- The browser initializes the unmodified upstream App Host RPC client over the
  WebSocket transport and can invoke at least one callback-bearing service.
- Two simultaneous browser surfaces have different `webContents.id` owners,
  share persistent thread/backend data, and do not overwrite each other's
  AppView registrations or per-surface activity state.
- A transient network disconnect resumes without losing RPC references or
  duplicating processed frames; an expired session disposes all owner and RPC
  resources.
- A browser bundle from a different upstream build is rejected with a clear
  reload requirement.
- Existing native Electron launch behavior remains unchanged when the optional
  feature is disabled.

## Maintainer Rules

- This project supports only the latest upstream `CODEX.DMG`. When fixing
  upstream drift, remove old drift workarounds in the same change. Do not keep
  legacy DMG shapes, fallback patch paths, or version-specific compatibility
  branches around.
- Keep core behavior focused on the app launching and working for most Linux
  users. Experimental, workflow-specific, editor-specific, browser-specific,
  distro-specific, or minority-use integrations belong in `linux-features/` and
  must be disabled by default.
- If an optional feature needs a new core touchpoint, add the smallest generic
  extension point to core, then keep feature-specific logic inside that feature
  directory.
- Do not enable optional features in committed config. `linux-features/features.json`
  is local and gitignored; `features.example.json` stays empty.
- Each repository feature under `linux-features/<id>/` and each local feature
  under `linux-features/local/<id>/` must include a `README.md` next to
  `feature.json`.
- Do not manually patch generated output such as `codex-app/start.sh` for a
  durable fix. Change the source template, build helper, feature, or patch
  descriptor and regenerate.
- Treat updater, package builder, launcher, and feature framework changes as
  cross-format changes unless the code explicitly scopes them to one package
  format or desktop target.

## Issue And Pull Request Labels

- [`.github/labels.json`](.github/labels.json) is the source of truth for label
  names, colors, descriptions, groups, migrations, and retirements. Follow
  [label governance](docs/label-governance.md) when classifying an issue or
  pull request.
- Labels are staff-managed. Contributors without repository label permission
  do not determine their own labels. An agent without explicit delegated label
  authority may propose a classification to an authorized maintainer or
  collaborator, but it must not mutate repository labels.
- An authorized agent operation must show a read-only plan first and use the
  trusted manual workflow or `scripts/ci/manage-labels.js` with the required
  typed confirmation. Never run write-capable label code from a fork pull
  request or other untrusted ref.
- After triage starts, issues have one `type:`, one or more `area:`, and one
  active `status:` label. Pull requests have one `type:`, one or more `area:`,
  and one `risk:` label. Use multiple areas only for real ownership boundaries.
- Read native checks, draft state, mergeability, reviews, timestamps, and
  open/closed state directly from GitHub. Do not duplicate them with labels.
- `workflow: manual only` is a hard stop for item-specific automation: it may
  inspect the item but must not comment, edit, classify, close, or merge it.
  Only an owner-approved catalog migration declared in `.github/labels.json`
  may preserve an existing classification under a replacement name.
  `risk: low` never grants merge authority.
- Do not infer labels from a title alone. Preserve uncertainty with the
  appropriate triage status. Apply `resolution: duplicate` only after the
  canonical item is verified and linked.
- Never expose suspected secrets or an undisclosed vulnerability through a
  public label. Use `type: security` only for public hardening or an already
  disclosed concern.

## Source Routing

Use source files, not generated artifacts. Main routing:

- Launcher/webview: `launcher/start.sh.template`, `launcher/webview-server.py`.
- Packaged runtimes: `packaging/linux/codex-packaged-runtime.sh`,
  `packaging/appimage/codex-appimage-runtime.sh`.
- Build pipeline: `scripts/lib/*.sh`.
- Core patches: descriptors in `scripts/patches/core/**/patch.js`,
  implementations in `scripts/patches/impl/`, helpers in `scripts/patches/lib/`.
- Linux features: `linux-features/<id>/`.
- Package builders: `scripts/build-*.sh` and `scripts/lib/package-common.sh`.
- Updater: `updater/src/`.
- Upstream DMG automation: `scripts/automation/upstream-dmg-watchdog/` and
  `docs/upstream-dmg-watchdog.md`.
- Computer Use: `computer-use-linux/`; compositor backends under
  `computer-use-linux/src/windowing/backends/`.
- Nix: `flake.nix`, `flake.lock`, and `nix/`.

Detailed agent docs: [repository map](docs/agents/repository-map.md),
[generated/runtime notes](docs/agents/generated-and-runtime-notes.md), and
[validation playbook](docs/agents/validation-playbook.md).

Primary human docs: [architecture](docs/architecture.md),
[build and packaging](docs/build-and-packaging.md),
[native setup](docs/native-setup.md),
[Linux features](docs/linux-features-architecture.md),
[updater](docs/updater.md), [Linux Computer Use](docs/linux-computer-use.md),
[Record and Replay](docs/record-and-replay-linux.md),
[Nix](docs/nix.md), and [troubleshooting](docs/troubleshooting.md).

Repository governance: [issue and pull request labels](docs/label-governance.md).

## Patch And Feature Rules

- `scripts/patch-linux-window-ui.js` is the build-facing ASAR patcher CLI only.
  Do not import internals from it; use runner/helper APIs.
- Core patch descriptors are the source of truth for shipped Linux
  compatibility patches. Read `scripts/patches/core/README.md` before adding
  or moving descriptors.
- ASAR patches are fail-soft unless intentionally marked `required-upstream`.
  Each patch should be idempotent and report warnings when current upstream
  drift prevents a needle from matching.
- Patch reports are written for installs/rebuilds. Upstream-build CI fails only
  for required upstream patches that are missing or skipped.
- Do not recreate deleted compatibility barrels such as
  `scripts/patches/main-process.js`, `webview-assets.js`, or `shared.js`.
- Feature patching uses only `entrypoints.patchDescriptors`. Removed feature
  patch entrypoints such as `mainBundlePatch` and `entrypoints.patches` are not
  supported.
- Declarative feature `resources`, `runtimeHooks`, and `packageHooks` are
  preferred over ad hoc staging whenever possible.
- Feature resource targets must stay inside the app directory and cannot target
  the app root. Mode values must be quoted octal strings such as `"0644"` or
  `"0755"`.

## Important Runtime Behavior

- DMG extraction can warn when `7z` cannot materialize the `/Applications`
  symlink. This is acceptable if a `.app` bundle was extracted successfully.
- The managed Node.js runtime is installed under
  `codex-app/resources/node-runtime/`. If `CODEX_MANAGED_NODE_VERSION` or
  `CODEX_MANAGED_NODE_URL` is overridden, `CODEX_MANAGED_NODE_SHA256` must be
  set too.
- GUI launchers often do not inherit shell `PATH`. The generated launcher
  searches common Codex CLI and `nvm` locations and respects `CODEX_CLI_PATH`.
- CLI preflight is launcher-scoped and normally best-effort. A detected npm CLI
  missing its required Linux optional dependency is the exception: the launcher
  performs one bounded synchronous repair and blocks Electron startup if that
  repair fails or times out, because the known-broken CLI cannot serve the app.
- The generated launcher starts the local webview server before Electron and
  verifies the expected startup markers. See
  [webview server evaluation](docs/webview-server-evaluation.md) before
  changing the server model.
- Warm-start handoff uses a Unix-domain socket under `$XDG_RUNTIME_DIR` so
  second launches can send actions to the running app.
- Linux Computer Use plugin registration is default-on platform port glue, but
  Computer Use UI enablement remains opt-in and must not bypass upstream
  server-side rollouts unrelated to local Linux support.
- The Linux Chrome integration patches staged bundled resources. Do not fix
  only the user cache.
- Native package install/removal hooks start, stop, disable, and reload the
  `systemd --user` updater service on a best-effort basis.
- Failed privileged updater installs stay failed until a newer rebuild or an
  explicit retry path; avoid auto-retrying every reconcile cycle.
- Automated user-local updater paths must force acceptance and running-app
  overrides off. They may build alongside a running app, but promotion must
  wait for exit or fail without replacing the installed runtime.
- Transactional app promotion retains only the immediately previous managed
  app backup; older exact managed backups are pruned under the promotion lock.
- Manual rollback uses the last-known-good package recorded in updater state
  and the same format-specific command layer as normal installs.
- Local installs, updater rebuilds, and scheduled CI use the same upstream DMG
  acceptance profile. Build into a sibling candidate and promote it only after
  an `accepted` or `accepted_with_warnings` verdict. Only user-enabled Linux
  features participate in local/updater acceptance, and drift in any enabled
  feature rejects the candidate. Disabled features are not probed. Rejected or
  inconclusive candidates must not replace the working app.
- Existing local apps are promoted with atomic directory exchange and a durable
  recovery journal. Do not reintroduce a two-rename window in which the
  canonical install path is absent, and do not fall back when the filesystem
  lacks atomic exchange support.

## Generated Artifacts

Treat these as generated or local runtime state, not primary source:
`codex-app/`, `codex-app-next/`, `.codex-app.candidate-*`, `codex-*-app/`, `dist/`,
`dist/appimage.AppDir/`, `dist-next/rebuild/`, `target/`, `Codex.dmg`,
`linux-features/features.json`, `linux-features/local/`,
`codex-app/.codex-linux/linux-features-staged.json`, updater config/state/log
files under `~/.config`, `~/.local/state`, and `~/.cache`, launcher state under
`~/.cache/codex-desktop` and `~/.local/state/codex-desktop`, and
`$XDG_RUNTIME_DIR/codex-desktop/launch-action.sock`.

See [generated and runtime notes](docs/agents/generated-and-runtime-notes.md)
for details.

## Common Commands

Regenerate the Linux app: `./install.sh ./Codex.dmg` or `./install.sh`.
Guided native setup/install/update: `make setup-native`,
`make bootstrap-native`, `make install-native`, `make update-native`.

Build native packages:

```bash
./scripts/build-deb.sh
./scripts/build-rpm.sh
./scripts/build-pacman.sh
./scripts/build-appimage.sh
```

Side-by-side rebuild candidate: `./scripts/rebuild-candidate.sh` or
`./scripts/rebuild-candidate.sh --install`.

## Runtime Expectations

- `python3`, `7z`, `curl`, `unzip`, `tar`, `flock`, `make`, and `g++` are required for
  `install.sh`.
- Native package builders require their format-specific tools: `dpkg-deb`,
  `rpmbuild`, `makepkg`/pacman tooling, or `appimagetool`.
- `scripts/install-deps.sh` bootstraps common host dependencies. On apt-based
  systems, `NODEJS_MAJOR=24 bash scripts/install-deps.sh` selects Node.js 24.
- The packaged app still needs the Codex CLI at runtime, but launcher preflight
  attempts a best-effort install/update when possible.

## Validation Matrix

Run the subset that matches the change; see the
[validation playbook](docs/agents/validation-playbook.md) for expanded checks.

```bash
bash -n install.sh
bash -n scripts/lib/*.sh
bash -n launcher/start.sh.template
bash -n scripts/build-deb.sh scripts/build-rpm.sh scripts/build-pacman.sh scripts/build-appimage.sh
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
bash tests/scripts_smoke.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
```

Build the affected package formats when package payloads or shared package
logic changes. Run `./scripts/ci-local.sh pr` or `./scripts/ci-local.sh all`
for broad cross-format confidence.

## Editing Guidance

- Keep native-package-only behavior in `packaging/linux/` helpers and
  AppImage-only behavior in `packaging/appimage/` helpers.
- Keep all package builders aligned through `scripts/lib/package-common.sh`
  when adding or removing shared payload files.
- Keep new core patch descriptors fail-soft and idempotent unless there is a
  deliberate `required-upstream` CI policy.
- Keep optional features disabled by default. When a user enables one, its
  patch drift must block candidate promotion until the user disables it or the
  feature is repaired for the current DMG.
- Add tests near the behavior being changed: patcher tests for ASAR needles,
  feature tests for Linux features, Rust tests for updater/MCP backends, and
  package smoke checks for payload/layout changes.
- When refreshing Nix hashes, use `scripts/ci/update-nix-hashes.sh`; do not
  hand-edit SRI hashes in `flake.nix`.
