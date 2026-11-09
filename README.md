# tern-ui

Native Tern UI for coding agents. An agent in Tern's chat (Claude, Factory Droid, Codex, anything that speaks ACP)
calls `show` or `ui`, and a pane beside the chat draws it with Tern's own components: stat grids, tables, labelled
bars, plots, verdicts, checklists, forms and buttons. It updates in place, and clicks come back to the agent.

It works on whichever machine the agent runs, from whichever Tern window you're looking through: the desktop's
agents seen from the Mac, the Mac's from the desktop, either one locally.

## How it works

```
agent ──MCP──▶ tern-ui-mcp ──writes──▶ NAME.ternui (spec) ──tern open──▶ tern-ui plugin
                    ▲                                                      │ host half: the `view` block draws the spec,
                    └──────────── NAME.ternui.events (clicks) ◀────────────┘ redraws when it changes, records clicks
```

- **`plugin/`**: a Tern plugin (Luau). The window half claims `*.ternui` opens and turns them into a `tern-ui.view`
  block **on the file's host**; the host half is that block. Because the spec file, the block and the agent are all on
  the agent's machine, any window connected to that machine shows it, local or over `tern remote`.
- **`server/`**: `tern-ui-mcp`, an MCP server over stdio with no runtime dependencies. Tools:
  - `show`: figures (tables, stats, charts, plots, verdicts, callouts, math, code, diffs, checklists, images)
  - `ui`: interactive UI from a node spec `{k, id, p, c}`; `wait: true` returns what the person did
  - `update_ui`: change a UI live (set, append, replace) or close it
  - `ui_events`: clicks on UIs the agent isn't waiting on
  - `ui_reference`: every prop of one UI kind

  Specs live in `~/.local/state/tern-ui/pane-<chat pane>/`: `NAME.ternui`, `NAME.ternui.events`, `NAME.ternui.pane`.

## Install (each machine that runs agents and each Tern you look through)

```sh
# the plugin
tern plugin install github.com/saavy1/tern-ui/plugin     # or, from a checkout: tern plugin link ./plugin

# the MCP server
nix build github:saavy1/tern-ui                          # or: nix profile install github:saavy1/tern-ui
```

Then add it in Tern's Settings › Agents › MCP servers (or `agents.mcp` in `settings.json`):

```json
{ "name": "tern-ui", "command": "tern-ui-mcp", "args": [], "env": {} }
```

## Develop

```sh
direnv allow                  # bun and luau-lsp from the flake
cd server && bun install      # TypeScript, for checks only
bun x tsc --noEmit            # typecheck the server
tern plugin types /tmp/tt && luau-lsp analyze --definitions=/tmp/tt/tern.d.luau ../plugin/*.luau
tern plugin reload tern-ui    # after editing the plugin
nix build .#tern-ui-mcp       # the compiled server (Linux and macOS)
```

The figure language and UI spec come from saavy's Tern front end (`show`, `ui`, `update_ui`), so agents that knew
those write the same calls here.
