# Notes LSP Server Plan

## Overview

A Language Server Protocol server (`notes-lsp.ts`) that provides in-editor intelligence
for the notes vault markdown files. Connects to any LSP-capable editor (Neovim, Helix,
Zed, VS Code, Emacs) via stdio JSON-RPC.

---

## Transport

```
editor <──stdio JSON-RPC──> notes-lsp (bun notes-lsp.ts)
```

Launch command editors should invoke:

```
bun /path/to/notes-lsp.ts --stdio
```

or after compilation:

```
./notes-lsp --stdio
```

---

## Capabilities to implement

### 1. Completion (`textDocument/completion`)

Trigger characters: `[`, `#`

| Trigger | Completes |
|---------|-----------|
| `[[`    | Note slugs, titles, aliases, ids — ranked by recency |
| `#`     | All tags across the vault index |
| `[[note#` | Headings within that note (section links) |

Each completion item includes:
- `label`: slug or tag
- `detail`: note title or tag count
- `documentation`: first paragraph of note body
- `insertText`: `slug\|display title]]` for notes, `tag` for tags

---

### 2. Hover (`textDocument/hover`)

On cursor over `[[target]]`:
- Resolve target via index (id / slug / legacy_id / stem)
- Return markdown card:
  ```markdown
  **Title** · notes/math/symplecticgeo.md
  tags: math, geometry
  links: 3 out · 1 in

  First paragraph of note body...
  ```

On cursor over `#tag`:
- Return tag frequency and list of notes using it

---

### 3. Go to definition (`textDocument/definition`)

On `[[target]]` — return `Location` pointing to the resolved note file, line 0.

On `#tag` — no definition (tags are not declared), return null.

---

### 4. Find references (`textDocument/references`)

On a note file itself (or `[[self]]` inside it):
- Return all `Location`s that contain `[[slug]]` or `[[id]]` linking to this note
- i.e. the backlinks list

On a `#tag`:
- Return all locations in the vault where `#tag` appears

---

### 5. Code actions (`textDocument/codeAction`)

Cursor on `[[broken-link]]` (not in index):
- **Create note** — create stub file at `notes/general/<slug>.md`
- **Search similar** — suggest closest slug by edit distance

Cursor on a task `- [ ] text`:
- **Toggle task** — flip to `[x]`

Cursor on a habit checkbox in `## Habits`:
- **Toggle habit** — flip state, re-sync to YAML

---

### 6. Diagnostics (`textDocument/publishDiagnostics`)

Pushed on file open and save:

| Severity | Condition |
|----------|-----------|
| Warning  | `[[target]]` not found in index |
| Warning  | `[[target]]` found but note is in `archive/` |
| Info     | Missing `slug` in frontmatter |
| Info     | Missing `id` in frontmatter |
| Hint     | Tag `#x` used only once across vault |

---

### 7. Document symbols (`textDocument/documentSymbol`)

Returns outline for the open file:
- H1 → H6 headings as symbols
- `## Habits` section → habit items as child symbols
- `## Tasks` section → task items as child symbols

---

### 8. Workspace symbols (`workspace/symbol`)

Query across all notes in vault:
- Match on title, slug, aliases, tags
- Return as `SymbolInformation[]` with `location` pointing to each file

---

### 9. Rename (`textDocument/rename`)

Rename a note (triggered from `[[target]]` or note title H1):
- Update slug in frontmatter
- Rename file on disk
- Update all `[[old-slug]]` references across the vault
- Return `WorkspaceEdit` with all changes

---

### 10. Inlay hints (`textDocument/inlayHint`)

On `[[slug]]` links:
- Show the resolved note title inline: `[[slug]] » Title`

On task lines:
- Show note they belong to if viewing a daily note

---

## Architecture

```
notes-lsp.ts
├── index/          re-uses collectNotes() + loadIndex() from notes.ts
├── rpc/            JSON-RPC 2.0 reader/writer over stdio
├── handlers/
│   ├── initialize.ts
│   ├── completion.ts
│   ├── hover.ts
│   ├── definition.ts
│   ├── references.ts
│   ├── codeAction.ts
│   ├── diagnostics.ts
│   ├── documentSymbol.ts
│   ├── workspaceSymbol.ts
│   ├── rename.ts
│   └── inlayHints.ts
└── watcher.ts      fs.watch on VAULT, invalidates index cache
```

Shared code with `notes.ts`:
- `parseFrontmatter()`
- `collectNotes()` / `loadIndex()`
- `slugify()` / `randomId()`
- `WIKILINK_RE`, `TAG_RE`, `HABIT_RE`, `TASK_RE`

Extract these into `notes-core.ts` and import from both `notes.ts` and `notes-lsp.ts`.

---

## Index invalidation

- On startup: load `.notes_index.json`
- On `textDocument/didSave`: re-parse that file only, update index in memory
- On `workspace/didChangeWatchedFiles`: re-parse changed files
- Full reindex every 5 minutes as fallback

---

## Editor setup snippets

### Neovim (nvim-lspconfig)

```lua
require("lspconfig.configs").notes = {
  default_config = {
    cmd = { "/path/to/notes-lsp", "--stdio" },
    filetypes = { "markdown" },
    root_dir = function(fname)
      return require("lspconfig.util").find_git_ancestor(fname)
    end,
  },
}
require("lspconfig").notes.setup {}
```

### Helix (languages.toml)

```toml
[[language]]
name = "markdown"
language-servers = ["notes-lsp"]

[language-server.notes-lsp]
command = "/path/to/notes-lsp"
args = ["--stdio"]
```

### Zed (settings.json)

```json
{
  "lsp": {
    "notes-lsp": {
      "binary": { "path": "/path/to/notes-lsp", "args": ["--stdio"] }
    }
  }
}
```

---

## Implementation order

1. **Scaffold** — stdio JSON-RPC loop, `initialize` / `initialized` / `shutdown`
2. **Completion** — `[[` triggers note slug list from index
3. **Hover** — resolve `[[target]]` and return note card
4. **Go to definition** — `[[target]]` → file location
5. **Diagnostics** — broken links on save
6. **References / backlinks** — return all linking locations
7. **Rename** — vault-wide slug rename
8. **Code actions** — create note stub for broken link
9. **Document symbols** — heading outline
10. **Inlay hints** — resolved titles inline
11. **Refactor** — extract shared core into `notes-core.ts`

---

## Dependencies

- `bun` (runtime + file I/O)
- No external LSP framework — implement raw JSON-RPC 2.0 over stdio
- Optionally use `vscode-languageserver-protocol` types for TypeScript types only (no runtime dep)
