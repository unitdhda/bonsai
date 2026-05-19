![](/preview.gif)
# bonsai

A friendly notes app for a `jj`-backed vault.

## Start
```bash
./bonsai
```

## What you can do
- browse notes in the TUI
- search, preview, view, backlinks
- create daily notes and toggle habits
- quick capture to inbox
- rename, move, delete notes
- check vault health with `doctor`
- browse recent notes
- sync with `jj`

## Common commands
- `bonsai` — open the TUI
- `bonsai find` — fuzzy pick a note
- `bonsai search <text>` — search titles, ids, tags
- `bonsai today` — open today’s daily note
- `bonsai yesterday` / `bonsai tomorrow`
- `bonsai recent` — show recent notes
- `bonsai sync` — sync through `jj`
- `bonsai doctor` — check vault health

## In the TUI
Type a command, then press Enter.

Useful ones:
- `find`
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
