# Quick Notes Manager (TUI/CLI) — Plan

## Goals
- Fast note navigation in a local markdown vault
- Backlinks and graph-aware discovery
- Daily note generation from template
- Habit tracking via markdown checkbox section in daily notes
- Statistics (tags, links, habits, tasks, activity)

## Reference from Obsidian CLI (`obsidian.md/cli`)
Useful patterns to mirror:
- Command-first UX (`daily`, `search`, `daily:append`, `tasks`, `create`, `tags counts`, `diff`)
- Optional TUI shell with autocomplete/history
- Keep editor external

## Scope (in)
1. Vault indexer
   - Parse frontmatter + markdown links/tasks/tags
   - Build cache (sqlite or json index)
2. Navigation
   - List/open notes
   - Fuzzy search by title/alias/tag/content
   - Jump to linked/backlinked notes
3. Daily workflows
   - `daily open` (create from template if missing)
   - `daily habit toggle <habit>` (updates checklist item)
   - `daily task add "..."`
4. Stats
   - Habit streaks/consistency
   - Task completion trend
   - Tag/link frequency
5. TUI
   - 3-pane layout: list | preview/meta | backlinks/actions
   - Keyboard-driven command palette

## Scope (out)
- Sync transport
- Versioning implementation
- Embedded editor
(Use `jj` and external editor hooks only.)

## Suggested CLI Commands
- `notes index`
- `notes list [--tag TAG] [--recent N]`
- `notes open <note-id-or-path>`
- `notes search <query>`
- `notes backlinks <note>`
- `notes daily [--date YYYY-MM-DD]`
- `notes daily habit toggle <habit>`
- `notes daily task add "text"`
- `notes stats [--period 30d]`
- `notes doctor` (validate YAML/markdown/frontmatter)

## TUI Command Palette Ideas
- Open note
- New note from template
- Open/create daily
- Toggle habit
- Add task
- Show backlinks
- Show tag stats

## Data Model
- Note:
  - `id`, `path`, `title`, `aliases[]`, `tags[]`, `created`, `updated`
  - `outgoing_links[]`, `incoming_links[]`, `tasks[]`
- Daily extension:
  - `date`, `habit_checkboxes[]`, derived `habit_score`

## Validation/Doctor Rules
- Frontmatter exists and is valid YAML
- Required fields by note type (`id`, `tags`, `date` for daily)
- Link targets exist (warn on missing)
- Habits section exists and checkboxes are parseable (`- [ ] key` / `- [x] key`)

## External App Integrations (recommended)
- **Editor:** `nvim`, `hx`, `zed`, `code` via `$EDITOR`
- **Versioning:** `jj` wrappers (`notes vcs status|log|diff` passthrough)
- **Search+Picker:** `fzf` with built-in `ripgrep` integration for unified fuzzy/content search
- **direnv + just:** reproducible dev/task automation
- **watchman/fswatch:** auto-reindex on file changes
- **yazi/ranger:** file-browser handoff

## Milestones
1. MVP CLI: index/list/search/open/daily create
2. Habit ops + stats + doctor
3. TUI shell + palette + backlinks panel
4. Plugin hooks (custom commands, renderers)

## Tech Stack Suggestion
- Language: Rust or Go (fast startup, single binary)
- Parser: markdown + YAML frontmatter parser
- Storage: sqlite (or lite json cache for MVP)
- TUI: ratatui (Rust) / bubbletea (Go)
