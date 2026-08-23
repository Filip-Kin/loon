# loon

An AI-assisted electronics design tool in the browser. You describe a circuit in
plain language, or drag parts and modules onto a sheet, and loon builds the
schematic. Files are saved in KiCad's own format so they open in KiCad too.

This is an early prototype. The first working slice is the schematic editor plus
the AI assistant. PCB layout, simulation, and board fabrication come after.

## What works today

- Schematic editor: pan and zoom, place parts, drag to move, rotate, delete,
  and wire pins together. Draws real KiCad symbol graphics.
- Parts library with a source filter. Restrict the visible catalogue to parts a
  chosen supplier or fab can source, for example only parts OSH Park can place.
- AI assistant. Reuses your existing Claude subscription by calling the local
  `claude` binary, so there is no separate API key. Ask it to add and wire
  parts, or whole sub-circuits.
- Modules: parametric sub-circuits (a circuit is built from modules that
  interface). The AI prefers these. Seeded modules: LED indicator, decoupling
  capacitors, voltage divider. The framework is built to hold bigger blocks
  like a buck converter or an on-board Arduino core.
- Load and save projects as `.kicad_sch` files straight to the filesystem. On
  the home server the project folder lives inside the Nextcloud data tree, so
  files sync to Nextcloud with no extra step.
- Mobile friendly. On a phone it becomes a single-panel layout with a bottom tab
  bar (Design / Parts / Assistant): touch to pan, pinch to zoom, tap to select,
  and talk to the AI or drive a probe. The full editor is still desktop.

## Run it

```
bun install
bun run dev      # server on :8790, web on :5178
```

Open http://localhost:5178. For a single-process build:

```
bun run build    # builds the web app into web/dist
bun run start     # server serves the app and the API on :8790
```

### Environment

- `LOON_PORT` server port (default 8790)
- `LOON_FS_DIR` where projects are stored. Point this at an ncdata path in
  production so saves land in Nextcloud. Default is `data/projects` in the repo.
- `LOON_CLAUDE_BIN` path to the `claude` binary (default `claude` on PATH)

## Layout

```
shared/   the design model, KiCad S-expression codec, geometry, ops, modules
server/   Bun + tRPC API, parts library, storage, and the AI bridge
web/      React + Vite schematic editor
docs/     the contract with claude-terminal, and the roadmap
scripts/  selftest and apitest
```

## Tests

```
bun run scripts/selftest.ts            # core codec + ops + module expansion
bun run scripts/apitest.ts --ai        # full API path incl. the claude bridge
```
