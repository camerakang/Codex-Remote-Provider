# Codex Remote Provider

Desktop tool (Windows / macOS) for Codex desktop + Codex++ users with SSH remote hosts.

- Switch each remote host to the official ChatGPT login, a Codex++ relay, or the same provider as this machine.
- Let remote hosts use this machine's proxy (Clash Verge etc.): LAN mode writes a managed block into `~/.bashrc`/`~/.zshrc`; tunnel mode keeps an `ssh -R` tunnel open while the app runs.
- Every remote change backs up the file (`*.bak-<stamp>`) and restarts the remote `codex app-server`.

Hosts are read from `~/.codex/.codex-global-state.json`; relays from `~/.codex/backups/codex-plus-live-*`. Settings and logs: `~/.codex/provider-sync/`.

## Build

```sh
npm ci
npm run dist:win   # on Windows -> dist/*-win-setup.exe, *-win-portable.exe
npm run dist:mac   # on macOS   -> dist/*-mac-arm64.dmg, *-mac-x64.dmg
```

Behind a proxy, set `HTTPS_PROXY=http://127.0.0.1:7897` and `ELECTRON_GET_USE_PROXY=1` first.
The mac build is ad-hoc signed; on first launch right-click the app and choose Open, or run
`xattr -dr com.apple.quarantine "/Applications/Codex Remote Provider.app"`.

## CLI (headless)

```sh
npm run cli -- status
npm run cli -- official forlinx
npm run cli -- relay forlinx --dry-run
npm run cli -- proxy-set lan forlinx
```
