![](/screenshot.png)
# bonsai

Bonsai is a note manager for a vault. It’s for managing notes, while you can bring your own editor for whatever feels most comfortable.

## Install

```bash
npm install -g @unitdhda/bonsai
```

## Dependencies

Core:
- `jj` or `git` — syncing
- your `$EDITOR` — opening notes for editing

Optional UX tools:
- `tv` / `fzf` / `find` — fuzzy picking
- `yazi` — note browsing
- `dprint` — previews
- `bat` — handy for Television preview actions

## What this is for

- browsing, searching, and managing notes
- daily notes, habits, tasks, backlinks, and quick capture
- sync workflows that adapt to what you have installed

Actions are dependency-agnostic: bonsai prefers the best available tool, then falls back when needed.

## Common commands

- `bonsai` — open the TUI
- `bonsai search` — fuzzy pick a note
- `bonsai search <text>` — search titles, ids, tags
- `bonsai today` — open today’s daily note
- `bonsai yesterday` / `bonsai tomorrow`
- `bonsai recent` — show recent notes
- `bonsai sync` — sync through `jj` or `git`
- `bonsai doctor` — check vault health

## In the TUI

Type a command, then press Enter.

Useful ones:
- `search`
- `explore`
- `today`
- `recent`
- `sync`
- `habits`
- `tasks`

## Build

```bash
bun build ./notes.ts --compile --outfile ./bonsai
```

## Files

- `notes.ts` — app entry
- `src/` — source code
- `mascot.ts` — bonsai art
- `notes.test.ts` — tests
