# tern-ui

Native Tern UI for coding agents: a Tern plugin (`plugin/`, Luau) and an MCP server (`server/`, TypeScript on Bun,
no runtime dependencies). README.md explains the design; read it first.

## Rules

- **The plugin's two halves:** `window.luau` only claims opens (`*.ternui` → `view`, `*.ternprs` → `github`) and runs
  the ask bridge (`tern-ui:ask?pane=…&text=…` links → `cx.agents:ask`). Everything else lives in the host blocks
  (`host.luau`), because host blocks run on the machine the agent and its files are on, which is what makes remote
  windows work. Host blocks reach a chat only through that bridge (`cx:open` of a `tern-ui:ask` link).
- **The wire format is plain TSP nodes** `{k, p, c}` with `key` in `p`. The server builds them (`figure.ts`, `wire()`
  in `main.ts`); the block draws whatever it is given. No Tern SDK dependency.
- **Specs are rewritten whole and atomically** (temp file, then rename); the block polls every 250 ms.
- **Keep the server dependency-free** at runtime: it compiles to one executable with `bun build --compile` for Nix.
- Budgets: host plugin calls get 2 s of Lua, window calls 50 ms. Keep `route.open` trivial.

## Checks before committing

```sh
cd server && bun x tsc --noEmit
tern plugin types /tmp/tt && luau-lsp analyze --definitions=/tmp/tt/tern.d.luau ../plugin/host.luau ../plugin/window.luau
nix build .#tern-ui-mcp
```

Then try it for real: `tern plugin reload tern-ui`, and drive the server over stdin (initialize, tools/list,
tools/call) from a Tern pane, or ask an agent in Tern's chat to `show` something.
