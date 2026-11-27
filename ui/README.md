# Search popup

A Tauri v2 window on a global hotkey (Alt+Space by default, `hotkey:` in
`~/.local-search/config.yaml`). It talks to `lsd serve` over the localhost API, using the port
and token the daemon writes to `~/.local-search/`.

| Key | Does |
|---|---|
| typing | Searches as you type (120 ms debounce). After 1.5 s idle the search is logged once. |
| ↑ / ↓ | Select a result |
| Enter / click | Open the file, report "open" |
| Ctrl+Enter / Ctrl+click | Show it in its folder, report "open_folder" |
| Shift+Enter | Search harder: expansion + rerank for this search (models load on first use) |
| Ctrl+C | Copy the selected result's path (when no text is selected in the box) |
| Esc / click elsewhere | Hide. A logged search with no open is reported as "none" |

Files open, and thumbnails load, only from the folders the daemon indexes (`GET /config`).

- `src/logic.ts`: API client, when a search is logged, feedback, display helpers (unit-tested,
  `test/logic.test.ts`).
- `src/main.ts`: the window (DOM, keys, Tauri calls).
- `src-tauri/src/lib.rs`: hotkey, tray icon (Search / Quit), single instance, start at logon
  (installed Windows builds only), and the `open_file` / `reveal_file` commands that check the path.

## Develop on the Mac (no models)

Rust is needed once: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then
`. "$HOME/.cargo/env"`.

```sh
# Terminal 1: the daemon on the synthetic fixtures, model-free
mkdir -p ~/.local-search
printf 'roots:\n  - %s/fixtures/corpus\n' "$PWD" > ~/.local-search/config.yaml
pnpm lsd serve --embedder hash

# Terminal 2: the popup (window shows at start in dev and doesn't hide on blur)
pnpm --filter @local-search/ui tauri dev
```

The Windows installer is built by CI: Actions → **popup build** → artifact
`local-search-popup-windows`.
