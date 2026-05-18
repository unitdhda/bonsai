#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, relative, basename, isAbsolute, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import React, {useEffect, useState} from "react";
import {Box, Text, render, useApp, useInput} from "ink";
import { type MascotRow, IMAGE_MASCOT_WIDTH, IMAGE_MASCOT_ROWS, mascot } from "./mascot.ts";

// Low-level terminal viewport renderer (cell buffer)
type CellStyle = { fg?: string; bg?: string; bold?: boolean; italic?: boolean; dim?: boolean };
type Cell = { char: string; style: CellStyle };
class TerminalScreen {
  width: number;
  height: number;
  buffer: Cell[][];
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.buffer = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ char: " ", style: {} }))
    );
  }
  resize() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.buffer = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ char: " ", style: {} }))
    );
  }
  clear() {
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++)
        this.buffer[y][x] = { char: " ", style: {} };
  }
  set(x: number, y: number, char: string, style: CellStyle = {}) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.buffer[y][x] = { char: char[0] || " ", style };
  }
  write(x: number, y: number, text: string, style: CellStyle = {}) {
    for (let i = 0; i < text.length; i++) this.set(x + i, y, text[i], style);
  }
  private sgr(s: CellStyle): string {
    const codes: number[] = [];
    if (s.bold) codes.push(1);
    if (s.italic) codes.push(3);
    if (s.dim) codes.push(2);
    if (s.fg) codes.push(38, 2, ...this.hexToRgb(s.fg));
    if (s.bg) codes.push(48, 2, ...this.hexToRgb(s.bg));
    return codes.length ? `\x1b[${codes.join(";")}m` : "";
  }
  private hexToRgb(hex: string): number[] {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }

  // Full redraw of the entire viewport (no scroll buffer)
  // Called once on TUI enter
  enter() {
    process.stdout.write(
      "\x1b[?1049h" +          // alternate screen (no scrollback)
      "\x1b[?25l" +            // hide cursor
      "\x1b[2J\x1b[3J" +       // clear + scrollback
      "\x1b[H" +               // cursor home
      `\x1b[1;${this.height}r` + // lock scroll region to viewport
      "\x1b[?1000h" +          // mouse tracking on
      "\x1b[?1002h" +          // button-event tracking
      "\x1b[?1006h" +          // SGR extended mouse
      "\x1b[?1007l"            // disable alternate scroll (wheel -> arrow keys)
    );
  }

  redraw() {
    let out = "\x1b[H"; // cursor home only — alt screen already entered
    for (let y = 0; y < this.height; y++) {
      let line = "";
      let prev = "";
      for (let x = 0; x < this.width; x++) {
        const c = this.buffer[y][x];
        const code = this.sgr(c.style);
        if (code !== prev) {
          line += prev ? "\x1b[0m" : "";
          line += code;
          prev = code;
        }
        line += c.char;
      }
      line += "\x1b[0m";
      if (y < this.height - 1) line += "\r\n";
      out += line;
    }
    process.stdout.write(out);
  }

  // Temporarily leave alt screen so external programs (fzf etc.) render normally
  suspend() {
    process.stdout.write(
      "\x1b[?1007h" +   // restore alternate scroll before leaving
      "\x1b[?1002l" +
      "\x1b[?1006l" +
      "\x1b[?1000l" +
      "\x1b[?1049l" +
      "\x1b[?25h"
    );
  }

  resume() {
    this.resize();
    process.stdout.write(
      "\x1b[?1049h" +
      "\x1b[?25l" +
      "\x1b[2J\x1b[3J" +
      "\x1b[H" +
      `\x1b[1;${this.height}r` +
      "\x1b[?1000h" +
      "\x1b[?1002h" +
      "\x1b[?1006h" +
      "\x1b[?1007l"
    );
  }

  cleanup() {
    process.stdout.write(
      "\x1b[?1007h" +
      "\x1b[?1002l" +
      "\x1b[?1006l" +
      "\x1b[?1000l" +
      "\x1b[?1049l" +
      "\x1b[?25h" +
      "\x1b[r"
    );
  }
}

type Task = { done: boolean; text: string };
type Habit = { key: string; done: boolean };
type Note = {
  id: string;
  stem: string;
  path: string;
  title: string;
  aliases: string[];
  slug?: string;
  legacy_id?: string;
  type?: string;
  tags: string[];
  links: string[];
  backlinks: string[];
  tasks: Task[];
  habits: Habit[];
  mtime: number;
};

function detectVaultRoot() {
  const r = spawnSync("jj", ["root"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

const JJ_ROOT = detectVaultRoot();
const PROJECT_ROOT = dirname(import.meta.path).startsWith("/$bunfs") ? process.cwd() : dirname(import.meta.path);
function getVault() { return process.env.NOTES_ROOT || join(JJ_ROOT, "notes-vault"); }
const VAULT = getVault();
const INDEX = join(VAULT, ".notes_index.json");
const DAILY_DIR = join(VAULT, "daily");
const TEMPLATE = join(VAULT, "templates", "daily-note.md");
function getConfigDir() { return join(getVault(), "config"); }
function getHabitsConfig() { return join(getConfigDir(), "habits.yaml"); }
const CONFIG_DIR = getConfigDir();
const HABITS_CONFIG = getHabitsConfig();
const VAULT_CONFIG = join(getConfigDir(), "vault.yaml");

function vaultPath(p: string) {
  return isAbsolute(p) ? p : join(VAULT, p);
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const MDLINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;
const TASK_RE = /^\s*- \[( |x|X)\] (.+)$/;
const H1_RE = /^#\s+(.+)$/m;
const TAG_RE = /(?<!\w)#([\w\-/]+)/g;
const HABIT_RE = /^\s*- \[( |x|X)\] ([a-zA-Z0-9_\-]+)\s*$/;

const IGNORE_DIRS = new Set([
  ".git", ".jj", ".obsidian", "node_modules", "Library", "Applications",
  "Desktop", "Downloads", "Movies", "Music", "Pictures", "Public", ".Trash", "archive",
]);

function walkMd(dir: string, out: string[] = []): string[] {
  let entries;
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

function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  if (!text.startsWith("---\n")) return { fm: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { fm: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + 5);
  const fm: Record<string, any> = {};
  let current: string | null = null;
  for (const line0 of raw.split("\n")) {
    const line = line0.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("  - ") && current) {
      (fm[current] ??= []).push(line.slice(4).trim().replace(/^"|"$/g, ""));
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!v) {
      fm[k] = [];
      current = k;
    } else if (v.startsWith("[") && v.endsWith("]")) {
      fm[k] = v.slice(1, -1).split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
      current = null;
    } else {
      fm[k] = v.replace(/^"|"$/g, "");
      current = null;
    }
  }
  return { fm, body };
}

function parseHabits(body: string): Habit[] {
  const lines = body.split("\n");
  let inHabits = false;
  const habits: Habit[] = [];
  for (const line of lines) {
    if (/^##\s+Habits\s*$/.test(line)) {
      inHabits = true;
      continue;
    }
    if (inHabits && /^##\s+/.test(line)) break;
    if (!inHabits) continue;
    const m = line.match(HABIT_RE);
    if (m) habits.push({ key: m[2], done: m[1].toLowerCase() === "x" });
  }
  return habits;
}

function collectNotes(): Note[] {
  const files = walkMd(VAULT).filter(p => !relative(VAULT, p).startsWith("templates/") || basename(p) === "daily-note.md");
  const notes: Note[] = [];
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    const { fm, body } = parseFrontmatter(text);
    const title = (body.match(H1_RE)?.[1] ?? basename(p, ".md")).trim();
    const tasks: Task[] = [];
    for (const l of body.split("\n")) {
      const m = l.match(TASK_RE);
      if (m) tasks.push({ done: m[1].toLowerCase() === "x", text: m[2] });
    }
    const links: string[] = [];
    for (const m of body.matchAll(WIKILINK_RE)) links.push(m[1].trim());
    for (const m of body.matchAll(MDLINK_RE)) if (m[1].endsWith(".md") && !m[1].includes("://")) links.push(basename(m[1], ".md"));
    const tags = new Set<string>();
    const fmTags = fm.tags;
    if (Array.isArray(fmTags)) fmTags.forEach(t => tags.add(String(t)));
    if (typeof fmTags === "string" && fmTags) tags.add(fmTags);
    for (const m of body.matchAll(TAG_RE)) tags.add(m[1]);
    const stem = basename(p, ".md");
    notes.push({
      id: String(fm.id ?? stem),
      stem,
      path: relative(VAULT, p),
      title,
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
      slug: typeof fm.slug === "string" ? fm.slug : undefined,
      legacy_id: typeof fm.legacy_id === "string" ? fm.legacy_id : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
      tags: [...tags].sort(),
      links,
      backlinks: [],
      tasks,
      habits: parseHabits(body),
      mtime: statSync(p).mtimeMs,
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
  for (const n of notes) for (const l of n.links) (inbound.get(l) ?? inbound.set(l, new Set()).get(l)!).add(n.id);
  for (const n of notes) n.backlinks = [...(inbound.get(n.id) ?? new Set())].sort();
  return notes;
}

function saveIndex(notes: Note[]) { writeFileSync(INDEX, JSON.stringify(notes, null, 2)); }
function loadIndex(force = false): Note[] {
  if (!force && existsSync(INDEX)) return JSON.parse(readFileSync(INDEX, "utf8"));
  const n = collectNotes();
  saveIndex(n);
  return n;
}

function cmdIndex() { const n = loadIndex(true); console.log(`Indexed ${n.length} notes -> ${INDEX}`); }

function randomId() {
  return crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
}

function slugify(s: string) {
  return s.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "note";
}

function yamlStringify(data: Record<string, any>) {
  const out: string[] = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      out.push(`${k}:`);
      for (const x of v) out.push(`  - ${x}`);
    } else {
      out.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  out.push("---", "");
  return out.join("\n");
}

function ensureConfig() {
  mkdirSync(getConfigDir(), { recursive: true });
  if (!existsSync(getHabitsConfig())) writeFileSync(getHabitsConfig(), `habits:\n  sleep_7h:\n    title: Sleep 7h+\n  meds_am:\n    title: Morning meds\n  walk_30m:\n    title: Walk 30m+\n  reading_30m:\n    title: Reading 30m+\n`);
  if (!existsSync(VAULT_CONFIG)) writeFileSync(VAULT_CONFIG, `jj:\n  aliases:\n    sync:\n      - jj status\n      - jj git push\n    snapshot:\n      - jj status\n      - jj describe -m "notes snapshot"\n      - jj new\n    review:\n      - jj status\n      - jj diff\n`);
}

function readHabitKeys() {
  ensureConfig();
  const txt = readFileSync(getHabitsConfig(), "utf8");
  const keys: string[] = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function syncDailyHabits(path: string) {
  const keys = readHabitKeys();
  let txt = readFileSync(path, "utf8");
  const existing = new Map(parseHabits(txt).map(h => [h.key, h.done]));
  const block = ["## Habits", ...keys.map(k => `- [${existing.get(k) ? "x" : " "}] ${k}`)].join("\n");
  if (/^##\s+Habits\s*$/m.test(txt)) {
    txt = txt.replace(/^##\s+Habits\s*$[\s\S]*?(?=^##\s+|$)/m, block + "\n\n");
  } else {
    txt += `\n\n${block}\n`;
  }
  writeFileSync(path, txt);
}

function cmdSearch(q: string) {
  const notes = loadIndex();
  const qq = q.toLowerCase();
  for (const n of notes) {
    const hay = `${n.id} ${n.title} ${n.aliases.join(" ")} ${n.tags.join(" ")}`.toLowerCase();
    if (hay.includes(qq)) console.log(`${n.id}\t${n.title}\t${n.path}`);
  }
}

function cmdBacklinks(note: string) {
  const notes = loadIndex();
  const n = findNote(note);
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
  if (editor) withSuspend(() => spawnSync(editor, [p], { stdio: "inherit" }));
  else console.log(relative(VAULT, p));
}

function selfCommand() {
  const self = process.argv[1];
  return self.endsWith(".ts") ? `bun ${self}` : self;
}

let _tuiScreen: TerminalScreen | null = null;

function withSuspend<T>(fn: () => T): T {
  _tuiScreen?.suspend();
  try { return fn(); }
  finally { _tuiScreen?.resume(); }
}

function promptUser(promptText: string, defaultVal = ""): string {
  const r = withSuspend(() => spawnSync("fzf", [
    "--prompt", promptText + " ❯ ",
    "--print-query",
    "--height", "30%",
    "--border", "rounded",
    "--no-info",
    "--no-multi"
  ], { encoding: "utf8", input: defaultVal ? defaultVal + "\n" : "" }));
  return (r.stdout || defaultVal).trim();
}

function cmdFind() {
  const notes = loadIndex();
  const rows = notes.map(n => {
    const body = readFileSync(vaultPath(n.path), "utf8").replace(/\s+/g, " ").slice(0, 1200);
    return `${n.path}\t${n.title}\t${n.tags.join(",")}\t${n.slug ?? ""}\t${body}`;
  }).join("\n");
  const r = withSuspend(() => spawnSync("fzf", [
    "--prompt", "note ❯ ", "--height", "60%", "--layout", "reverse", "--border", "rounded",
    "--delimiter", "\t", "--with-nth", "1,2,3", "--preview", `${selfCommand()} tv preview notes {}`,
  ], { input: rows, encoding: "utf8" }));
  const out = (r.stdout || "").trim();
  if (!out) return;
  const file = out.split("\t", 1)[0];
  const actions = ["open", "backlinks", "links", "preview", "copy path", "archive", "cancel"];
  const a = withSuspend(() => spawnSync("fzf", ["--prompt", "action ❯ ", "--height", "40%", "--border", "rounded"], { input: actions.join("\n"), encoding: "utf8" })).stdout.trim();
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

function cmdLinks(note: string) {
  const n = findNote(note);
  if (!n) return console.log("Note not found");
  console.log(`Links from ${n.id} (${n.title}):`);
  for (const l of n.links) console.log(`- ${l}`);
}

function cmdArchive(note: string) {
  const p = vaultPath(note);
  if (!existsSync(p)) return console.log("Note not found");
  const dest = join(VAULT, "archive", basename(p));
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(p, dest);
  cmdIndex();
  console.log(`Archived ${relative(VAULT, p)} -> ${relative(VAULT, dest)}`);
}

function renderDaily(date: string): string {
  const t = readFileSync(TEMPLATE, "utf8");
  return t.replaceAll("{{date:YYYYMMDD}}", date.replaceAll("-", "")).replaceAll("{{date:YYYY-MM-DD}}", date);
}

function cmdDailyOpen(date?: string) {
  const d = date ?? new Date().toISOString().slice(0, 10);
  if (!existsSync(DAILY_DIR)) mkdirSync(DAILY_DIR, { recursive: true });
  const p = join(DAILY_DIR, `${d}.md`);
  if (!existsSync(p)) {
    writeFileSync(p, renderDaily(d));
    console.log(`Created ${relative(VAULT, p)}`);
  }
  syncDailyHabits(p);
  openInEditor(p);
}

function cmdHabitToggle(habit: string, date?: string) {
  const d = date ?? new Date().toISOString().slice(0, 10);
  const p = join(DAILY_DIR, `${d}.md`);
  if (!existsSync(p)) return console.log(`Daily note missing: daily/${d}.md`);
  const lines = readFileSync(p, "utf8").split("\n");
  let inHabits = false, changed = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^##\s+Habits\s*$/.test(ln)) { inHabits = true; continue; }
    if (inHabits && /^##\s+/.test(ln)) break;
    if (!inHabits) continue;
    const m = ln.match(HABIT_RE);
    if (m && m[2] === habit) {
      lines[i] = `- [${m[1] === " " ? "x" : " "}] ${habit}`;
      changed = true;
      break;
    }
  }
  if (!changed) return console.log("Habit not found in Habits section");
  writeFileSync(p, lines.join("\n"));
  console.log(`Toggled ${habit} in daily/${d}.md`);
}

function streak(days: Array<{ date: string; done: boolean }>): number {
  const sorted = days.sort((a, b) => (a.date < b.date ? 1 : -1));
  let s = 0;
  for (const d of sorted) { if (d.done) s++; else break; }
  return s;
}

// ── new / quick / inbox ──────────────────────────────────────────────────────

const NOTE_TEMPLATE = join(VAULT, "templates", "note.md");
const PROJECT_TEMPLATE = join(VAULT, "templates", "project.md");

function renderNoteTemplate(title: string, type = "note", extraFm: Record<string,any> = {}): string {
  const tplPath = type === "project" ? PROJECT_TEMPLATE : NOTE_TEMPLATE;
  const tpl = existsSync(tplPath)
    ? readFileSync(tplPath, "utf8")
    : `# {{title}}\n\n`;
  const fm = { id: randomId(), slug: slugify(title), type, tags: [], ...extraFm };
  return yamlStringify(fm) + tpl.replace(/\{\{title\}\}/g, title);
}

function cmdNew(title: string, type = "note") {
  if (!title) {
    title = promptUser("note title");
    if (!title) return;
  }
  const dir = join(VAULT, type === "project" ? "projects" : "notes/general");
  mkdirSync(dir, { recursive: true });
  const slug = slugify(title);
  const p = join(dir, `${slug}.md`);
  if (existsSync(p)) return openInEditor(p);
  writeFileSync(p, renderNoteTemplate(title, type));
  cmdIndex();
  openInEditor(p);
}

function cmdQuick(text: string) {
  if (!text) {
    text = promptUser("quick capture");
    if (!text) return;
  }
  const inbox = join(VAULT, "inbox", "inbox.md");
  mkdirSync(dirname(inbox), { recursive: true });
  if (!existsSync(inbox)) writeFileSync(inbox, yamlStringify({id: randomId(), slug: "inbox", type: "inbox", tags: ["inbox"]}) + "# Inbox\n\n");
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `- ${ts}: ${text}\n`;
  const src = readFileSync(inbox, "utf8");
  writeFileSync(inbox, src.trimEnd() + "\n" + line);
  console.log(`Appended to inbox: ${text}`);
}

function cmdInbox() {
  const inbox = join(VAULT, "inbox", "inbox.md");
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
  const notes = loadIndex().filter(n => n.backlinks.length === 0 && !/^daily\//.test(n.path));
  if (!notes.length) { console.log("No orphans."); return; }
  for (const n of notes) console.log(`${n.path}  ${n.title}`);
}

// ── rename / move / delete ───────────────────────────────────────────────────

function cmdRename(note: string, newTitle: string) {
  const n = findNote(note);
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
  console.log(`Renamed: ${n.path} -> ${relative(VAULT, dest)}`);
}

function cmdMove(note: string, folder: string) {
  const n = findNote(note);
  if (!n) return console.log("Note not found");
  const p = vaultPath(n.path);
  const destDir = join(VAULT, folder);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, basename(p));
  if (existsSync(dest)) return console.log(`Destination already exists: ${dest}`);
  renameSync(p, dest);
  cmdIndex();
  console.log(`Moved: ${n.path} -> ${relative(VAULT, dest)}`);
}

function cmdDelete(note: string) {
  const n = findNote(note);
  if (!n) return console.log("Note not found");
  const p = vaultPath(n.path);
  const dest = join(VAULT, "archive", basename(p));
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(p, dest);
  cmdIndex();
  console.log(`Deleted (archived): ${n.path}`);
}

// ── tasks ────────────────────────────────────────────────────────────────────

function cmdTasks(filter?: string) {
  const notes = loadIndex();
  for (const n of notes) {
    const tasks = filter === "open" ? n.tasks.filter(t => !t.done)
      : filter === "done" ? n.tasks.filter(t => t.done)
      : n.tasks;
    if (!tasks.length) continue;
    console.log(`\n${n.path}  ${n.title}`);
    for (const t of tasks) console.log(`  ${t.done ? "[x]" : "[ ]"} ${t.text}`);
  }
}

function cmdTasksAdd(note: string, text: string) {
  const n = findNote(note);
  if (!n) return console.log("Note not found");
  const p = vaultPath(n.path);
  const src = readFileSync(p, "utf8").trimEnd();
  writeFileSync(p, src + `\n- [ ] ${text}\n`);
  cmdIndex();
  console.log(`Task added to ${n.path}`);
}

// ── habits ───────────────────────────────────────────────────────────────────

function cmdHabitList() {
  const keys = readHabitKeys();
  const notes = loadIndex();
  const habitMap = new Map<string, Array<{date: string; done: boolean}>>();
  for (const n of notes) {
    const date = /daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(n.path)?.[1];
    if (!date) continue;
    for (const h of n.habits) (habitMap.get(h.key) ?? habitMap.set(h.key, []).get(h.key)!).push({date, done: h.done});
  }
  for (const k of keys) {
    const arr = habitMap.get(k) ?? [];
    const done = arr.filter(x => x.done).length;
    const total = arr.length;
    const pct = Math.round(done / Math.max(1, total) * 100);
    const stk = streak(arr);
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    console.log(`${k.padEnd(16)} ${bar} ${pct}%  streak=${stk}d`);
  }
}

function cmdHabitAdd(key: string, title?: string) {
  if (!key) return console.log("Usage: habit add <key> [title]");
  ensureConfig();
  const src = readFileSync(getHabitsConfig(), "utf8").trimEnd();
  if (src.includes(`  ${key}:`)) return console.log(`Habit '${key}' already exists`);
  writeFileSync(getHabitsConfig(), src + `\n  ${key}:\n    title: ${title ?? key}\n`);
  console.log(`Added habit: ${key}`);
}

function cmdHabitRemove(key: string) {
  ensureConfig();
  const lines = readFileSync(getHabitsConfig(), "utf8").split("\n");
  let skip = false;
  const out: string[] = [];
  for (const l of lines) {
    if (l.match(new RegExp(`^  ${key}:\\s*$`))) { skip = true; continue; }
    if (skip && l.match(/^    /)) continue;
    skip = false;
    out.push(l);
  }
  writeFileSync(getHabitsConfig(), out.join("\n"));
  console.log(`Removed habit: ${key}`);
}

function cmdHabitFill(key: string, date: string) {
  const p = join(DAILY_DIR, `${date}.md`);
  if (!existsSync(p)) return console.log(`No daily note for ${date}`);
  cmdHabitToggle(key, date);
}

// ── daily helpers ─────────────────────────────────────────────────────────────

function cmdDailyNav(direction: "previous" | "next") {
  const files = readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const today = new Date().toISOString().slice(0, 10);
  const current = files.indexOf(`${today}.md`);
  const target = direction === "previous" ? files[current - 1] : files[current + 1];
  if (!target) return console.log(`No ${direction} daily note`);
  openInEditor(join(DAILY_DIR, target));
}

function cmdDailyReview() {
  const today = new Date().toISOString().slice(0, 10);
  const p = join(DAILY_DIR, `${today}.md`);
  if (!existsSync(p)) return console.log("No daily note for today");
  cmdView(relative(VAULT, p));
}

// ── doctor ────────────────────────────────────────────────────────────────────

function cmdDoctor(fix = false) {
  const notes = loadIndex();
  const issues: string[] = [];

  // duplicate ids
  const ids = new Map<string, string[]>();
  for (const n of notes) (ids.get(n.id) ?? ids.set(n.id, []).get(n.id)!).push(n.path);
  for (const [id, paths] of ids) if (paths.length > 1) issues.push(`duplicate id ${id}: ${paths.join(", ")}`);

  // broken wikilinks (link targets not in index)
  const allIds = new Set(notes.map(n => n.id));
  for (const n of notes) {
    for (const l of n.links) {
      if (!allIds.has(l) && !l.startsWith("http")) issues.push(`broken link in ${n.path}: [[${l}]]`);
    }
  }

  // missing slugs
  for (const n of notes) if (!n.slug) issues.push(`missing slug: ${n.path}`);

  // missing daily template
  if (!existsSync(TEMPLATE)) issues.push(`missing daily template: ${TEMPLATE}`);

  // stale index
  const indexMtime = existsSync(INDEX) ? statSync(INDEX).mtimeMs : 0;
  const stale = notes.filter(n => statSync(vaultPath(n.path)).mtimeMs > indexMtime);
  if (stale.length) issues.push(`index stale (${stale.length} notes newer than index)`);

  if (!issues.length) { console.log("✓ Vault looks healthy"); return; }
  for (const issue of issues) console.log(`  ${issue}`);
  if (fix) {
    console.log("\nAuto-fixing: reindexing...");
    cmdIndex();
  } else {
    console.log(`\n${issues.length} issue(s). Run 'doctor --fix' to auto-fix where possible.`);
  }
}

function cmdGenerateTestNotes() {
  const base = join(VAULT, "notes-demo");
  const daily = join(base, "daily");
  const tpl = join(VAULT, "templates");
  mkdirSync(base, { recursive: true });
  mkdirSync(daily, { recursive: true });
  mkdirSync(tpl, { recursive: true });
  if (!existsSync(TEMPLATE)) {
    writeFileSync(TEMPLATE, `---\nid: "{{date:YYYYMMDD}}-DAILY"\ndate: "{{date:YYYY-MM-DD}}"\naliases:\n  - "Daily {{date:YYYY-MM-DD}}"\ntags:\n  - daily\n  - journal\n---\n\n# Daily {{date:YYYY-MM-DD}}\n\n## Habits\n- [ ] sleep_7h\n- [ ] meds_am\n- [ ] walk_30m\n- [ ] reading_30m\n\n## Notes\n- \n\n## Tasks\n- [ ] \n`);
  }
  const files: Record<string,string> = {
    "notes-demo/0001-index.md": `---\nid: demo-index\naliases:\n  - demo home\ntags:\n  - demo\n  - index\n---\n# Demo Notes Index\n\nWelcome to the demo vault. Try [[0002-projects|Projects]], [[0003-books|Books]], and [[0004-health|Health]].\n\n- [ ] test fuzzy note finding\n- [x] test backlinks\n`,
    "notes-demo/0002-projects.md": `---\nid: demo-projects\naliases:\n  - Projects\ntags:\n  - demo\n  - projects\n---\n# Projects\n\nLinked from [[0001-index|Demo Notes Index]].\n\n## Ideas\n- notes TUI\n- habit statistics\n- jj-backed sync workflow\n`,
    "notes-demo/0003-books.md": `---\nid: demo-books\naliases:\n  - Reading\ntags:\n  - demo\n  - books\n---\n# Books\n\nSee also [[0002-projects|Projects]].\n\n- [ ] A Pattern Language\n- [ ] Gödel, Escher, Bach\n- [x] The Little Schemer\n`,
    "notes-demo/0004-health.md": `---\nid: demo-health\naliases:\n  - Health\ntags:\n  - demo\n  - habits\n---\n# Health\n\nDaily habits are tracked in [[daily/2026-05-18|today's note]].\n`,
    "notes-demo/daily/2026-05-18.md": `---\nid: 20260518-DAILY\ndate: "2026-05-18"\naliases:\n  - Daily 2026-05-18\ntags:\n  - daily\n  - journal\n  - demo\n---\n# Daily 2026-05-18\n\n## Habits\n- [x] sleep_7h\n- [x] meds_am\n- [ ] walk_30m\n- [x] reading_30m\n\n## Notes\n- Try backlinks to [[0004-health|Health]].\n\n## Tasks\n- [x] write demo note\n- [ ] test television channel\n`,
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(VAULT, path), content);
  cmdIndex();
  console.log(`Generated demo notes in ${relative(VAULT, base)}`);
}

function categoryFor(tags: string[], slug: string) {
  if (tags.includes("math") || tags.includes("geometry")) return "notes/math";
  if (tags.includes("health")) return "notes/health";
  if (tags.includes("planning") || tags.includes("adhd")) return "notes/learning";
  if (tags.includes("me") || slug.includes("self") || slug.includes("home")) return "notes/personal";
  if (slug.includes("reading") || slug.includes("book")) return "notes/reading";
  return "notes/general";
}

function cmdInit() {
  const root = process.cwd();
  const jjCheck = spawnSync("jj", ["root"], { encoding: "utf8" });
  if (jjCheck.status !== 0) {
    console.log("Initializing jj repo...");
    const r = spawnSync("jj", ["git", "init"], { stdio: "inherit" });
    if ((r.status ?? 0) !== 0) {
      console.log("jj git init failed, trying jj init...");
      spawnSync("jj", ["init"], { stdio: "inherit" });
    }
  }
  const notesRoot = process.env.NOTES_ROOT || join(root, "notes-vault");
  for (const d of ["inbox", "notes/general", "projects", "daily", "archive", "templates", "config"]) {
    mkdirSync(join(notesRoot, d), { recursive: true });
  }
  ensureConfig();

  // daily template
  const dailyTpl = join(notesRoot, "templates", "daily-note.md");
  if (!existsSync(dailyTpl)) {
    writeFileSync(dailyTpl, `# Daily — {{date:YYYY-MM-DD}}\n\n## Notes\n\n## Tasks\n- [ ] \n\n## Habits\n\n`);
  }

  // habits.yaml
  if (!existsSync(getHabitsConfig())) {
    writeFileSync(getHabitsConfig(), `habits:\n  sleep_7h:\n    title: Sleep 7h+\n  meds_am:\n    title: Morning meds\n  walk_30m:\n    title: Walk 30m+\n`);
  }

  // inbox
  const inbox = join(notesRoot, "inbox", "inbox.md");
  if (!existsSync(inbox)) {
    writeFileSync(inbox, yamlStringify({id: randomId(), slug: "inbox", type: "inbox", tags: ["inbox"]}) + "# Inbox\n\nWelcome! This is your capture inbox.\n");
  }

  // welcome note
  const welcome = join(notesRoot, "notes/general", "welcome.md");
  if (!existsSync(welcome)) {
    writeFileSync(welcome, yamlStringify({id: randomId(), slug: "welcome", type: "note", tags: ["welcome"]}) + "# Welcome\n\nYour notes vault is ready.\n\nTry:\n- `notes today`\n- `notes find`\n- `notes habit sleep_7h`\n");
  }

  // today's daily
  const d = new Date().toISOString().slice(0, 10);
  const todayPath = join(notesRoot, "daily", `${d}.md`);
  if (!existsSync(todayPath)) {
    writeFileSync(todayPath, renderDaily(d));
    syncDailyHabits(todayPath);
  }

  console.log(`Initialized notes vault at ${notesRoot}`);
  cmdIndex();
}

function cmdTutorial() {
  const steps = [
    "Welcome to notes! This quick tutorial will show you the basics.",
    "Step 1: Create/open today's daily note with 'today'.",
    "Step 2: Toggle a habit checkbox with 'habit sleep_7h'.",
    "Step 3: Find any note with 'find' (fuzzy search + action menu).",
    "Step 4: See vault stats with 'stats'.",
    "Step 5: Use 'jj status' / 'sync' / 'snapshot' for version control.",
    "Step 6: Run 'tv notes' after 'tv install-channels' for Television integration.",
    "Done! Type any command or press Enter in the TUI.",
  ];
  for (const s of steps) {
    console.log(s);
    const r = spawnSync("fzf", ["--prompt", "next ❯ ", "--height", "10%", "--border"], { input: "continue\nskip tutorial", encoding: "utf8" });
    if ((r.stdout || "").trim().startsWith("skip")) break;
  }
}

function cmdMigrate() {
  ensureConfig();
  for (const d of ["inbox", "notes", "projects", "daily", "archive", "templates", "config"]) mkdirSync(join(VAULT, d), { recursive: true });
  const linkMap = new Map<string, string>();
  const rootFiles = readdirSync(VAULT, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "inbox.md")
    .map(e => join(VAULT, e.name));
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
    mkdirSync(join(VAULT, dir), { recursive: true });
    writeFileSync(join(VAULT, destRel), yamlStringify(newFm) + body.trimStart());
    linkMap.set(basename(p, ".md"), destRel.replace(/\.md$/, ""));
    if (fm.id) linkMap.set(String(fm.id), destRel.replace(/\.md$/, ""));
    renameSync(p, join(VAULT, "archive", basename(p)));
    console.log(`${basename(p)} -> ${destRel}`);
  }
  for (const p of walkMd(VAULT)) {
    let txt = readFileSync(p, "utf8");
    for (const [oldTarget, newTarget] of linkMap) {
      txt = txt.replaceAll(`[[${oldTarget}|`, `[[${newTarget}|`);
      txt = txt.replaceAll(`[[${oldTarget}]]`, `[[${newTarget}]]`);
    }
    writeFileSync(p, txt);
  }
  const inbox = join(VAULT, "inbox", "inbox.md");
  if (!existsSync(inbox)) writeFileSync(inbox, yamlStringify({id: randomId(), slug: "inbox", type: "inbox", tags: ["inbox"]}) + "# Inbox\n\n");
  cmdIndex();
}

function cmdStats() {
  const notes = loadIndex();
  const tags = new Map<string, number>();
  let tasksDone = 0, tasksTotal = 0;
  const habitMap = new Map<string, Array<{ date: string; done: boolean }>>();
  for (const n of notes) {
    n.tags.forEach(t => tags.set(t, (tags.get(t) ?? 0) + 1));
    tasksTotal += n.tasks.length;
    tasksDone += n.tasks.filter(t => t.done).length;
    const date = /daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(n.path)?.[1];
    if (!date) continue;
    for (const h of n.habits) (habitMap.get(h.key) ?? habitMap.set(h.key, []).get(h.key)!).push({ date, done: h.done });
  }
  console.log(`Notes: ${notes.length}`);
  console.log(`Tasks: ${tasksDone}/${tasksTotal}`);
  console.log("Top tags:");
  [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`- ${k}: ${v}`));
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

function cmdPreview(note: string) {
  const direct = note ? vaultPath(note) : "";
  const p = direct && existsSync(direct) ? direct : walkMd(VAULT).find(x => basename(x, ".md") === note);
  if (!p) return console.log("Note not found");
  const src = readFileSync(p, "utf8");
  const r = spawnSync("dprint", ["fmt", "--stdin", p], { input: src, encoding: "utf8" });
  const out = (r.stdout || "").trim();
  console.log(out || src);
}

function cmdView(note: string) {
  const direct = note ? vaultPath(note) : "";
  const p = direct && existsSync(direct) ? direct : walkMd(VAULT).find(x => basename(x, ".md") === note);
  if (!p) return console.log("Note not found");
  const src = readFileSync(p, "utf8");
  console.log(`\x1b[1;36m${relative(VAULT, p)}\x1b[0m\n`);
  const r = spawnSync("dprint", ["fmt", "--stdin", p], { input: src, encoding: "utf8" });
  console.log((r.stdout || src).trim());
}

function cmdJj(args: string[]) {
  const bin = spawnSync("bash", ["-lc", "command -v jj"], { encoding: "utf8" }).stdout.trim();
  if (!bin) return console.log("jj not found in PATH");
  spawnSync("jj", args, { stdio: "inherit" });
}

function cmdJjAlias(name: string) {
  const aliases: Record<string, string[][]> = {
    sync: [["status"], ["git", "push"]],
    snapshot: [["status"], ["describe", "-m", "notes snapshot"], ["new"]],
    review: [["status"], ["diff"]],
  };
  const steps = aliases[name];
  if (!steps) return console.log(`Unknown jj alias: ${name}`);
  for (const args of steps) {
    console.log(`$ jj ${args.join(" ")}`);
    const r = spawnSync("jj", args, { stdio: "inherit" });
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
  if (kind === "notes") {
    for (const n of notes) console.log(`${n.path}\t${n.title}\t${n.tags.join(",")}`);
    return;
  }
  if (kind === "dailies") {
    notes.filter(n => /^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(n.path))
      .sort((a, b) => (a.path < b.path ? 1 : -1))
      .forEach(n => {
        const done = n.habits.filter(h => h.done).length;
        const total = n.habits.length;
        console.log(`${n.path}\t${done}/${total}\t${n.title}`);
      });
    return;
  }
  if (kind === "habits") {
    const map = new Map<string, Array<{ date: string; done: boolean }>>();
    for (const n of notes) {
      const date = /daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(n.path)?.[1];
      if (!date) continue;
      for (const h of n.habits) (map.get(h.key) ?? map.set(h.key, []).get(h.key)!).push({ date, done: h.done });
    }
    for (const [k, arr] of map.entries()) {
      const done = arr.filter(x => x.done).length;
      const pct = Math.round((done / Math.max(1, arr.length)) * 100);
      console.log(`${k}\t${done}/${arr.length}\t${pct}%\tstreak:${streak(arr)}d`);
    }
    return;
  }
}

function cmdTvOpenNote(raw: string) {
  const file = raw.split("\t")[0]?.trim();
  if (!file) return;
  openInEditor(file);
}

function cmdTvPreview(raw: string, kind: string) {
  const first = raw.split("\t")[0]?.trim();
  if (!first) return;
  if (kind === "notes" || kind === "dailies") {
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
    const [habit, ratio, pct, streakTxt] = raw.split("\t");
    const notes = loadIndex().filter(n => /^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(n.path)).sort((a,b)=>a.path<b.path?-1:1);
    const trend: string[] = [];
    for (const n of notes.slice(-30)) {
      const h = n.habits.find(x => x.key === habit);
      trend.push(h ? (h.done ? "█" : "·") : " ");
    }
    console.log(`Habit: ${habit}\nDone: ${ratio} (${pct}) ${streakTxt}\n\nLast 30 days:\n${trend.join("")}`);
  }
}

function cmdTvInstallChannels() {
  const dir = tvConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const self = selfCommand();
  const common = (name: string, desc: string, kind: string) => `# generated by notes.ts\n[metadata]\nname = "${name}"\ndescription = "${desc}"\n\n[source]\ncommand = "${self} tv items ${kind}"\n\n[preview]\ncommand = "${self} tv preview ${kind} '{}'"\n\n[keybindings]\nctrl-e = "actions:open"\n\n[actions.open]\ncommand = "${self} tv open-note '{}'"\nmode = "execute"\n`;
  writeFileSync(join(dir, "notes.toml"), common("notes", "Vault notes", "notes"));
  writeFileSync(join(dir, "dailies.toml"), common("dailies", "Daily notes", "dailies"));
  writeFileSync(join(dir, "habits.toml"), `# generated by notes.ts\n[metadata]\nname = "habits"\ndescription = "Habits with streaks"\n\n[source]\ncommand = "${self} tv items habits"\n\n[preview]\ncommand = "${self} tv preview habits '{}'"\n`);
  console.log(`Wrote channels to ${dir}`);
}

function cmdTv(channel: string) {
  if (!channel) return console.log("Usage: tv <notes|dailies|habits>");
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
    ["jj status", "Show jj working copy status"],
    ["jj log", "Show jj history"],
    ["jj diff", "Show jj diff"],
    ["jj tui", "Open small jj popup menu"],
    ["tv install-channels", "Install television channels"],
    ["tv notes", "Launch television notes channel"],
    ["tv dailies", "Launch television dailies channel"],
    ["tv habits", "Launch television habits channel"],
  ];
  const input = rows.map(([c, d]) => `${c}\t${d}`).join("\n");
  const r = spawnSync("fzf", [
    "--ansi",
    "--prompt", "notes ❯ ",
    "--height", "60%",
    "--layout", "reverse",
    "--border", "rounded",
    "--delimiter", "\t",
    "--with-nth", "1,2",
    "--preview", "printf '\033[38;5;117m%s\033[0m\n' {2}",
    "--color", "bg+:#1f2335,fg+:#c0caf5,hl:#7aa2f7,hl+:#7dcfff,pointer:#9ece6a,prompt:#7dcfff,border:#3b4261",
  ], { input, encoding: "utf8" });
  const out = (r.stdout || "").trim();
  if (!out) return;
  const c = out.split("\t")[0];
  console.log(`Run: bun notes.ts ${c}`);
}

type CommandInfo = { name: string; desc: string; tags: string };
const COMMANDS: CommandInfo[] = [
  {name: "index", desc: "rebuild the note index cache", tags: "rebuild refresh cache metadata parse vault"},
  {name: "find", desc: "fuzzy-find notes by path, title, or tags", tags: "note picker fzf title alias tag editor"},
  {name: "search", desc: "search titles, aliases, tags, and ids", tags: "metadata title alias tag query"},
  {name: "backlinks", desc: "show notes linking to a note", tags: "incoming links graph references mentions"},
  {name: "today", desc: "open or create today's daily note", tags: "daily journal date open create"},
  {name: "habit", desc: "toggle a habit checkbox in today's daily", tags: "daily tracker checkbox streak routine"},
  {name: "stats", desc: "show vault, task, tag, habit statistics", tags: "statistics dashboard counts streaks summary"},
  {name: "init", desc: "initialize new vault + jj repo + templates", tags: "setup bootstrap create first vault jj"},
  {name: "tutorial", desc: "interactive guided walkthrough of commands", tags: "learn guide help walkthrough basics"},
  {name: "migrate", desc: "migrate vault into folders and random ids", tags: "structure folders slug yaml legacy"},
  {name: "new", desc: "create a new note from template", tags: "create add write note template"},
  {name: "quick", desc: "append a quick capture to inbox", tags: "capture inbox append quick note fast"},
  {name: "inbox", desc: "open the inbox note", tags: "capture inbox quick notes"},
  {name: "recent", desc: "show recently modified notes", tags: "recent modified latest activity"},
  {name: "orphans", desc: "show notes with no backlinks", tags: "orphans disconnected unlinked graph"},
  {name: "rename", desc: "rename a note and update its slug", tags: "rename title slug refactor"},
  {name: "move", desc: "move a note to a different folder", tags: "move folder organize restructure"},
  {name: "delete", desc: "archive (soft-delete) a note", tags: "delete remove archive trash"},
  {name: "tasks", desc: "list all tasks across vault", tags: "tasks todo open done checklist"},
  {name: "habits", desc: "show habit list and streaks", tags: "habits tracker streak consistency"},
  {name: "habit add", desc: "add a new habit to config", tags: "habit new add create tracker"},
  {name: "habit remove", desc: "remove a habit from config", tags: "habit delete remove tracker"},
  {name: "daily previous", desc: "open previous daily note", tags: "daily back navigate previous"},
  {name: "daily next", desc: "open next daily note", tags: "daily forward navigate next"},
  {name: "daily review", desc: "view today's daily note", tags: "daily today review read"},
  {name: "doctor", desc: "check vault health", tags: "health check doctor lint validate"},
  {name: "doctor --fix", desc: "auto-fix vault issues", tags: "fix repair doctor validate"},
  {name: "sync", desc: "run jj sync alias", tags: "jj git push version control"},
  {name: "snapshot", desc: "run jj snapshot alias", tags: "jj describe new checkpoint"},
  {name: "review", desc: "run jj review alias", tags: "jj status diff changes"},
  {name: "preview", desc: "render a note preview with dprint", tags: "markdown md read view format"},
  {name: "view", desc: "pretty markdown view with header (dprint)", tags: "markdown md view pretty dprint"},
  {name: "demo", desc: "generate demo notes under notes-demo", tags: "test sample fixture sandbox"},
  {name: "jj status", desc: "show jj working copy status", tags: "version control vcs changes sync"},
  {name: "jj log", desc: "show jj history", tags: "version control vcs commits history"},
  {name: "jj diff", desc: "show jj diff", tags: "version control vcs changes patch"},
  {name: "jj menu", desc: "open a small jj action menu", tags: "version control sync tui fzf"},
  {name: "tv install", desc: "install Television channels", tags: "television fuzzy channels setup"},
  {name: "tv notes", desc: "browse notes in Television", tags: "television fuzzy notes picker"},
  {name: "tv dailies", desc: "browse daily notes in Television", tags: "television journal daily picker"},
  {name: "tv habits", desc: "browse habit streaks in Television", tags: "television habits streak tracker"},
  {name: "help", desc: "show command help", tags: "manual usage options"},
  {name: "quit", desc: "exit the TUI", tags: "exit close"},
];

function printHelp(verbose = false) {
  console.log("notes — Obsidian-like notes CLI/TUI\n");
  console.log("Usage:");
  console.log("  notes                 # start TUI (default)");
  console.log("  notes tui");
  console.log("  notes <command> [args]\n");
  console.log("Commands:");
  console.log("  index                          Rebuild markdown index cache");
  console.log("  find                           Fuzzy note+content picker with action menu");
  console.log("  search <query>                 Search id/title/aliases/tags");
  console.log("  backlinks <note>               Show incoming links");
  console.log("  preview <note>                 dprint-formatted preview");
  console.log("  view <note>                    pretty markdown view with path header");
  console.log("  daily open [--date YYYY-MM-DD] Create/open daily note from template");
  console.log("  daily habit-toggle <habit> [--date YYYY-MM-DD] Toggle habit checkbox");
  console.log("  stats                          Vault, task, habit statistics");
  console.log("  new <title>                    Create a new note from template");
  console.log("  quick <text>                   Append quick capture to inbox");
  console.log("  inbox                          Open the inbox note");
  console.log("  recent [n]                     Recently modified notes");
  console.log("  orphans                        Notes with no backlinks");
  console.log("  tasks [open|done]              List tasks across vault");
  console.log("  task add <note> <text>         Add task to a note");
  console.log("  habits                         Habit list with streaks");
  console.log("  habit add/remove/fill          Manage habits");
  console.log("  rename <note> <title>          Rename note and update slug");
  console.log("  move <note> <folder>           Move note to folder");
  console.log("  delete <note>                  Soft-delete (archive) a note");
  console.log("  daily previous|next|review     Navigate daily notes");
  console.log("  doctor [--fix]                 Check vault health");
  console.log("  init                           Initialize new vault + jj repo + templates");
  console.log("  tutorial                       Interactive guided walkthrough");
  console.log("  migrate                        Migrate vault into folders/random ids/slugs");
  console.log("  sync|snapshot|review           JJ command bundles");
  console.log("  demo                           Generate demo notes under notes-demo/");
  console.log("  command-bar                    External fzf command launcher");
  console.log("  jj <args...>                   Passthrough to jj (status/log/diff/etc.)");
  console.log("  jj tui                        Small jj menu (status/log/diff/bookmarks)");
  console.log("  tv install-channels           Write television channels for notes/dailies/habits");
  console.log("  tv <notes|dailies|habits>     Launch television channel");
  console.log("  help                           Show help\n");
  if (verbose) {
    console.log("TUI controls:");
    console.log("  Type to filter commands, Tab/↑/↓ to pick, Enter to run");
    console.log("  Esc clears prompt, Ctrl+C exits\n");
    console.log("Environment:");
    console.log("  EDITOR      external editor used by find/daily open");
    console.log("  NOTES_ROOT  override notes root directory\n");
    console.log("Roots:");
    console.log(`  project root: ${PROJECT_ROOT}`);
    console.log(`  jj root:      ${JJ_ROOT}`);
    console.log(`  notes root:   ${VAULT}\n`);
    console.log("Files:");
    console.log("  <notes root>/.notes_index.json          generated index cache");
    console.log("  <notes root>/templates/daily-note.md    daily template source");
    console.log("  <notes root>/daily/YYYY-MM-DD.md        daily notes\n");
    console.log("Notes:");
    console.log("  - Habit tracker parses the '## Habits' checkbox section in daily notes");
    console.log("  - Backlinks are resolved from [[wikilinks]] and local markdown links");
  }
}

function fuzzySuggest(input: string): CommandInfo[] {
  const trimmed = input.trim();
  if (!trimmed) return COMMANDS;

  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  const rest = trimmed.slice(firstWord.length).trim();

  const score = (c: CommandInfo) => {
    const hay = `${c.name} ${c.desc} ${c.tags}`.toLowerCase();
    const nameIdx = c.name.toLowerCase().indexOf(firstWord);
    const hayIdx = hay.indexOf(firstWord);
    if (nameIdx === 0) return 0;           // exact prefix match on command name
    if (nameIdx > 0) return 10 + nameIdx;
    if (hayIdx >= 0) return 100 + hayIdx;
    return 9999;
  };

  let results = COMMANDS.filter(c => score(c) < 9999).sort((a, b) => score(a) - score(b));

  // If first word exactly matches a command name, always keep it at top even with arguments
  const exactMatch = COMMANDS.find(c => c.name === firstWord);
  if (exactMatch && results[0] !== exactMatch) {
    results = [exactMatch, ...results.filter(c => c !== exactMatch)];
  }

  return results;
}

const SESSION_BONSAI_SEED = Math.floor(Math.random() * 1_000_000);

function nb(s: string) {
  // Ink/React can trim/collapse regular leading spaces in some layouts.
  // Braille blank keeps a stable monospace cell without showing a dot.
  return s.replaceAll(" ", "\u2800");
}

function fixedArt(lines: string[], width: number) {
  return lines.map(line => nb(line.padEnd(width, " ").slice(0, width)));
}

function seededPick<T>(xs: T[], salt: number): T {
  return xs[(SESSION_BONSAI_SEED + salt) % xs.length];
}


function parseArgs(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

async function executeLine(line: string): Promise<boolean> {
  const raw = line.trim();
  if (!raw) return true;
  if (["quit", "exit"].includes(raw)) return false;
  if (["show help", "help"].includes(raw)) {
    printHelp(false);
    return true;
  }
  if (raw === "index" || raw === "rebuild note index") cmdIndex();
  else if (raw === "search" || raw.startsWith("search ") || raw.startsWith("search notes ")) cmdSearch(raw === "search" ? promptUser("search") : raw.replace(/^search notes\s+|^search\s+/, ""));
  else if (raw === "find" || raw === "find in notes") cmdFind();
  else if (raw === "backlinks" || raw.startsWith("backlinks ") || raw.startsWith("show backlinks ")) cmdBacklinks(raw === "backlinks" ? promptUser("note") : raw.replace(/^show backlinks\s+|^backlinks\s+/, ""));
  else if (raw === "today" || raw === "open today note" || raw === "daily open") cmdDailyOpen();
  else if (raw === "habit" || raw.startsWith("habit ") || raw.startsWith("toggle daily habit ") || raw.startsWith("daily habit-toggle ")) cmdHabitToggle(raw === "habit" ? promptUser("habit") : raw.replace(/^habit\s+|^toggle daily habit\s+|^daily habit-toggle\s+/, ""));
  else if (raw === "stats" || raw === "show vault statistics") cmdStats();
  else if (raw === "init") cmdInit();
  else if (raw === "tutorial") cmdTutorial();
  else if (raw === "migrate") cmdMigrate();
  else if (["sync", "snapshot", "review"].includes(raw)) cmdJjAlias(raw);
  else if (raw === "preview" || raw.startsWith("preview ") || raw.startsWith("preview note ")) cmdPreview(raw === "preview" ? promptUser("note") : raw.replace(/^preview note\s+|^preview\s+/, ""));
  else if (raw === "view" || raw === "md" || raw.startsWith("view ") || raw.startsWith("md ")) cmdView(raw === "view" || raw === "md" ? promptUser("note") : raw.replace(/^view\s+|^md\s+/, ""));
  else if (raw === "new" || raw.startsWith("new ")) cmdNew(raw.slice(3).trim());
  else if (raw === "quick" || raw.startsWith("quick ")) cmdQuick(raw.slice(5).trim());
  else if (raw === "inbox") cmdInbox();
  else if (raw === "recent") cmdRecent();
  else if (raw === "orphans") cmdOrphans();
  else if (raw === "rename" || raw.startsWith("rename ")) {
    const rest = raw.slice(6).trim();
    if (!rest) cmdRename("", "");
    else { const [a, ...b] = rest.split(" -> "); cmdRename(a.trim(), b.join(" -> ").trim()); }
  }
  else if (raw === "move" || raw.startsWith("move ")) { if (raw === "move") { const note = promptUser("note"); const folder = promptUser("folder"); cmdMove(note, folder); } else { const [a, ...b] = raw.slice(5).trim().split(" -> "); cmdMove(a.trim(), b.join(" -> ").trim()); } }
  else if (raw === "delete" || raw.startsWith("delete ")) cmdDelete(raw === "delete" ? promptUser("note") : raw.slice(7).trim());
  else if (raw === "tasks" || raw === "tasks open" || raw === "tasks done") cmdTasks(raw === "tasks" ? undefined : raw.split(" ")[1]);
  else if (raw.startsWith("task add ")) { const [note, ...rest] = raw.slice(9).trim().split(" "); cmdTasksAdd(note, rest.join(" ")); }
  else if (raw === "habit list" || raw === "habits") cmdHabitList();
  else if (raw.startsWith("habit add ")) cmdHabitAdd(...raw.slice(10).trim().split(" ") as [string, string?]);
  else if (raw.startsWith("habit remove ")) cmdHabitRemove(raw.slice(13).trim());
  else if (raw === "daily previous") cmdDailyNav("previous");
  else if (raw === "daily next") cmdDailyNav("next");
  else if (raw === "daily review") cmdDailyReview();
  else if (raw === "doctor" || raw === "doctor --fix") cmdDoctor(raw.endsWith("--fix"));
  else if (raw === "demo") cmdGenerateTestNotes();
  else if (raw === "jj status" || raw === "show jj status") cmdJj(["status"]);
  else if (raw === "jj log" || raw === "show jj log") cmdJj(["log"]);
  else if (raw === "jj diff" || raw === "show jj diff") cmdJj(["diff"]);
  else if (raw === "jj menu" || raw === "open jj menu" || raw === "jj tui") cmdJjTui();
  else if (raw === "tv install" || raw === "install television channels" || raw === "tv install-channels") cmdTvInstallChannels();
  else if (raw === "tv notes" || raw === "browse notes in television") cmdTv("notes");
  else if (raw === "tv dailies" || raw === "browse dailies in television") cmdTv("dailies");
  else if (raw === "tv habits" || raw === "browse habits in television") cmdTv("habits");
  else console.log("Unknown command");
  return true;
}

const h = React.createElement;

function vaultStats() {
  const notes = loadIndex();
  const dailies = notes.filter(n => /^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(n.path));
  const habitDays = dailies.map(n => n.habits.some(x => x.done));
  let habitStreak = 0;
  for (let i = habitDays.length - 1; i >= 0 && habitDays[i]; i--) habitStreak++;
  return {
    notes,
    dailies,
    noteCount: notes.length,
    dailyCount: dailies.length,
    linkCount: notes.reduce((a, n) => a + n.links.length, 0),
    taskCount: notes.reduce((a, n) => a + n.tasks.length, 0),
    habitStreak,
    dailyStreak: dailies.length,
  };
}

function statsTable(stats: ReturnType<typeof vaultStats>): string {
  const lines: string[] = [];
  lines.push(`Notes: ${stats.noteCount}`);
  lines.push(`Tasks: ${stats.taskCount} done / total`);

  // Top tags
  const tagCounts = new Map<string, number>();
  for (const n of stats.notes) for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = [...tagCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);
  if (topTags.length) {
    lines.push("Top tags:");
    for (const [tag, cnt] of topTags) lines.push(`  #${tag} (${cnt})`);
  }

  // Habits
  const habitMap = new Map<string, Array<{date:string, done:boolean}>>();
  for (const n of stats.notes) {
    const date = /daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(n.path)?.[1];
    if (!date) continue;
    for (const h of n.habits) {
      (habitMap.get(h.key) ?? habitMap.set(h.key, []).get(h.key)!)
        .push({date, done: h.done});
    }
  }
  if (habitMap.size) {
    lines.push("Habits:");
    for (const [k, arr] of habitMap.entries()) {
      const done = arr.filter(x => x.done).length;
      const total = arr.length;
      const pct = Math.round(done / Math.max(1,total) * 100);
      const stk = streak(arr);
      lines.push(`  ${k}: ${done}/${total} (${pct}%) streak=${stk}d`);
    }
  }

  const contentWidth = Math.max(...lines.map(l => l.length));
  const top = "\u250c" + "\u2500".repeat(contentWidth + 2) + "\u2510";
  const bot = "\u2514" + "\u2500".repeat(contentWidth + 2) + "\u2518";
  const mid = lines.map(l => `\u2502 ${l.padEnd(contentWidth)} \u2502`);
  return [top, ...mid, bot].join("\n");
}

function Mascot({frame}: {frame: number}) {
  const rows = process.stdout.rows || 28;
  const maxLines = rows < 28 ? 10 : rows < 34 ? 13 : IMAGE_MASCOT_ROWS.length;
  return h(Box, {flexDirection: "column", width: IMAGE_MASCOT_WIDTH, flexShrink: 0, marginRight: 1}, ...mascot(frame, SESSION_BONSAI_SEED).slice(0, maxLines).map((row, i) =>
    h(Box, {key: i, marginLeft: row.indent}, h(Text, {wrap: "truncate", dimColor: row.dim || i > 12}, row.text))
  ));
}

function CommandApp({message, onSubmit}: {message: string; onSubmit: (line: string) => void}) {
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [frame, setFrame] = useState(0);
  const {exit} = useApp();
  const stats = vaultStats();
  const suggestions = fuzzySuggest(input).slice(0, 6);
  const showSuggestions = input.trim().length > 0;

  useEffect(() => {
    const t = setInterval(() => setFrame(f => f + 1), 80);
    return () => clearInterval(t);
  }, []);

  useInput((str, key) => {
    if (key.ctrl && str === "c") return exit();
    if (key.escape) { setInput(""); setSelected(0); return; }
    if (key.backspace || key.delete) { setInput(x => x.slice(0, -1)); setSelected(0); return; }
    if (key.downArrow || key.tab) { setSelected(x => (x + 1) % Math.max(1, suggestions.length)); return; }
    if (key.upArrow) { setSelected(x => (x - 1 + Math.max(1, suggestions.length)) % Math.max(1, suggestions.length)); return; }
    if (key.return) {
      let line = input.trim();
      if (showSuggestions && suggestions[selected] && (!line || !COMMANDS.some(c => c.name === line))) line = suggestions[selected].name;
      onSubmit(line);
      return exit();
    }
    if (str && !key.ctrl && !key.meta) { setInput(x => x + str); setSelected(0); }
  });

  const compact = (process.stdout.rows || 24) < 34;
  const hintRows = [
    ["find", "fuzzy-find notes"],
    ["today", "open daily note"],
    ["stats", "vault statistics"],
    ["migrate", "organize vault folders"],
    ["sync", "run jj sync alias"],
    ["tv notes", "Television note browser"],
  ];

  return h(Box, {flexDirection: "column", paddingX: 1},
    h(Box, {flexDirection: "row", width: "100%", alignItems: "flex-start"},
      h(Mascot, {frame}),
      h(Box, {marginLeft: 2},
        h(Text, {color: "#64748b"}, statsTable(stats)),
      ),
    ),
    h(Box, {borderStyle: "round", borderColor: "cyan", width: "100%", justifyContent: "flex-start", paddingX: 1},
      h(Text, {color: "cyan"}, `❯ ${input}`),
    ),
    h(Box, {marginTop: 1, flexDirection: "column"},
      showSuggestions
        ? h(React.Fragment, null,
            h(Text, {color: "cyan"}, "matching commands"),
            ...suggestions.map((s, i) => h(Text, {key: `${i}-${s.name}`, inverse: i === selected}, `${i === selected ? "▶" : " "} ${s.name.padEnd(12)} ${s.desc}`)),
          )
        : h(React.Fragment, null,
            h(Text, {color: "cyan"}, "try these"),
            ...hintRows.map(([cmd, desc]) => h(Text, {key: cmd}, `${cmd.padEnd(28)} ${desc}`)),
          ),
    ),
    h(Box, {marginTop: 1}, h(Text, {dimColor: true}, `${message} • Ctrl+C quit`)),
  );
}

async function cmdTui() {
  if (!process.stdin.isTTY) {
    printHelp(false);
    return;
  }

  const screen = new TerminalScreen();
  _tuiScreen = screen;
  screen.enter();

  let input = "";
  let selected = 0;
  let scrollOffset = 0;
  let frame = 0;
  let running = true;
  let message = "Type naturally. Tab/↑/↓/Enter/Esc";

  const fullRedraw = () => {
    screen.resize();
    screen.clear();

    const w = screen.width;
    const h = screen.height;
    const stats = vaultStats();

    // Layout: statsTable (left) | bonsai (center) | right (configurable, empty for now)
    const mascotRows = mascot(frame, SESSION_BONSAI_SEED);
    const topPaneY = 1;
    const leftLines = statsTable(stats).split("\n");
    const topPaneH = Math.max(mascotRows.length, leftLines.length); // tallest of left/center
    const padding = 2;

    // Left: full statsTable, top-aligned
    leftLines.forEach((line, i) => {
      screen.write(0, topPaneY + i, line, { fg: "#64748b" });
    });

    // Center: bonsai (exact horizontal center, top-aligned)
    const bonsaiX = Math.floor((w - IMAGE_MASCOT_WIDTH) / 2);
    mascotRows.forEach((row, i) => {
      screen.write(bonsaiX + row.indent, topPaneY + i, row.text, { fg: "#a5b4fc", dim: i > 10 });
    });

    // Right: configurable (empty for now — assign rightPanel to customize)
    // const rightLines = [...]; rightLines.forEach((l, i) => screen.write(w - rightWidth, topPaneY + i, l, {}));

    // Prompt: one line below top pane
    const promptY = topPaneY + topPaneH + 1;
    screen.write(0, promptY - 1, "─".repeat(w), { fg: "#475569" });
    screen.write(padding, promptY, `❯ ${input}`, { fg: "#67e8f9" });

    const allSuggestions = fuzzySuggest(input);
    const visibleRows = 7;  // fixed: show exactly 7 entries
    // keep scrollOffset window around selected
    if (selected < scrollOffset) scrollOffset = selected;
    if (selected >= scrollOffset + visibleRows) scrollOffset = selected - visibleRows + 1;
    const visibleSuggestions = allSuggestions.slice(scrollOffset, scrollOffset + visibleRows);
    const suggY = promptY + 2;
    for (let i = 0; i < visibleRows; i++) {
      const s = visibleSuggestions[i];
      if (!s) break;  // overflow:hidden
      const absIdx = scrollOffset + i;
      const prefix = absIdx === selected ? "▶ " : "  ";
      screen.write(padding, suggY + i, `${prefix}${s.name.padEnd(14)} ${s.desc}`,
        absIdx === selected ? { fg: "#e0f2fe", bold: true } : { fg: "#cbd5e1" });
    }

    screen.write(2, h - 1, message, { fg: "#64748b", dim: true });
    screen.redraw();
  };

  const onKey = (str: string, key: any) => {
    if (key.name === "return" || key.name === "enter") {
      const suggestions = fuzzySuggest(input);
      const cmd = suggestions[selected]?.name || input;
      if (cmd) {
        // Run command (it may print)
        executeLine(cmd).then(keep => {
          if (!keep) {
            running = false;
            screen.cleanup();
            process.exit(0);
          }
          // After command, clear and fully redraw to avoid duplication
          input = "";
          selected = 0;
      scrollOffset = 0;
          message = `Ran: ${cmd}`;
          fullRedraw();
        });
      }
      return;
    }

    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      if (input) {
        input = "";
        selected = 0;
      scrollOffset = 0;
      } else {
        running = false;
        screen.cleanup();
        process.exit(0);
      }
      fullRedraw();
      return;
    }

    if (key.name === "backspace") {
      input = input.slice(0, -1);
      selected = 0;
      scrollOffset = 0;
      fullRedraw();
      return;
    }
    if (key.name === "up") {
      const len = fuzzySuggest(input).length;
      selected = (selected - 1 + Math.max(1, len)) % Math.max(1, len);
      fullRedraw();
      return;
    }
    if (key.name === "down" || key.name === "tab") {
      const len = fuzzySuggest(input).length;
      selected = (selected + 1) % Math.max(1, len);
      fullRedraw();
      return;
    }
    if (key.name === "left") {
      // Left arrow completes the top suggestion (common CLI pattern)
      const suggestions = fuzzySuggest(input);
      if (suggestions.length > 0) {
        input = suggestions[0].name;
        selected = 0;
      scrollOffset = 0;
      }
      fullRedraw();
      return;
    }
    if (key.name === "right") {
      // Right arrow also accepts top suggestion or does nothing
      const suggestions = fuzzySuggest(input);
      if (suggestions.length > 0) {
        input = suggestions[0].name;
        selected = 0;
      scrollOffset = 0;
      }
      fullRedraw();
      return;
    }
    if (str && !key.ctrl && !key.meta) {
      input += str;
      selected = 0;
      scrollOffset = 0;
      fullRedraw();
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => {
    const str = data.toString();
    // discard all mouse/scroll reports (SGR \x1b[<...M/m and X10 \x1b[M...)
    if (/^\x1b\[(<[\d;]+[Mm]|M.{3})/.test(str)) { fullRedraw(); return; }
    if (str === "\u001b[A") return onKey("", { name: "up" });
    if (str === "\u001b[B") return onKey("", { name: "down" });
    if (str === "\u001b[D") return onKey("", { name: "left" });
    if (str === "\u001b[C") return onKey("", { name: "right" });
    if (str === "\u001b") return onKey("", { name: "escape" });
    if (str === "\r" || str === "\n") return onKey("", { name: "return" });
    if (str === "\u0003") return onKey("", { ctrl: true, name: "c" });
    if (str === "\u007f" || str === "\b") return onKey("", { name: "backspace" });
    if (str === "\t") return onKey("", { name: "tab" });
    onKey(str, {});
  });

  const anim = setInterval(() => {
    if (!running) return clearInterval(anim);
    frame++;
    fullRedraw();
  }, 80);

  fullRedraw();
  await new Promise<void>(() => {});
}
async function main() {
  const [,, cmd, ...args] = process.argv;
  if (cmd === "--help" || cmd === "-h") {
    printHelp(true);
    process.exit(0);
  }

  switch (cmd) {
    case "index": cmdIndex(); break;
    case "search": cmdSearch(args.join(" ")); break;
    case "backlinks": cmdBacklinks(args[0]); break;
    case "find": cmdFind(); break;
    case "today": cmdDailyOpen(); break;
    case "preview": cmdPreview(args[0]); break;
    case "view": cmdView(args[0]); break;
    case "links": cmdLinks(args[0]); break;
    case "init": cmdInit(); break;
    case "tutorial": cmdTutorial(); break;
    case "migrate": cmdMigrate(); break;
    case "sync": cmdJjAlias("sync"); break;
    case "snapshot": cmdJjAlias("snapshot"); break;
    case "review": cmdJjAlias("review"); break;
    case "new": cmdNew(args.join(" ")); break;
    case "quick": cmdQuick(args.join(" ")); break;
    case "inbox": cmdInbox(); break;
    case "recent": cmdRecent(Number(args[0]) || 10); break;
    case "orphans": cmdOrphans(); break;
    case "rename": cmdRename(args[0], args.slice(1).join(" ")); break;
    case "move": cmdMove(args[0], args[1]); break;
    case "delete": cmdDelete(args[0]); break;
    case "tasks": cmdTasks(args[0]); break;
    case "task": if (args[0] === "add") cmdTasksAdd(args[1], args.slice(2).join(" ")); break;
    case "habits": cmdHabitList(); break;
    case "habit":
      if (args[0] === "list") cmdHabitList();
      else if (args[0] === "add") cmdHabitAdd(args[1], args.slice(2).join(" ") || undefined);
      else if (args[0] === "remove") cmdHabitRemove(args[1]);
      else if (args[0] === "fill") cmdHabitFill(args[1], args[2]);
      else cmdHabitToggle(args[0]);
      break;
    case "daily": {
      if (args[0] === "previous") cmdDailyNav("previous");
      else if (args[0] === "next") cmdDailyNav("next");
      else if (args[0] === "review") cmdDailyReview();
      else if (args[0] === "open") cmdDailyOpen(args[1] === "--date" ? args[2] : undefined);
      else if (args[0] === "habit-toggle") cmdHabitToggle(args[1], args[2] === "--date" ? args[3] : undefined);
      else console.log("daily open|previous|next|review [--date YYYY-MM-DD]");
      break;
    }
    case "doctor": cmdDoctor(args[0] === "--fix"); break;
    case "demo": cmdGenerateTestNotes(); break;
    case "command-bar": cmdCommandBar(); break;
    case "jj": if (args[0] === "tui") cmdJjTui(); else cmdJj(args); break;
    case "tv": {
      if (args[0] === "install-channels") cmdTvInstallChannels();
      else if (args[0] === "items") cmdTvItems(args[1]);
      else if (args[0] === "open-note") cmdTvOpenNote(args.slice(1).join(" "));
      else if (args[0] === "preview") cmdTvPreview(args.slice(2).join(" "), args[1]);
      else cmdTv(args[0]);
      break;
    }

    case "stats": cmdStats(); break;
    case "tui": await cmdTui(); break;
    case "help":
      printHelp(args.includes("--verbose") || args.includes("-v"));
      break;
    case undefined:
      await cmdTui();
      break;
    default:
      await cmdTui();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
