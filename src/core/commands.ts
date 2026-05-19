import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync, renameSync, writeSync, fstatSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { Task, Habit, Note, Suspendable } from "../types/index.ts";
import { H1_RE, HABIT_RE, TASK_RE, DAILY_NOTE_RE } from "../types/index.ts";
import { getOrCreate, randomId, slugify, yamlStringify } from "./utils.ts";
import {
  PROJECT_ROOT,
  JJ_ROOT,
  detectVaultRoot,
  getVault,
  getIndex,
  getDailyDir,
  getTemplate,
  getNoteTemplate,
  getProjectTemplate,
  getConfigDir,
  getHabitsConfig,
  getVaultConfig,
  vaultPath,
} from "./vault.ts";
import { parseFrontmatter, parseHabits, parseTasks, parseLinks, parseTags } from "./parse.ts";

const IGNORE_DIRS = new Set([
  ".git", ".jj", ".obsidian", "node_modules", "Library", "Applications",
  "Desktop", "Downloads", "Movies", "Music", "Pictures", "Public", ".Trash", "archive",
]);

function walkMd(dir: string, out: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function collectNotes(): Note[] {
  const files = walkMd(getVault()).filter(path => {
    const relativePath = relative(getVault(), path);
    return !relativePath.startsWith("templates/") || basename(path) === "daily-note.md";
  });

  const notes: Note[] = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const { fm, body } = parseFrontmatter(text);
    const stem = basename(path, ".md");

    notes.push({
      id: String(fm.id ?? stem),
      stem,
      path: relative(getVault(), path),
      title: (body.match(H1_RE)?.[1] ?? stem).trim(),
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
      slug: typeof fm.slug === "string" ? fm.slug : undefined,
      legacy_id: typeof fm.legacy_id === "string" ? fm.legacy_id : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
      tags: parseTags(fm.tags, body),
      links: parseLinks(body),
      backlinks: [],
      tasks: parseTasks(body),
      habits: parseHabits(body),
      mtime: statSync(path).mtimeMs,
    });
  }
  const targetToId = new Map<string, string>();
  for (const n of notes) {
    targetToId.set(n.stem, n.id);
    targetToId.set(n.id, n.id);
    targetToId.set(n.path.replace(/\.md$/, ""), n.id);
    if (n.slug) targetToId.set(n.slug, n.id);
    if (n.legacy_id) targetToId.set(n.legacy_id, n.id);
  }
  for (const n of notes) n.links = n.links.map(l => targetToId.get(l) ?? l);
  const inbound = new Map<string, Set<string>>();
  for (const n of notes) for (const l of n.links) getOrCreate(inbound, l, () => new Set()).add(n.id);
  for (const n of notes) n.backlinks = [...(inbound.get(n.id) ?? new Set())].sort();
  return notes;
}

function ensureVaultDir() {
  mkdirSync(getVault(), { recursive: true });
}

let INDEX_CACHE: { path: string; mtime: number; notes: Note[] } | null = null;

function saveIndex(notes: Note[]) {
  ensureVaultDir();
  writeFileSync(getIndex(), JSON.stringify(notes, null, 2));
  INDEX_CACHE = { path: getIndex(), mtime: statSync(getIndex()).mtimeMs, notes };
}

function loadIndex(force = false): Note[] {
  const indexPath = getIndex();
  if (!force && INDEX_CACHE && INDEX_CACHE.path === indexPath && existsSync(indexPath)) {
    const mtime = statSync(indexPath).mtimeMs;
    if (INDEX_CACHE.mtime === mtime) return INDEX_CACHE.notes;
  }

  if (!force && existsSync(indexPath)) {
    const indexMtime = statSync(indexPath).mtimeMs;
    const stale = walkMd(getVault()).some(path => statSync(path).mtimeMs > indexMtime);
    if (!stale) {
      const notes = JSON.parse(readFileSync(indexPath, "utf8"));
      INDEX_CACHE = { path: indexPath, mtime: indexMtime, notes };
      return notes;
    }
  }

  const n = collectNotes();
  saveIndex(n);
  return n;
}

function cmdIndex() { const n = loadIndex(true); console.log(`Indexed ${n.length} notes -> ${getIndex()}`); }

function ensureConfig() {
  mkdirSync(getConfigDir(), { recursive: true });
  if (!existsSync(getHabitsConfig())) writeFileSync(getHabitsConfig(), `habits:\n  sleep_7h:\n    title: Sleep 7h+\n  meds_am:\n    title: Morning meds\n  walk_30m:\n    title: Walk 30m+\n  reading_30m:\n    title: Reading 30m+\n`);
  if (!existsSync(getVaultConfig())) writeFileSync(getVaultConfig(), `jj:\n  aliases:\n    sync:\n      - jj git remote add origin\n      - jj bookmark set\n      - jj bookmark track\n      - jj move\n      - jj describe -m "notes snapshot"\n      - jj git push\n    snapshot:\n      - jj status\n      - jj describe -m "notes snapshot"\n      - jj new\n    review:\n      - jj status\n      - jj diff\n`);
}

function readHabitKeys() {
  ensureConfig();
  const txt = readFileSync(getHabitsConfig(), "utf8");
  const keys: string[] = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function syncDailyHabits(path: string) {
  const keys = readHabitKeys();
  let txt = readFileSync(path, "utf8");
  const existing = new Map(parseHabits(txt).map(h => [h.key, h.done]));
  const block = ["## Habits", ...keys.map(k => `- [${existing.get(k) ? "x" : " "}] ${k}`)].join("\n");
  const match = txt.match(/^##\s+Habits\s*$/m);
  if (match?.index !== undefined) {
    const start = match.index;
    const rest = txt.slice(start + match[0].length);
    const nextHeadingOffset = rest.search(/^##\s+/m);
    const end = nextHeadingOffset >= 0 ? start + match[0].length + nextHeadingOffset : txt.length;
    txt = `${txt.slice(0, start)}${block}\n\n${txt.slice(end).replace(/^\n+/, "")}`;
  } else {
    txt += `\n\n${block}\n`;
  }
  writeFileSync(path, txt);
}

function cmdSearch(q = "") {
  if (!q) {
    cmdFind();
    return;
  }

  const notes = loadIndex();
  const qq = q.toLowerCase();
  for (const n of notes) {
    const hay = `${n.id} ${n.title} ${n.aliases.join(" ")} ${n.tags.join(" ")}`.toLowerCase();
    if (hay.includes(qq)) console.log(`${n.id}\t${n.title}\t${n.path}`);
  }
}

function cmdBacklinks(note = "") {
  const notes = loadIndex();
  const n = note ? pickNote(note) : pickNote();
  if (!n) return console.log("Note not found");
  console.log(`Backlinks for ${n.id} (${n.title}):`);
  for (const b of n.backlinks) {
    const x = notes.find(v => v.id === b);
    if (x) console.log(`- ${x.id} :: ${x.title} [${x.path}]`);
  }
}

function openInEditor(file: string) {
  const editor = process.env.EDITOR;
  const p = vaultPath(file);

  const stdinIsTTY = (() => {
    try { return fstatSync(0).isCharacterDevice(); }
    catch { return false; }
  })();
  const stdoutIsTTY = (() => {
    try { return fstatSync(1).isCharacterDevice(); }
    catch { return false; }
  })();

  if (!editor || !stdinIsTTY || !stdoutIsTTY) {
    writeSync(1, `${relative(getVault(), p)}\n`);
    return;
  }

  const result = spawnSync(editor, [p], { stdio: "inherit", shell: true });
  if ((result.status ?? 1) !== 0) {
    writeSync(1, `${relative(getVault(), p)}\n`);
  }
}

function selfCommand() {
  return "bonsai";
}

let _tuiScreen: Suspendable | null = null;
let _tuiStatus: ((msg: string) => void) | null = null;
let _tuiStream: ((line: string) => void) | null = null;
export function setTuiScreen(s: Suspendable | null) { _tuiScreen = s; }
export function setTuiStatus(fn: ((msg: string) => void) | null) { _tuiStatus = fn; }
export function setTuiStream(fn: ((line: string) => void) | null) { _tuiStream = fn; }

function withSuspend<T>(fn: () => T): T {
  _tuiScreen?.suspend();
  try { return fn(); }
  finally { _tuiScreen?.resume(); }
}

function promptUser(promptText: string, defaultVal = ""): string {
  const r = withSuspend(() => spawnSync("fzf", [
    "--prompt", `${promptText} > `,
    "--print-query",
    "--height", "30%",
    "--border", "rounded",
    "--no-info",
    "--no-multi"
  ], { encoding: "utf8", input: defaultVal ? `${defaultVal}\n` : "" }));
  return (r.stdout || defaultVal).trim();
}

function pickWithFzf(rows: string, prompt: string, query = "", options: string[] = []): string {
  const args = [
    "--prompt", `${prompt} > `,
    "--height", "60%",
    "--layout", "reverse",
    "--border", "rounded",
    ...options,
  ];
  if (query) args.push("--query", query);
  return withSuspend(() => spawnSync("fzf", args, { input: rows, encoding: "utf8" }).stdout.trim());
}

function pickNote(query = ""): Note | undefined {
  const exact = query ? findNote(query) : undefined;
  if (exact) return exact;

  const notes = loadIndex();
  const rows = notes.map(note => `${note.path}\t${note.title}\t${note.tags.join(",")}\t${note.slug ?? note.id}`).join("\n");
  const out = pickWithFzf(rows, "note", query, ["--delimiter", "\t", "--with-nth", "1,2,3"]);
  if (!out) return undefined;
  const path = out.split("\t", 1)[0];
  return notes.find(note => note.path === path);
}

function pickHabit(query = ""): string | undefined {
  const keys = readHabitKeys();
  if (query && keys.includes(query)) return query;
  const out = pickWithFzf(keys.join("\n"), "habit", query);
  return out || undefined;
}

function pickDailyNote(query = ""): string | undefined {
  const notes = loadIndex()
    .filter(note => DAILY_NOTE_RE.test(note.path))
    .sort((a, b) => (a.path < b.path ? 1 : -1));
  const exact = query && notes.find(note => note.path === query || note.path.replace(/\.md$/, "") === query || getDailyDate(note.path) === query);
  if (exact) return getDailyDate(exact.path);
  const rows = notes.map(note => `${getDailyDate(note.path)}\t${note.title}\t${note.path}`).join("\n");
  const out = pickWithFzf(rows, "daily", query, ["--delimiter", "\t", "--with-nth", "1,2,3"]);
  return out ? out.split("\t", 1)[0] : undefined;
}

function pickFolder(query = ""): string | undefined {
  const folders = new Set<string>(["notes/general", "notes/math", "projects", "daily", "archive", "inbox", "templates", "config"]);
  for (const note of loadIndex()) folders.add(dirname(note.path));
  const out = pickWithFzf([...folders].sort().join("\n"), "folder", query);
  return out || undefined;
}

function cmdFind(initialQuery = "") {
  const notes = loadIndex();
  const rows = notes.map(n => {
    const body = readFileSync(vaultPath(n.path), "utf8").replace(/\s+/g, " ").slice(0, 1200);
    return `${n.path}\t${n.title}\t${n.tags.join(",")}\t${n.slug ?? ""}\t${body}`;
  }).join("\n");
  const fzfArgs = [
    "--prompt", "note > ", "--height", "60%", "--layout", "reverse", "--border", "rounded",
    "--delimiter", "\t", "--with-nth", "1,2,3", "--preview", `${selfCommand()} tv preview notes {}`,
  ];
  if (initialQuery) fzfArgs.push("--query", initialQuery);
  const r = withSuspend(() => spawnSync("fzf", fzfArgs, { input: rows, encoding: "utf8" }));
  const out = (r.stdout || "").trim();
  if (!out) return;
  const file = out.split("\t", 1)[0];
  const actions = ["open", "backlinks", "links", "preview", "copy path", "archive", "cancel"];
  const a = withSuspend(() => spawnSync("fzf", ["--prompt", "action > ", "--height", "40%", "--border", "rounded"], { input: actions.join("\n"), encoding: "utf8" })).stdout.trim();
  if (a === "open") withSuspend(() => openInEditor(file));
  else if (a === "backlinks") cmdBacklinks(file.replace(/\.md$/, ""));
  else if (a === "links") cmdLinks(file.replace(/\.md$/, ""));
  else if (a === "preview") withSuspend(() => cmdPreview(file));
  else if (a === "copy path") spawnSync("pbcopy", { input: file, encoding: "utf8" });
  else if (a === "archive") cmdArchive(file);
}

function findNote(note: string) {
  const notes = loadIndex();
  return notes.find(x => x.id === note || x.stem === note || x.path === note || x.path.replace(/\.md$/, "") === note || x.slug === note || x.legacy_id === note);
}

function cmdLinks(note = "") {
  const n = note ? pickNote(note) : pickNote();
  if (!n) return console.log("Note not found");
  console.log(`Links from ${n.id} (${n.title}):`);
  for (const l of n.links) console.log(`- ${l}`);
}

function cmdArchive(note: string) {
  const p = vaultPath(note);
  if (!existsSync(p)) return console.log("Note not found");
  const dest = join(getVault(), "archive", basename(p));
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(p, dest);
  cmdIndex();
  console.log(`Archived ${relative(getVault(), p)} -> ${relative(getVault(), dest)}`);
}

function renderDaily(date: string): string {
  const templatePath = getTemplate();
  const t = existsSync(templatePath)
    ? readFileSync(templatePath, "utf8")
    : `---\nid: "{{date:YYYYMMDD}}-DAILY"\ndate: "{{date:YYYY-MM-DD}}"\naliases:\n  - Daily {{date:YYYY-MM-DD}}\ntags:\n  - daily\n  - journal\n---\n\n# Daily {{date:YYYY-MM-DD}}\n\n## Habits\n\n## Notes\n\n## Tasks\n`;
  return t.replaceAll("{{date:YYYYMMDD}}", date.replaceAll("-", "")).replaceAll("{{date:YYYY-MM-DD}}", date);
}

function cmdDailyOpen(date?: string) {
  const d = date ?? new Date().toISOString().slice(0, 10);
  if (!existsSync(getDailyDir())) mkdirSync(getDailyDir(), { recursive: true });
  const p = join(getDailyDir(), `${d}.md`);
  if (!existsSync(p)) {
    writeFileSync(p, renderDaily(d));
    console.log(`Created ${relative(getVault(), p)}`);
  }
  syncDailyHabits(p);
  openInEditor(p);
}

function setHabitState(habit: string, date: string, done: boolean): boolean {
  const p = join(getDailyDir(), `${date}.md`);
  if (!existsSync(p)) {
    console.log(`Daily note missing: daily/${date}.md`);
    return false;
  }
  syncDailyHabits(p);
  const lines = readFileSync(p, "utf8").split("\n");
  let inHabits = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^##\s+Habits\s*$/.test(ln)) { inHabits = true; continue; }
    if (inHabits && /^##\s+/.test(ln)) break;
    if (!inHabits) continue;
    const m = ln.match(HABIT_RE);
    if (m && m[2] === habit) {
      lines[i] = `- [${done ? "x" : " "}] ${habit}`;
      changed = true;
      break;
    }
  }
  if (!changed) {
    console.log("Habit not found in Habits section");
    return false;
  }
  writeFileSync(p, lines.join("\n"));
  return true;
}

function cmdHabitToggle(habit = "", date?: string) {
  const pickedHabit = habit ? pickHabit(habit) : pickHabit();
  if (!pickedHabit) return console.log("Habit not found");
  const d = date ?? new Date().toISOString().slice(0, 10);
  const p = join(getDailyDir(), `${d}.md`);
  if (!existsSync(p)) return console.log(`Daily note missing: daily/${d}.md`);
  syncDailyHabits(p);
  const txt = readFileSync(p, "utf8");
  const current = parseHabits(txt).find(entry => entry.key === pickedHabit)?.done ?? false;
  if (setHabitState(pickedHabit, d, !current)) {
    console.log(`Toggled ${pickedHabit} in daily/${d}.md`);
  }
}

function streak(days: Array<{ date: string; done: boolean }>): number {
  const sorted = days.sort((a, b) => (a.date < b.date ? 1 : -1));
  let s = 0;
  for (const d of sorted) { if (d.done) s++; else break; }
  return s;
}

function getDailyDate(path: string): string | undefined {
  return DAILY_NOTE_RE.exec(path)?.[1];
}

function countTasks(notes: Note[]) {
  let done = 0;
  let total = 0;

  for (const note of notes) {
    total += note.tasks.length;
    done += note.tasks.filter(task => task.done).length;
  }

  return { done, total };
}

function buildHabitMap(notes: Note[]) {
  const habitMap = new Map<string, Array<{ date: string; done: boolean }>>();

  for (const note of notes) {
    const date = getDailyDate(note.path);
    if (!date) continue;

    for (const habit of note.habits) {
      const entries = habitMap.get(habit.key) ?? [];
      entries.push({ date, done: habit.done });
      habitMap.set(habit.key, entries);
    }
  }

  return habitMap;
}

// ── new / quick / inbox ──────────────────────────────────────────────────────




function renderNoteTemplate(title: string, type = "note", extraFm: Record<string,any> = {}): string {
  const tplPath = type === "project" ? getProjectTemplate() : getNoteTemplate();
  const tpl = existsSync(tplPath)
    ? readFileSync(tplPath, "utf8")
    : `# {{title}}\n\n`;
  const fm = { id: randomId(), slug: slugify(title), type, tags: [], ...extraFm };
  return yamlStringify(fm) + tpl.replace(/\{\{title\}\}/g, title);
}

function cmdNew(title: string, type = "note") {
  if (!title) {
    title = promptUser("note title or folder/title");
    if (!title) return;
  }
  const id = randomId();
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10).replace(/-/g,'');
  const filename = `${dateStr}-${id}.md`;
  const folderParts = title.includes("/") ? title.split("/") : [];
  const noteTitle = folderParts.length ? folderParts.pop()!.trim() : title;
  const folder = folderParts.length
    ? folderParts.join("/").trim()
    : (type === "project" ? "projects" : "notes/general");
  const dir = join(getVault(), folder);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, renderNoteTemplate(noteTitle, type, { id }));
  cmdIndex();
  openInEditor(p);
}

function cmdQuick(text: string) {
  if (!text) {
    text = promptUser("quick capture");
    if (!text) return;
  }
  const inbox = join(getVault(), "inbox", "inbox.md");
  mkdirSync(dirname(inbox), { recursive: true });
  if (!existsSync(inbox)) writeFileSync(inbox, `${yamlStringify({id: randomId(), slug: "inbox", type: "inbox", tags: ["inbox"]})}# Inbox\n\n`);
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `- ${ts}: ${text}\n`;
  const src = readFileSync(inbox, "utf8");
  writeFileSync(inbox, `${src.trimEnd()}\n${line}`);
  console.log(`Appended to inbox: ${text}`);
}

function cmdInbox() {
  const inbox = join(getVault(), "inbox", "inbox.md");
  if (!existsSync(inbox)) cmdQuick("");
  openInEditor(inbox);
}

// ── recent / orphans ──────────────────────────────────────────────────────────

function cmdRecent(n = 10) {
  const notes = loadIndex().sort((a, b) => b.mtime - a.mtime).slice(0, n);
  for (const note of notes) {
    const age = Math.round((Date.now() - note.mtime) / 86400000);
    console.log(`${age}d  ${note.path}  ${note.title}`);
  }
}

function cmdOrphans() {
  const notes = loadIndex().filter(n => n.backlinks.length === 0 && !DAILY_NOTE_RE.test(n.path));
  if (!notes.length) { console.log("No orphans."); return; }
  for (const n of notes) console.log(`${n.path}  ${n.title}`);
}

// ── rename / move / delete ───────────────────────────────────────────────────

function cmdRename(note = "", newTitle = "") {
  const n = note ? pickNote(note) : pickNote();
  if (!n) return console.log("Note not found");
  if (!newTitle) {
    newTitle = promptUser("new title", n.title);
    if (!newTitle) return;
  }
  const p = vaultPath(n.path);
  const newSlug = slugify(newTitle);
  const dest = join(dirname(p), `${newSlug}.md`);
  if (existsSync(dest)) return console.log(`Destination already exists: ${dest}`);
  let src = readFileSync(p, "utf8");
  const { fm, body } = parseFrontmatter(src);
  fm.slug = newSlug;
  src = yamlStringify(fm) + body.replace(H1_RE, `# ${newTitle}`);
  writeFileSync(p, src);
  renameSync(p, dest);
  cmdIndex();
  console.log(`Renamed: ${n.path} -> ${relative(getVault(), dest)}`);
}

function cmdMove(note = "", folder = "") {
  const n = note ? pickNote(note) : pickNote();
  if (!n) return console.log("Note not found");
  if (!folder) {
    folder = pickFolder();
    if (!folder) return;
  }
  const p = vaultPath(n.path);
  const destDir = join(getVault(), folder);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, basename(p));
  if (existsSync(dest)) return console.log(`Destination already exists: ${dest}`);
  renameSync(p, dest);
  cmdIndex();
  console.log(`Moved: ${n.path} -> ${relative(getVault(), dest)}`);
}

function cmdDelete(note = "") {
  const n = note ? pickNote(note) : pickNote();
  if (!n) return console.log("Note not found");
  const p = vaultPath(n.path);
  const dest = join(getVault(), "archive", basename(p));
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(p, dest);
  cmdIndex();
  console.log(`Deleted (archived): ${n.path}`);
}

// ── tasks ────────────────────────────────────────────────────────────────────

function cmdTasks(filter?: string) {
  const notes = loadIndex();
  let found = false;
  for (const n of notes) {
    const tasks = filter === "open" ? n.tasks.filter(t => !t.done)
      : filter === "done" ? n.tasks.filter(t => t.done)
      : n.tasks;
    if (!tasks.length) continue;
    found = true;
    console.log(`\n${n.path}  ${n.title}`);
    for (const t of tasks) console.log(`  ${t.done ? "[x]" : "[ ]"} ${t.text}`);
  }
  if (!found) console.log(filter ? `No ${filter} tasks.` : "No tasks.");
}

function cmdTasksAdd(note = "", text = "") {
  if (!text) {
    text = promptUser("task text");
    if (!text) return;
  }
  const n = note ? pickNote(note) : pickNote();
  if (!n) return console.log("Note not found");
  const p = vaultPath(n.path);
  const src = readFileSync(p, "utf8").trimEnd();
  writeFileSync(p, `${src}\n- [ ] ${text}\n`);
  cmdIndex();
  console.log(`Task added to ${n.path}`);
}

function updateTaskAtLine(relPath: string, lineNumber: number, mode: "toggle" | "close" | "delete"): boolean {
  const p = vaultPath(relPath);
  if (!existsSync(p)) {
    console.log("Note not found");
    return false;
  }
  const lines = readFileSync(p, "utf8").split("\n");
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lines.length) {
    console.log("Task line not found");
    return false;
  }
  const match = lines[idx].match(TASK_RE);
  if (!match) {
    console.log("Task line not found");
    return false;
  }
  if (mode === "delete") {
    lines.splice(idx, 1);
  } else if (mode === "close") {
    lines[idx] = `- [x] ${match[2]}`;
  } else {
    lines[idx] = `- [${match[1].toLowerCase() === "x" ? " " : "x"}] ${match[2]}`;
  }
  writeFileSync(p, lines.join("\n"));
  loadIndex(true);
  return true;
}

function parseTaskRef(ref: string) {
  const match = ref.match(/^(.*):(\d+)$/);
  if (!match) return;
  return { path: match[1], lineNumber: Number(match[2]) };
}

function cmdTaskAction(ref: string, mode: "toggle" | "close" | "delete") {
  const parsed = parseTaskRef(ref);
  if (!parsed) return console.log("Usage: tasks --toggle|--close|--delete <note-path:line>");
  if (updateTaskAtLine(parsed.path, parsed.lineNumber, mode)) {
    console.log(`${mode}d task in ${parsed.path}:${parsed.lineNumber}`);
  }
}

// ── habits ───────────────────────────────────────────────────────────────────

function cmdHabitList() {
  const keys = readHabitKeys();
  const habitMap = buildHabitMap(loadIndex());

  for (const key of keys) {
    const entries = habitMap.get(key) ?? [];
    const done = entries.filter(entry => entry.done).length;
    const total = entries.length;
    const pct = Math.round(done / Math.max(1, total) * 100);
    const streakDays = streak(entries);
    const filled = Math.round(pct / 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);

    console.log(`${key.padEnd(16)} ${bar} ${pct}%  streak=${streakDays}d`);
  }
}

function cmdHabitAdd(key: string, title?: string) {
  if (!key) return console.log("Usage: habit add <key> [title]");
  ensureConfig();
  const src = readFileSync(getHabitsConfig(), "utf8").trimEnd();
  if (src.includes(`  ${key}:`)) return console.log(`Habit '${key}' already exists`);
  writeFileSync(getHabitsConfig(), `${src}\n  ${key}:\n    title: ${title ?? key}\n`);
  console.log(`Added habit: ${key}`);
}

function removeHabitFromDailyNotes(key: string) {
  const dailyDir = getDailyDir();
  if (!existsSync(dailyDir)) return;
  for (const file of readdirSync(dailyDir).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))) {
    const p = join(dailyDir, file);
    const lines = readFileSync(p, "utf8").split("\n");
    let inHabits = false;
    const next = lines.filter(line => {
      if (/^##\s+Habits\s*$/.test(line)) {
        inHabits = true;
        return true;
      }
      if (inHabits && /^##\s+/.test(line)) inHabits = false;
      const match = line.match(HABIT_RE);
      return !(inHabits && match && match[2] === key);
    });
    writeFileSync(p, next.join("\n"));
  }
}

function cmdHabitRemove(key: string) {
  ensureConfig();
  const lines = readFileSync(getHabitsConfig(), "utf8").split("\n");
  let skip = false;
  const out: string[] = [];
  for (const l of lines) {
    if (l.match(new RegExp(`^  ${key}:\\s*$`))) { skip = true; continue; }
    if (skip && l.match(/^ {4}/)) continue;
    skip = false;
    out.push(l);
  }
  writeFileSync(getHabitsConfig(), out.join("\n"));
  removeHabitFromDailyNotes(key);
  cmdIndex();
  console.log(`Removed habit: ${key}`);
}

function cmdDailyHabitToggle(habit = "", date?: string) {
  const pickedHabit = habit ? pickHabit(habit) : pickHabit();
  if (!pickedHabit) return console.log("Habit not found");

  const pickedDate = date ?? pickDailyNote();
  if (!pickedDate) return console.log("Daily note not found");

  cmdHabitToggle(pickedHabit, pickedDate);
}

function cmdHabitSet(key: string, date: string | undefined, done: boolean) {
  const pickedHabit = key ? pickHabit(key) : pickHabit();
  if (!pickedHabit) return console.log("Habit not found");
  const pickedDate = date ?? new Date().toISOString().slice(0, 10);
  if (setHabitState(pickedHabit, pickedDate, done)) {
    console.log(`${done ? "Closed" : "Opened"} ${pickedHabit} in daily/${pickedDate}.md`);
  }
}

function cmdHabitFill(key: string, date: string) {
  const p = join(getDailyDir(), `${date}.md`);
  if (!existsSync(p)) return console.log(`No daily note for ${date}`);
  cmdHabitSet(key, date, true);
}

// ── daily helpers ─────────────────────────────────────────────────────────────

function cmdDailyNav(direction: "yesterday" | "tomorrow") {
  if (!existsSync(getDailyDir())) {
    console.log(`No ${direction} daily note`);
    return;
  }

  const files = readdirSync(getDailyDir()).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const today = new Date().toISOString().slice(0, 10);
  const current = files.indexOf(`${today}.md`);
  const target = direction === "yesterday" ? files[current - 1] : files[current + 1];
  if (!target) return console.log(`No ${direction} daily note`);
  openInEditor(join(getDailyDir(), target));
}

function cmdDailyReview() {
  const today = new Date().toISOString().slice(0, 10);
  const p = join(getDailyDir(), `${today}.md`);
  if (!existsSync(p)) return console.log("No daily note for today");
  cmdView(relative(getVault(), p));
}

// ── doctor ────────────────────────────────────────────────────────────────────

function cmdDoctor(fix = false) {
  const notes = loadIndex();
  const issues: string[] = [];

  // duplicate ids
  const ids = new Map<string, string[]>();
  for (const n of notes) getOrCreate(ids, n.id, () => []).push(n.path);
  for (const [id, paths] of ids) if (paths.length > 1) issues.push(`duplicate id ${id}: ${paths.join(", ")}`);

  // broken wikilinks (link targets not in index) — skip daily notes
  const allIds = new Set(notes.map(n => n.id));
  for (const n of notes) {
    if (DAILY_NOTE_RE.test(n.path)) continue;
    for (const l of n.links) {
      if (!allIds.has(l) && !l.startsWith("http")) issues.push(`broken link in ${n.path}: [[${l}]]`);
    }
  }

  // missing slugs — skip daily notes
  for (const n of notes) if (!n.slug && !DAILY_NOTE_RE.test(n.path)) issues.push(`missing slug: ${n.path}`);

  // missing daily template
  if (!existsSync(getTemplate())) issues.push(`missing daily template: ${getTemplate()}`);

  // stale index
  const indexMtime = existsSync(getIndex()) ? statSync(getIndex()).mtimeMs : 0;
  const stale = notes.filter(n => statSync(vaultPath(n.path)).mtimeMs > indexMtime);
  if (stale.length) issues.push(`index stale (${stale.length} notes newer than index)`);

  if (!issues.length) { console.log("Vault looks healthy"); return; }
  for (const issue of issues) console.log(`  ${issue}`);
  if (fix) {
    console.log("\nAuto-fixing: reindexing...");
    cmdIndex();
  } else {
    console.log(`\n${issues.length} issue(s). Run 'doctor --fix' to auto-fix where possible.`);
  }
}

function cmdGenerateTestNotes() {
  const base = join(getVault(), "notes-demo");
  const daily = join(base, "daily");
  const tpl = join(getVault(), "templates");
  mkdirSync(base, { recursive: true });
  mkdirSync(daily, { recursive: true });
  mkdirSync(tpl, { recursive: true });
  if (!existsSync(getTemplate())) {
    writeFileSync(getTemplate(), `---\nid: "{{date:YYYYMMDD}}-DAILY"\ndate: "{{date:YYYY-MM-DD}}"\naliases:\n  - "Daily {{date:YYYY-MM-DD}}"\ntags:\n  - daily\n  - journal\n---\n\n# Daily {{date:YYYY-MM-DD}}\n\n## Habits\n- [ ] sleep_7h\n- [ ] meds_am\n- [ ] walk_30m\n- [ ] reading_30m\n\n## Notes\n- \n\n## Tasks\n- [ ] \n`);
  }
  const files: Record<string,string> = {
    "notes-demo/0001-index.md": `---\nid: demo-index\naliases:\n  - demo home\ntags:\n  - demo\n  - index\n---\n# Demo Notes Index\n\nWelcome to the demo vault. Try [[0002-projects|Projects]], [[0003-books|Books]], and [[0004-health|Health]].\n\n- [ ] test fuzzy note finding\n- [x] test backlinks\n`,
    "notes-demo/0002-projects.md": `---\nid: demo-projects\naliases:\n  - Projects\ntags:\n  - demo\n  - projects\n---\n# Projects\n\nLinked from [[0001-index|Demo Notes Index]].\n\n## Ideas\n- notes TUI\n- habit statistics\n- jj-backed sync workflow\n`,
    "notes-demo/0003-books.md": `---\nid: demo-books\naliases:\n  - Reading\ntags:\n  - demo\n  - books\n---\n# Books\n\nSee also [[0002-projects|Projects]].\n\n- [ ] A Pattern Language\n- [ ] Gödel, Escher, Bach\n- [x] The Little Schemer\n`,
    "notes-demo/0004-health.md": `---\nid: demo-health\naliases:\n  - Health\ntags:\n  - demo\n  - habits\n---\n# Health\n\nDaily habits are tracked in [[daily/2026-05-18|today's note]].\n`,
    "notes-demo/daily/2026-05-18.md": `---\nid: 20260518-DAILY\ndate: "2026-05-18"\naliases:\n  - Daily 2026-05-18\ntags:\n  - daily\n  - journal\n  - demo\n---\n# Daily 2026-05-18\n\n## Habits\n- [x] sleep_7h\n- [x] meds_am\n- [ ] walk_30m\n- [x] reading_30m\n\n## Notes\n- Try backlinks to [[0004-health|Health]].\n\n## Tasks\n- [x] write demo note\n- [ ] test television channel\n`,
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(getVault(), path), content);
  cmdIndex();
  console.log(`Generated demo notes in ${relative(getVault(), base)}`);
}

function categoryFor(tags: string[], slug: string) {
  if (tags.includes("math") || tags.includes("geometry")) return "notes/math";
  if (tags.includes("health")) return "notes/health";
  if (tags.includes("planning") || tags.includes("adhd")) return "notes/learning";
  if (tags.includes("me") || slug.includes("self") || slug.includes("home")) return "notes/personal";
  if (slug.includes("reading") || slug.includes("book")) return "notes/reading";
  return "notes/general";
}


function indexVault(vaultPath: string) {
  const files = walkMd(vaultPath).filter(path => {
    const relativePath = relative(vaultPath, path);
    return !relativePath.startsWith("templates/") || basename(path) === "daily-note.md";
  });
  const notes: Note[] = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const { fm, body } = parseFrontmatter(text);
    const stem = basename(path, ".md");
    notes.push({
      id: String(fm.id ?? stem),
      stem,
      path: relative(vaultPath, path),
      title: (body.match(H1_RE)?.[1] ?? stem).trim(),
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
      slug: typeof fm.slug === "string" ? fm.slug : undefined,
      legacy_id: typeof fm.legacy_id === "string" ? fm.legacy_id : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
      tags: parseTags(fm.tags, body),
      links: parseLinks(body),
      backlinks: [],
      tasks: parseTasks(body),
      habits: parseHabits(body),
      mtime: statSync(path).mtimeMs,
    });
  }
  const targetToId = new Map<string, string>();
  for (const n of notes) {
    targetToId.set(n.stem, n.id);
    targetToId.set(n.id, n.id);
    targetToId.set(n.path.replace(/\.md$/, ""), n.id);
    if (n.slug) targetToId.set(n.slug, n.id);
    if (n.legacy_id) targetToId.set(n.legacy_id, n.id);
  }
  for (const n of notes) n.links = n.links.map(l => targetToId.get(l) ?? l);
  const inbound = new Map<string, Set<string>>();
  for (const n of notes) for (const l of n.links) getOrCreate(inbound, l, () => new Set()).add(n.id);
  for (const n of notes) n.backlinks = [...(inbound.get(n.id) ?? new Set())].sort();
  mkdirSync(vaultPath, { recursive: true });
  writeFileSync(join(vaultPath, ".notes_index.json"), JSON.stringify(notes, null, 2));
  return notes;
}


function cmdInit() {
  const root = process.cwd();
  // Home directory warning disabled for now
  // if (root === home) { ... }
  
  const jjCheck = spawnSync("jj", ["root"], { cwd: root, encoding: "utf8" });
  if (jjCheck.status !== 0) {
    console.log("Initializing jj repo...");
    const r = spawnSync("jj", ["git", "init"], { cwd: root, stdio: "inherit" });
    if ((r.status ?? 0) !== 0) {
      console.log("jj git init failed, trying jj init...");
      spawnSync("jj", ["init"], { cwd: root, stdio: "inherit" });
    }
  }
  const notesRoot = process.env.NOTES_ROOT || root;
  for (const d of ["inbox", "notes/general", "projects", "daily", "archive", "templates", "config"]) {
    mkdirSync(join(notesRoot, d), { recursive: true });
  }
  // config
  const configDir = join(notesRoot, "config");
  const habitsPath = join(configDir, "habits.yaml");
  const vaultConfigPath = join(configDir, "vault.yaml");
  mkdirSync(configDir, { recursive: true });
  if (!existsSync(habitsPath)) {
    writeFileSync(habitsPath, `habits:\n  sleep_7h:\n    title: Sleep 7h+\n  meds_am:\n    title: Morning meds\n  walk_30m:\n    title: Walk 30m+\n`);
  }
  if (!existsSync(vaultConfigPath)) {
    writeFileSync(vaultConfigPath, `jj:\n  aliases:\n    sync:\n      - jj status\n      - jj git push\n    snapshot:\n      - jj status\n      - jj describe -m "notes snapshot"\n      - jj new\n    review:\n      - jj status\n      - jj diff\n`);
  }

  // daily template
  const dailyTpl = join(notesRoot, "templates", "daily-note.md");
  if (!existsSync(dailyTpl)) {
    writeFileSync(dailyTpl, `# Daily — {{date:YYYY-MM-DD}}\n\n## Notes\n\n## Tasks\n- [ ] \n\n## Habits\n\n`);
  }

  // habits.yaml
  if (!existsSync(habitsPath)) {
    writeFileSync(habitsPath, `habits:\n  sleep_7h:\n    title: Sleep 7h+\n  meds_am:\n    title: Morning meds\n  walk_30m:\n    title: Walk 30m+\n`);
  }

  // today's daily
  const d = new Date().toISOString().slice(0, 10);
  const todayPath = join(notesRoot, "daily", `${d}.md`);
  if (!existsSync(todayPath)) {
    const dailyTplPath = join(notesRoot, "templates", "daily-note.md");
    const dailyTplText = readFileSync(dailyTplPath, "utf8");
    const dailyContent = dailyTplText.replaceAll("{{date:YYYYMMDD}}", d.replaceAll("-", "")).replaceAll("{{date:YYYY-MM-DD}}", d);
    writeFileSync(todayPath, dailyContent);
  }

  console.log(`Initialized notes vault at ${notesRoot}`);
  const notes = indexVault(notesRoot);
  console.log(`Indexed ${notes.length} notes -> ${join(notesRoot, ".notes_index.json")}` );
}

function cmdTutorial() {
  // non-hidden so walkMd indexes it
  const tutDir = join(getVault(), "tutorial");
  mkdirSync(tutDir, { recursive: true });
  mkdirSync(join(getVault(), "projects"), { recursive: true });

  function writeSeed(slug: string, tags: string[], lines: string[]) {
    writeFileSync(
      join(tutDir, `${slug}.md`),
      yamlStringify({ id: randomId(), slug, type: "note", tags }) + lines.join("\n"),
    );
  }
  writeSeed("getting-started", ["tutorial"], [
    "# Getting Started", "",
    "Welcome to your notes vault!", "",
    "## Tasks",
    "- [ ] Read the getting started guide",
    "- [ ] Set up your habit tracker",
    "- [x] Install notes CLI", "",
    "See also: [[writing-tips]] and [[project-alpha]]",
  ]);
  writeSeed("writing-tips", ["tutorial", "writing"], [
    "# Writing Tips", "",
    "Good notes are short, linked, and searchable.", "",
    "- Use #tags for topics",
    "- Use [[wikilinks]] to connect ideas", "",
    "Back to: [[getting-started]]",
  ]);
  writeSeed("project-alpha", ["tutorial", "project", "active"], [
    "# Project Alpha", "",
    "## Tasks",
    "- [ ] Define scope",
    "- [ ] Write spec",
    "- [x] Kick-off meeting", "",
    "Related: [[getting-started]]",
  ]);
  writeSeed("scratch", ["tutorial"], [
    "# Scratch Note", "",
    "This note exists for the move exercise.",
  ]);

  cmdIndex();

  const isSrc = process.argv[1].endsWith(".ts");
  const self = isSrc ? ["bun", process.argv[1]] : [process.argv[1]];

  function runNotes(userInput: string): string {
    const stripped = userInput.replace(/^notes\s+/, "").trim();
    const args = stripped.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map(a => a.replace(/^"|"$|^'|'$/g, "")) ?? [];
    const r = spawnSync(self[0], [...self.slice(1), ...args], {
      encoding: "utf8",
      env: { ...process.env, NOTES_ROOT: getVault() },
    });
    return ((r.stdout ?? "") + (r.stderr ? `\n${r.stderr}` : "")).trim();
  }

  function readInput(header: string): string {
    const r = spawnSync("fzf", [
      "--prompt", "notes > ",
      "--print-query",
      "--height", "8",
      "--border", "rounded",
      "--no-info",
      "--color", "bg+:#1f2335,fg+:#c0caf5,hl:#7aa2f7,prompt:#7dcfff,border:#3b4261",
      "--header", `${header}  (skip / q to quit)`,
    ], { encoding: "utf8", input: "" });
    return ((r.stdout ?? "").split("\n")[0] ?? "").trim();
  }

  function pick(prompt: string, options: string[]): string {
    const r = spawnSync("fzf", [
      "--prompt", `  ${prompt} > `,
      "--height", "6",
      "--border", "rounded",
      "--no-info",
      "--color", "bg+:#1f2335,fg+:#c0caf5,prompt:#7dcfff,border:#3b4261",
    ], { encoding: "utf8", input: options.join("\n") });
    return (r.stdout ?? "").trim();
  }

  const LINE = "─".repeat(54);

  function runStep(
    n: number, total: number,
    title: string,
    desc: string[],
    hint: string,
    verify: (out: string) => boolean,
  ): "pass" | "skip" | "abort" {
    while (true) {
      console.clear();
      console.log(`\n  Step ${n}/${total}  —  ${title}`);
      console.log(`  ${LINE}`);
      for (const line of desc) console.log(`  ${line}`);
      console.log(`\n  Hint:  notes ${hint}\n`);

      const input = readInput(`Step ${n}/${total}: ${title}`);
      if (!input || input === "q" || input === "quit") return "abort";
      if (input === "skip" || input === "s") return "skip";

      const out = runNotes(input);
      console.log(`\n${out || "(no output)"}\n`);

      if (verify(out)) {
        console.log("  Correct!\n");
        const isLast = n === total;
        const choice = pick("", isLast ? ["finish tutorial", "quit early"] : ["next step", "quit tutorial"]);
        return choice.startsWith("quit") ? "abort" : "pass";
      }

      console.log("   Not quite — check the hint and try again.\n");
      const retry = pick("", ["try again", "skip this step", "quit tutorial"]);
      if (retry.startsWith("quit")) return "abort";
      if (retry.startsWith("skip")) return "skip";
    }
  }

  const inboxPath = join(getVault(), "inbox", "inbox.md");
  const PING = `tut-${Date.now()}`;

  const steps: Array<{
    title: string;
    desc: string[];
    hint: string;
    verify: (out: string) => boolean;
  }> = [
    {
      title: "Index",
      desc: [
        "Before searching, the vault index must be built.",
        "'index' scans all markdown files and caches metadata.",
        "Run it after adding or moving notes.",
      ],
      hint: "index",
      verify: out => out.includes("Indexed"),
    },
    {
      title: "Search by tag",
      desc: [
        "'search <query>' matches note titles, tags, aliases, and IDs.",
        "Three tutorial notes exist: getting-started, writing-tips, project-alpha.",
        "Find the one tagged #writing.",
      ],
      hint: "search writing",
      verify: out => out.toLowerCase().includes("writing"),
    },
    {
      title: "Backlinks",
      desc: [
        "Backlinks show which notes link to a given note.",
        "Both writing-tips and project-alpha link to [[getting-started]].",
        "Verify this by finding backlinks for getting-started.",
      ],
      hint: "backlinks getting-started",
      verify: out => out.includes("writing-tips") || out.includes("project-alpha"),
    },
    {
      title: "Orphans",
      desc: [
        "Orphans are notes that no other note links to.",
        "scratch has no incoming links — it should appear here.",
        "Find all orphaned notes.",
      ],
      hint: "orphans",
      verify: out => out.includes("scratch"),
    },
    {
      title: "Open tasks",
      desc: [
        "'tasks open' lists every unchecked task across your vault.",
        "getting-started and project-alpha both have open tasks.",
        "List them.",
      ],
      hint: "tasks open",
      verify: out => out.includes("[ ]"),
    },
    {
      title: "Quick capture",
      desc: [
        "'quick <text>' appends a timestamped line to your inbox instantly.",
        `Capture this exact text so we can verify it landed:`,
        `  ${PING}`,
      ],
      hint: `quick ${PING}`,
      verify: _out =>
        existsSync(inboxPath) && readFileSync(inboxPath, "utf8").includes(PING),
    },
    {
      title: "Move a note",
      desc: [
        "'move <slug> <folder>' moves a note to a different folder.",
        "Move the scratch note into the projects folder.",
        "Format: move <slug> <folder>",
      ],
      hint: "move scratch projects",
      verify: _out => existsSync(join(getVault(), "projects", "scratch.md")),
    },
    {
      title: "Stats",
      desc: [
        "'stats' shows a dashboard: note count, tasks, top tags, habit streaks.",
        "Run it to see your vault at a glance.",
      ],
      hint: "stats",
      verify: out => out.includes("Notes:"),
    },
  ];

  console.clear();
  console.log("\n  ══════════════════════════════════════════════════════");
  console.log("  notes interactive tutorial");
  console.log("  ══════════════════════════════════════════════════════\n");
  console.log("  4 practice notes created. Each step gives you a task.");
  console.log("  Type the command yourself — the tutorial verifies the result.\n");

  const start = pick("", ["start tutorial", "quit"]);
  if (!start || start.startsWith("quit")) return cleanup();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const result = runStep(i + 1, steps.length, s.title, s.desc, s.hint, s.verify);
    if (result === "abort") break;
  }

  console.clear();
  console.log("\n  Tutorial complete!\n");
  console.log("  Commands you practised:");
  console.log("  index · search · backlinks · orphans · tasks · quick · move · stats\n");
  console.log("  What's next:");
  console.log("  notes today          open today's daily note");
  console.log("  notes find           fuzzy-pick any note with action menu");
  console.log("  notes habit <key>    toggle a habit in today's daily note");
  console.log("  notes new <title>    create a new note from template\n");
  pick("", ["done"]);

  cleanup();

  function cleanup() {
    spawnSync("rm", ["-rf", tutDir]);
    const movedScratch = join(getVault(), "projects", "scratch.md");
    if (existsSync(movedScratch)) spawnSync("rm", ["-f", movedScratch]);
    cmdIndex();
  }
}

function cmdMigrate() {
  ensureConfig();
  for (const d of ["inbox", "notes", "projects", "daily", "archive", "templates", "config"]) mkdirSync(join(getVault(), d), { recursive: true });
  const linkMap = new Map<string, string>();
  const rootFiles = readdirSync(getVault(), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "inbox.md")
    .map(e => join(getVault(), e.name));
  for (const p of rootFiles) {
    const txt = readFileSync(p, "utf8");
    const { fm, body } = parseFrontmatter(txt);
    const title = (body.match(H1_RE)?.[1] ?? basename(p, ".md")).trim();
    const slugSource = String((fm.slug ?? (Array.isArray(fm.aliases) ? fm.aliases[0] : "")) || title);
    const slug = slugify(slugSource);
    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
    const dir = categoryFor(tags, slug);
    const destRel = `${dir}/${slug}.md`;
    const newFm = {
      id: randomId(),
      legacy_id: String(fm.id ?? basename(p, ".md")),
      slug,
      aliases: Array.isArray(fm.aliases) ? fm.aliases : [],
      tags,
      type: "note",
    };
    mkdirSync(join(getVault(), dir), { recursive: true });
    writeFileSync(join(getVault(), destRel), yamlStringify(newFm) + body.trimStart());
    linkMap.set(basename(p, ".md"), destRel.replace(/\.md$/, ""));
    if (fm.id) linkMap.set(String(fm.id), destRel.replace(/\.md$/, ""));
    renameSync(p, join(getVault(), "archive", basename(p)));
    console.log(`${basename(p)} -> ${destRel}`);
  }
  for (const p of walkMd(getVault())) {
    let txt = readFileSync(p, "utf8");
    for (const [oldTarget, newTarget] of linkMap) {
      txt = txt.replaceAll(`[[${oldTarget}|`, `[[${newTarget}|`);
      txt = txt.replaceAll(`[[${oldTarget}]]`, `[[${newTarget}]]`);
    }
    writeFileSync(p, txt);
  }
  const inbox = join(getVault(), "inbox", "inbox.md");
  if (!existsSync(inbox)) writeFileSync(inbox, `${yamlStringify({id: randomId(), slug: "inbox", type: "inbox", tags: ["inbox"]})}# Inbox\n\n`);
  cmdIndex();
}

function cmdStats() {
  const notes = loadIndex();
  const tags = new Map<string, number>();
  const { done: tasksDone, total: tasksTotal } = countTasks(notes);
  const habitMap = new Map<string, Array<{ date: string; done: boolean }>>();
  for (const n of notes) {
    for (const t of n.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    const date = getDailyDate(n.path);
    if (!date) continue;
    for (const h of n.habits) getOrCreate(habitMap, h.key, () => []).push({ date, done: h.done });
  }
  console.log(`Notes: ${notes.length}`);
  console.log(`Tasks: ${tasksDone}/${tasksTotal}`);
  console.log("Top tags:");
  for (const [k, v] of [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`- ${k}: ${v}`);
  if (habitMap.size) {
    console.log("Habit consistency:");
    for (const [k, arr] of habitMap.entries()) {
      const done = arr.filter(x => x.done).length;
      const total = arr.length;
      const pct = Math.round((done / Math.max(1, total)) * 100);
      console.log(`- ${k}: ${done}/${total} (${pct}%), streak=${streak(arr)}d`);
    }
  }
}

function cmdPreview(note = "") {
  const picked = note ? pickNote(note) : pickNote();
  const direct = picked ? vaultPath(picked.path) : note ? vaultPath(note) : "";
  const p = direct && existsSync(direct) ? direct : walkMd(getVault()).find(x => basename(x, ".md") === note);
  if (!p) return console.log("Note not found");
  const src = readFileSync(p, "utf8");
  const r = spawnSync("dprint", ["fmt", "--stdin", p], { input: src, encoding: "utf8" });
  const out = (r.stdout || "").trim();
  console.log(out || src);
}

function cmdView(note = "") {
  const picked = note ? pickNote(note) : pickNote();
  const direct = picked ? vaultPath(picked.path) : note ? vaultPath(note) : "";
  const p = direct && existsSync(direct) ? direct : walkMd(getVault()).find(x => basename(x, ".md") === note);
  if (!p) return console.log("Note not found");
  const src = readFileSync(p, "utf8");
  console.log(`\x1b[1;36m${relative(getVault(), p)}\x1b[0m\n`);
  const r = spawnSync("dprint", ["fmt", "--stdin", p], { input: src, encoding: "utf8" });
  console.log((r.stdout || src).trim());
}

function cmdJj(args: string[]) {
  const bin = spawnSync("bash", ["-lc", "command -v jj"], { encoding: "utf8" }).stdout.trim();
  if (!bin) return console.log("jj not found in PATH");
  spawnSync("jj", args, { stdio: "inherit" });
}

function listJjRemotes(cwd = getVault()) {
  const r = spawnSync("jj", ["git", "remote", "list"], { cwd, encoding: "utf8" });
  return (r.stdout || "")
    .split("\n")
    .map(line => line.trim().split(/\s+/, 1)[0])
    .filter(Boolean);
}

function hasJjRemote(cwd = getVault()) {
  return listJjRemotes(cwd).length > 0;
}

function hasBookmark(name: string, cwd = getVault()) {
  const r = spawnSync("jj", ["bookmark", "list", name], { cwd, encoding: "utf8" });
  return (r.stdout || "").trim().length > 0;
}

function hasRemoteBookmark(remote: string, name: string, cwd = getVault()) {
  const r = spawnSync("jj", ["bookmark", "list", "--remote", remote, "--tracked", name], { cwd, encoding: "utf8" });
  return (r.stdout || "").trim().length > 0;
}

function emitTuiStatus(msg: string) {
  _tuiStatus?.(msg);
}

function emitTuiStream(line: string) {
  if (_tuiStream) _tuiStream(line);
  else console.log(line);
}

function runJjAsync(args: string[], cwd = getVault()) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("jj", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.on("close", code => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function runJjStream(args: string[], cwd = getVault(), onLine?: (line: string) => void) {
  return new Promise<{ code: number }>((resolve) => {
    const wrapped = ["-q", "/dev/null", "jj", ...args];
    const child = spawn("script", wrapped, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const emit = (text: string) => {
      const clean = text.replace(/[\u0004\u0008]/g, "").replace(/\r/g, "\n");
      for (const line of clean.split("\n")) {
        if (line.trim().length) (onLine ?? emitTuiStream)(line);
      }
    };
    child.stdout?.on("data", chunk => emit(String(chunk)));
    child.stderr?.on("data", chunk => emit(String(chunk)));
    child.on("close", code => resolve({ code: code ?? 0 }));
  });
}

function parseDiffStat(text: string) {
  const m = text.match(/(\d+) files? changed, (\d+) insertions?\(\+\), (\d+) deletions?\(-\)/);
  if (m) return { files: Number(m[1]), insertions: Number(m[2]), deletions: Number(m[3]) };
  const n = text.match(/(\d+) files? changed/);
  if (n) return { files: Number(n[1]), insertions: 0, deletions: 0 };
  return null;
}

async function ensureJjSyncRemote(): Promise<string | undefined> {
  const remotes = listJjRemotes();
  if (remotes.length) return remotes.includes("origin") ? "origin" : remotes[0];
  emitTuiStatus("sync: remote missing — enter URL");
  const remoteUrl = promptUser("remote url");
  if (!remoteUrl) return undefined;
  emitTuiStatus("sync: adding remote origin");
  const r = await runJjStream(["git", "remote", "add", "origin", remoteUrl]);
  if (r.code !== 0) {
    console.log("failed to add remote");
    return undefined;
  }
  return "origin";
}

async function cmdJjSync() {
  const remote = await ensureJjSyncRemote();
  if (!remote) return;

  emitTuiStatus("sync: bookmark main");
  if (hasBookmark("main")) {
    const move = await runJjStream(["bookmark", "move", "main", "--to", "@", "--allow-backwards"]);
    if (move.code !== 0) {
      emitTuiStatus("sync: bookmark move failed");
      console.log("failed to move bookmark main");
      return;
    }
  } else {
    const set = await runJjStream(["bookmark", "set", "main"]);
    if (set.code !== 0) {
      emitTuiStatus("sync: bookmark create failed");
      console.log("failed to create bookmark main");
      return;
    }
  }

  const track = await runJjStream(["bookmark", "track", "main", "--remote", remote]);
  if (track.code !== 0) {
    emitTuiStatus("sync: bookmark track failed");
    console.log("failed to track bookmark main");
    return;
  }

  emitTuiStatus("sync: describe changes");
  const stat = await runJjAsync(["diff", "--stat"]);
  if (stat.code === 0) {
    const summary = parseDiffStat(stat.stdout) ?? { files: 0, insertions: 0, deletions: 0 };
    const msg = summary.files ? `sync: ${summary.files} files, +${summary.insertions}/-${summary.deletions}` : "sync: clean";
    const desc = await runJjStream(["describe", "-m", msg]);
    if (desc.code !== 0) {
      emitTuiStatus("sync: describe failed");
      console.log("failed to describe changes");
      return;
    }
  }

  emitTuiStatus(`sync: fetch ${remote}`);
  const fetch = await runJjStream(["git", "fetch", "--remote", remote, "--tracked"]);
  if (fetch.code !== 0) {
    emitTuiStatus("sync: fetch failed");
    console.log("fetch failed");
    return;
  }

  if (hasRemoteBookmark(remote, "main")) {
    const compare = await runJjAsync(["log", "--count", "-r", `main..main@${remote} | main@${remote}..main`]);
    if (compare.code !== 0) {
      emitTuiStatus("sync: compare failed");
      console.log("failed to compare bookmarks");
      return;
    }
    const changed = Number(compare.stdout.trim() || "0");
    if (changed > 0) {
      emitTuiStatus(`sync: rebase onto main@${remote}`);
      const rebase = await runJjStream(["rebase", "-s", "main", "-o", `main@${remote}`]);
      if (rebase.code !== 0) {
        emitTuiStatus("sync: conflict — resolve manually");
        console.log("Resolve conflicts, then rerun sync.");
        return;
      }
    }
  }

  emitTuiStatus(`sync: push ${remote}`);
  const push = await runJjStream(["git", "push", "--remote", remote, "--tracked"]);
  if (push.code !== 0) {
    emitTuiStatus("sync: push failed");
    console.log("push failed");
    return;
  }
  emitTuiStatus("sync: done");
}

function cmdJjAlias(name: string) {
  const aliases: Record<string, string[][]> = {
    snapshot: [["status"], ["describe", "-m", "notes snapshot"], ["new"]],
    review: [["status"], ["diff"]],
  };
  if (name === "sync") return cmdJjSync();
  const steps = aliases[name];
  if (!steps) return console.log(`Unknown jj alias: ${name}`);
  for (const args of steps) {
    console.log(`$ jj ${args.join(" ")}`);
    const r = spawnSync("jj", args, { cwd: getVault(), stdio: "inherit" });
    if ((r.status ?? 0) !== 0) break;
  }
}

function cmdJjTui() {
  const choices = ["status", "log", "diff", "bookmark list", "git remote -v"];
  const r = withSuspend(() => spawnSync("fzf", ["--prompt", "jj> ", "--height", "40%", "--border"], { input: choices.join("\n"), encoding: "utf8" }));
  const c = (r.stdout || "").trim();
  if (!c) return;
  withSuspend(() => cmdJj(c.split(" ")));
}

function tvConfigDir() {
  return join(homedir(), ".config", "television", "cable");
}

function cmdTvItems(kind: string) {
  const notes = loadIndex();
  if (kind === "notes" || kind === "recent") {
    const list = kind === "recent" ? [...notes].sort((a, b) => b.mtime - a.mtime) : notes;
    for (const n of list) console.log(`${n.path}\t${n.title}\t${n.tags.join(",")}`);
    return;
  }
  if (kind === "tasks") {
    const vault = getVault();
    for (const n of notes) {
      const p = vaultPath(n.path);
      if (!existsSync(p)) continue;
      const lines = readFileSync(p, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TASK_RE);
        if (!m) continue;
        const status = m[1].toLowerCase() === "x" ? "done" : "open";
        const taskId = `${n.path}:${i + 1}`;
        console.log(`${taskId}\t${status}\t${m[2]}`);
      }
    }
    return;
  }
  if (kind === "dailies") {
    notes.filter(n => DAILY_NOTE_RE.test(n.path))
      .sort((a, b) => (a.path < b.path ? 1 : -1))
      .forEach(n => {
        const done = n.habits.filter(h => h.done).length;
        const total = n.habits.length;
        console.log(`${n.path}\t${done}/${total}\t${n.title}`);
      });
    return;
  }
  if (kind === "habits") {
    const today = new Date().toISOString().slice(0, 10);
    const map = new Map<string, Array<{ date: string; done: boolean }>>();
    const vault = getVault();
    for (const n of notes) {
      const date = getDailyDate(n.path);
      if (!date) continue;
      for (const h of n.habits) getOrCreate(map, h.key, () => []).push({ date, done: h.done });
    }
    for (const key of readHabitKeys()) {
      const arr = map.get(key) ?? [];
      const doneCount = arr.filter(x => x.done).length;
      const pct = Math.round((doneCount / Math.max(1, arr.length)) * 100);
      const todayState = arr.find(x => x.date === today)?.done ? "done" : "open";
      console.log(`${key}\t${todayState}\t${doneCount}/${arr.length}\t${pct}%\tstreak:${streak(arr)}d`);
    }
    return;
  }
}

function cmdTvOpenNote(raw: string) {
  const ref = raw.split("\t")[0]?.trim();
  if (!ref) return;
  const taskRef = parseTaskRef(ref);
  const file = taskRef?.path ?? ref;
  openInEditor(file);
}

function cmdTvPreview(raw: string, kind: string) {
  const first = raw.split("\t")[0]?.trim();
  if (!first) return;
  if (kind === "tasks") {
    const [taskId, status, text] = raw.split("\t");
    const parsed = parseTaskRef(taskId?.trim() ?? "");
    if (!parsed) return console.log(raw);
    const p = vaultPath(parsed.path);
    if (!existsSync(p)) return console.log(raw);
    const lines = readFileSync(p, "utf8").split("\n");
    const lineNumber = parsed.lineNumber;
    const start = Math.max(0, lineNumber - 3);
    const end = Math.min(lines.length, lineNumber + 2);
    const excerpt = lines.slice(start, end).map((line, idx) => {
      const actual = start + idx + 1;
      return `${actual === lineNumber ? ">" : " "} ${String(actual).padStart(3)} ${line}`;
    }).join("\n");
    console.log(`${taskId?.trim()}\nstatus: ${status}\ntask: ${text}\n\n${excerpt}`);
    return;
  }
  if (kind === "notes" || kind === "recent" || kind === "dailies") {
    const p = vaultPath(first);
    if (!existsSync(p)) return console.log(raw);
    const txt = readFileSync(p, "utf8");
    const { fm, body } = parseFrontmatter(txt);
    const title = (body.match(H1_RE)?.[1] ?? basename(p, ".md")).trim();
    const tags = Array.isArray(fm.tags) ? fm.tags.join(", ") : (fm.tags ?? "");
    const lines = body.split("\n").slice(0, 24).join("\n");
    console.log(`# ${title}\n${p}\ntags: ${tags}\n\n${lines}`);
    return;
  }
  if (kind === "habits") {
    const [habit, status, ratio, pct, streakTxt] = raw.split("\t");
    const notes = loadIndex().filter(n => DAILY_NOTE_RE.test(n.path)).sort((a, b) => a.path < b.path ? -1 : 1);
    const trend: string[] = [];
    for (const n of notes.slice(-30)) {
      const h = n.habits.find(x => x.key === habit);
      trend.push(h ? (h.done ? "x" : ".") : " ");
    }
    console.log(`Habit: ${habit}\nToday: ${status}\nDone: ${ratio} (${pct}) ${streakTxt}\n\nLast 30 days:\n${trend.join("")}`);
    return;
  }
}

function cmdTvInstallChannels() {
  const dir = tvConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const b = "bonsai 2>/dev/null";
  const header = (name: string, desc: string, kind: string) =>
    `# generated by bonsai\n[metadata]\nname = "${name}"\ndescription = "${desc}"\n\n[source]\ncommand = "${b} tv items ${kind}"\n\n[preview]\ncommand = "${b} tv preview ${kind} '{}'"\n\n`;
  const simpleOpen = `[keybindings]\nctrl-e = "actions:open"\n\n[actions.open]\ncommand = "${b} tv open-note '{}'"\nmode = "execute"\n`;
  writeFileSync(join(dir, "notes.toml"),   header("notes",   "Vault notes",  "notes")   + simpleOpen);
  writeFileSync(join(dir, "recent.toml"),  header("recent",  "Recent notes", "recent")  + simpleOpen);
  writeFileSync(join(dir, "dailies.toml"), header("dailies", "Daily notes",  "dailies") + simpleOpen);
  writeFileSync(join(dir, "habits.toml"),  header("habits",  "Habit streaks", "habits") +
    `[keybindings]\nctrl-e = "actions:open"\nctrl-t = "actions:check"\nctrl-d = "actions:delete"\n\n[actions.open]\ncommand = "${b} tv open-note '{}'"\nmode = "execute"\n\n[actions.check]\ndescription = "Check for today"\ncommand = "${b} habits check '{}'"\nmode = "execute"\n\n[actions.delete]\ndescription = "Remove habit"\ncommand = "${b} habits delete '{}'"\nmode = "execute"\n`);
  writeFileSync(join(dir, "tasks.toml"),   header("tasks",   "Tasks",         "tasks") +
    `[keybindings]\nctrl-e = "actions:open"\nctrl-t = "actions:toggle"\nctrl-c = "actions:close"\nctrl-d = "actions:delete"\n\n[actions.open]\ncommand = "${b} tv open-note '{}'"\nmode = "execute"\n\n[actions.toggle]\ndescription = "Toggle task"\ncommand = "${b} tasks toggle '{}'"\nmode = "execute"\n\n[actions.close]\ndescription = "Close task"\ncommand = "${b} tasks close '{}'"\nmode = "execute"\n\n[actions.delete]\ndescription = "Delete task"\ncommand = "${b} tasks delete '{}'"\nmode = "execute"\n`);
  console.log(`Wrote channels to ${dir}`);
}

function cmdTv(channel: string) {
  if (!channel) return console.log("Usage: tv <notes|recent|dailies|habits|tasks>");
  withSuspend(() => spawnSync("tv", [channel], { stdio: "inherit" }));
}

function cmdCommandBar() {
  const rows = [
    ["index", "Rebuild note index cache"],
    ["find", "Fuzzy note+content search, then action menu"],
    ["search ", "Search metadata (id/title/aliases/tags)"],
    ["backlinks ", "Show notes linking to a note"],
    ["daily open", "Create/open daily note"],
    ["daily habit-toggle ", "Toggle a habit checkbox in daily note"],
    ["stats", "Show vault/task/habit statistics"],
    ["init", "Initialize new vault + jj repo + templates"],
    ["tutorial", "Interactive guided walkthrough"],
    ["tui", "Open interactive TUI"],
    ["preview ", "Render note preview via dprint"],
    ["view ", "Pretty markdown view with header"],
    ["sync", "Run jj sync"],
    ["recent", "Browse recently modified notes"],
    ["tv install-channels", "Install television channels"],
  ];
  const input = rows.map(([c, d]) => `${c}\t${d}`).join("\n");
  const r = spawnSync("fzf", [
    "--ansi",
    "--prompt", "notes > ",
    "--height", "60%",
    "--layout", "reverse",
    "--border", "rounded",
    "--delimiter", "\t",
    "--with-nth", "1,2",
    "--preview", "printf '\x1b[38;5;117m%s\x1b[0m\n' {2}",
    "--color", "bg+:#1f2335,fg+:#c0caf5,hl:#7aa2f7,hl+:#7dcfff,pointer:#9ece6a,prompt:#7dcfff,border:#3b4261",
  ], { input, encoding: "utf8" });
  const out = (r.stdout || "").trim();
  if (!out) return;
  const c = out.split("\t")[0];
  console.log(`Run: bun notes.ts ${c}`);
}


export {
  type Task,
  type Habit,
  type Note,
  JJ_ROOT,
  PROJECT_ROOT,
  getVault,
  getIndex,
  getDailyDir,
  getTemplate,
  DAILY_NOTE_RE,
  detectVaultRoot,
  vaultPath,
  loadIndex,
  cmdIndex,
  cmdSearch,
  cmdBacklinks,
  openInEditor,
  withSuspend,
  promptUser,
  pickNote,
  pickHabit,
  pickDailyNote,
  pickFolder,
  cmdFind,
  findNote,
  cmdLinks,
  cmdArchive,
  cmdDailyOpen,
  cmdHabitToggle,
  countTasks,
  buildHabitMap,
  cmdNew,
  cmdQuick,
  cmdInbox,
  cmdRecent,
  cmdOrphans,
  cmdRename,
  cmdMove,
  cmdDelete,
  cmdTasks,
  cmdTasksAdd,
  cmdTaskAction,
  cmdHabitList,
  cmdHabitAdd,
  cmdHabitRemove,
  cmdHabitSet,
  cmdDailyHabitToggle,
  cmdHabitFill,
  cmdDailyNav,
  cmdDailyReview,
  cmdDoctor,
  cmdGenerateTestNotes,
  cmdInit,
  cmdTutorial,
  cmdMigrate,
  cmdStats,
  cmdPreview,
  cmdView,
  cmdJjAlias,
  cmdTvItems,
  cmdTvOpenNote,
  cmdTvPreview,
  cmdTvInstallChannels,
  cmdTv,
  cmdCommandBar,
  streak,
  getDailyDate,
};
