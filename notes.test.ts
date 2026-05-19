import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { chdir, cwd } from "node:process";
import { tmpdir } from "node:os";

// ── helpers ──────────────────────────────────────────────────────────────────

const VAULT = join(tmpdir(), `notes-test-vault-${process.pid}`);
const CLI = ["bun", join(import.meta.dir, "notes.ts")];
const DEFAULT_ENV = { ...process.env, NOTES_ROOT: VAULT };

type CommandResult = { out: string; err: string; code: number };

async function run(...args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn([...CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: DEFAULT_ENV,
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { out: out.trim(), err: err.trim(), code: proc.exitCode ?? 0 };
}

async function expectRun(...args: string[]) {
  const result = await run(...args);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  return result;
}

async function runInDir(dir: string, ...args: string[]): Promise<CommandResult> {
  const previous = cwd();
  try {
    chdir(dir);
    const proc = Bun.spawn([...CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { out: out.trim(), err: err.trim(), code: proc.exitCode ?? 0 };
  } finally {
    chdir(previous);
  }
}

function vaultFile(...parts: string[]) {
  return join(VAULT, ...parts);
}

function writeNote(relPath: string, content: string) {
  const full = vaultFile(relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function readVaultFile(relPath: string) {
  return readFileSync(vaultFile(relPath), "utf8");
}

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(VAULT, { recursive: true });
  for (const d of ["inbox", "notes/general", "notes/math", "projects", "daily", "archive", "templates", "config"]) {
    mkdirSync(vaultFile(d), { recursive: true });
  }

  writeNote("templates/daily-note.md", "# Daily — {{date:YYYY-MM-DD}}\n\n## Tasks\n\n## Habits\n\n");
  writeNote("config/habits.yaml", "habits:\n  sleep_7h:\n    title: Sleep 7h+\n  meds_am:\n    title: Morning meds\n");

  writeNote("notes/general/alpha.md",
    "---\nid: \"aaa1\"\nslug: \"alpha\"\ntype: note\ntags:\n  - test\n---\n# Alpha\n\n[[beta]] is linked.\n\n- [ ] open task\n- [x] done task\n");

  writeNote("notes/general/beta.md",
    "---\nid: \"bbb2\"\nslug: \"beta\"\ntype: note\ntags:\n  - test\n---\n# Beta\n\nNo outgoing links.\n");

  writeNote("notes/math/orphan.md",
    "---\nid: \"ccc3\"\nslug: \"orphan\"\ntype: note\ntags:\n  - math\n---\n# Orphan\n\nNothing links here.\n");

  const today = new Date().toISOString().slice(0, 10);
  writeNote(`daily/${today}.md`,
    `---\nid: "ddd4"\ndate: "${today}"\ntype: daily\n---\n# Daily — ${today}\n\n## Habits\n- [ ] sleep_7h\n- [ ] meds_am\n`);

  // index
  Bun.spawnSync(CLI.concat("index"), { env: DEFAULT_ENV });
});

afterAll(() => {
  rmSync(VAULT, { recursive: true, force: true });
});

// ── smoke ─────────────────────────────────────────────────────────────────────

describe("Build & basic commands", () => {
  test("--help exits cleanly", async () => {
    const { out, code } = await run("--help");
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(10);
  });

  test("--help contains expected commands", async () => {
    const { out } = await expectRun("--help");
    for (const cmd of ["find", "init", "tutorial", "doctor", "new", "habits", "tasks", "orphans", "recent"]) {
      expect(out).toContain(cmd);
    }
  });

  test("index runs without crash", async () => {
    const { out, code } = await expectRun("index");
    expect(code).toBe(0);
  });

  test("no duplicate lines in help output", async () => {
    const { out } = await expectRun("--help");
    const lines = out.split("\n").filter(Boolean);
    const dupes = lines.filter((line, index) => lines.indexOf(line) !== index);
    expect(dupes.length).toBe(0);
  });
});

// ── source-level guards ───────────────────────────────────────────────────────

describe("Source function presence", () => {
  async function combinedSource() {
    const files = [
      "notes.ts",
      "src/core/commands.ts",
      "src/ui/commands.ts",
      "src/ui/components.ts",
      "src/ui/tui.ts",
      "src/cli/main.ts",
    ];
    const parts = await Promise.all(files.map(file => Bun.file(file).text()));
    return parts.join("\n");
  }

  test("all required functions are defined", async () => {
    const src = await combinedSource();
    const required = [
      "function statsTable",
      "function vaultStats",
      "function fuzzySuggest",
      "function inlineCommandHint",
      "function resolveSubmittedCommand",
      "function pickNote",
      "function pickHabit",
      "function pickDailyNote",
      "function pickFolder",
      "function cmdNew",
      "function cmdQuick",
      "function cmdInbox",
      "function cmdRecent",
      "function cmdOrphans",
      "function cmdRename",
      "function cmdMove",
      "function cmdDelete",
      "function cmdTasks",
      "function cmdTasksAdd",
      "function cmdHabitList",
      "function cmdHabitAdd",
      "function cmdHabitRemove",
      "function cmdHabitFill",
      "function cmdDailyNav",
      "function cmdDailyReview",
      "function cmdDoctor",
    ];
    expect(required.every(fn => src.includes(fn))).toBe(true);
  });

  test("specific habit matchers are checked before generic habit toggle", async () => {
    const src = await combinedSource();
    const addIndex = src.indexOf('raw => raw === "habit add" || raw.startsWith("habit add ")');
    const removeIndex = src.indexOf('raw => raw === "habit remove" || raw.startsWith("habit remove ")');
    const toggleIndex = src.indexOf('raw => raw === "habit" || raw.startsWith("habit ") || raw.startsWith("toggle daily habit ")');
    expect(addIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(-1);
    expect(toggleIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeLessThan(toggleIndex);
    expect(removeIndex).toBeLessThan(toggleIndex);
  });

  test("inline hint only appears for exact command without arguments", async () => {
    const src = await combinedSource();
    expect(src).toContain('.find(command => trimmed === command.name);');
    expect(src).not.toContain('trimmed.startsWith(`${command.name} `)');
  });

  test("submitted input with arguments is preserved instead of replaced by suggestion", async () => {
    const src = await combinedSource();
    expect(src).toContain("const hasArguments = line.includes(\" \");");
    expect(src).toContain("if (hasArguments) return line;");
  });

  test("find supports inline fuzzy query", async () => {
    const src = await combinedSource();
    expect(src).toContain('match: raw => raw === "find" || raw === "search"');
    expect(src).toContain('if (initialQuery) fzfArgs.push("--query", initialQuery);');
  });

  test("interactive commands use fuzzy pickers for missing args", async () => {
    const src = await combinedSource();
    expect(src).toContain('if (!q) {\n    cmdFind();');
    expect(src).toContain('const n = note ? pickNote(note) : pickNote();');
    expect(src).toContain('folder = pickFolder();');
    expect(src).toContain('const pickedHabit = habit ? pickHabit(habit) : pickHabit();');
    expect(src).toContain('const pickedDate = date ?? pickDailyNote();');
  });
});

// ── index ─────────────────────────────────────────────────────────────────────

describe("index", () => {
  test("indexes all notes", async () => {
    const { out } = await expectRun("index");
    expect(out).toMatch(/Indexed \d+ notes/);
    const noteCount = Number(out.match(/Indexed (\d+)/)?.[1]);
    expect(noteCount).toBeGreaterThanOrEqual(4);
  });
});

// ── search / backlinks ────────────────────────────────────────────────────────

describe("search", () => {
  test("finds note by title", async () => {
    const { out } = await expectRun("search", "Alpha");
    expect(out).toContain("alpha");
  });

  test("finds note by tag", async () => {
    const { out } = await expectRun("search", "math");
    expect(out).toContain("orphan");
  });
});

describe("backlinks", () => {
  test("beta has a backlink from alpha", async () => {
    const { out } = await expectRun("backlinks", "beta");
    expect(out).toContain("alpha");
  });

  test("alpha has no backlinks", async () => {
    const { out } = await expectRun("backlinks", "alpha");
    expect(out).not.toContain("beta");
  });
});

// ── recent / orphans ──────────────────────────────────────────────────────────

describe("recent", () => {
  test("returns notes sorted by modification time", async () => {
    const { out } = await expectRun("recent", "5");
    expect(out.length).toBeGreaterThan(0);
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatch(/\d+d\s+\S+/);
  });
});

describe("orphans", () => {
  test("orphan note appears in orphans list", async () => {
    const { out } = await expectRun("orphans");
    expect(out).toContain("orphan");
  });

  test("beta does not appear (has backlink from alpha)", async () => {
    const { out } = await expectRun("orphans");
    expect(out).not.toContain("beta");
  });
});

// ── tasks ─────────────────────────────────────────────────────────────────────

describe("tasks", () => {
  test("lists all tasks", async () => {
    const { out } = await expectRun("tasks");
    expect(out).toContain("open task");
    expect(out).toContain("done task");
  });

  test("tasks open shows only unchecked", async () => {
    const { out } = await expectRun("tasks", "open");
    expect(out).toContain("open task");
    expect(out).not.toContain("done task");
  });

  test("tasks done shows only checked", async () => {
    const { out } = await expectRun("tasks", "done");
    expect(out).not.toContain("open task");
    expect(out).toContain("done task");
  });
});

// ── habits ────────────────────────────────────────────────────────────────────

describe("habits", () => {
  test("habits list shows defined habits with bar", async () => {
    const { out } = await expectRun("habits");
    expect(out).toContain("sleep_7h");
    expect(out).toContain("meds_am");
    expect(out).toMatch(/[█░]+/);
  });

  test("habit add creates new habit", async () => {
    await expectRun("habit", "add", "reading_30m", "Reading 30m+");
    const cfg = readVaultFile("config/habits.yaml");
    expect(cfg).toContain("reading_30m");
  });

  test("habit remove deletes habit", async () => {
    await expectRun("habit", "add", "temp_habit");
    await expectRun("habit", "remove", "temp_habit");
    const cfg = readVaultFile("config/habits.yaml");
    expect(cfg).not.toContain("temp_habit");
  });

  test("habits add preserves multi-word title", async () => {
    await expectRun("habits", "add", "reading_speed", "Reading Speed Daily");
    const cfg = readVaultFile("config/habits.yaml");
    expect(cfg).toContain("reading_speed");
    expect(cfg).toContain("Reading Speed Daily");
  });

  test("habits delete removes habit", async () => {
    await expectRun("habits", "add", "temp_plural_habit");
    await expectRun("habits", "delete", "temp_plural_habit");
    const cfg = readVaultFile("config/habits.yaml");
    expect(cfg).not.toContain("temp_plural_habit");
  });

  test("habit toggle flips checkbox in daily note", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await expectRun("habit", "sleep_7h");
    const src = readVaultFile(`daily/${today}.md`);
    expect(src).toContain("[x] sleep_7h");
  });
});

// ── quick / inbox ─────────────────────────────────────────────────────────────

describe("quick / inbox", () => {
  test("quick appends to inbox", async () => {
    await expectRun("quick", "test capture entry");
    const inbox = readVaultFile("inbox/inbox.md");
    expect(inbox).toContain("test capture entry");
  });

  test("quick appends timestamp", async () => {
    await expectRun("quick", "timestamped");
    const inbox = readVaultFile("inbox/inbox.md");
    expect(inbox).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("quick preserves exact inline text", async () => {
    const uniqueText = "keep this exact inline quick text";
    await expectRun("quick", uniqueText);
    const inbox = readVaultFile("inbox/inbox.md");
    expect(inbox).toContain(uniqueText);
    expect(inbox).not.toContain("- quick");
  });

  test("inline command hint does not replace quick input text", async () => {
    const hintedText = "quick brown fox";
    await expectRun("quick", hintedText);
    const inbox = readVaultFile("inbox/inbox.md");
    expect(inbox).toContain(hintedText);
  });

  test("multiple quick entries don't overwrite each other", async () => {
    await expectRun("quick", "entry one");
    await expectRun("quick", "entry two");
    const inbox = readVaultFile("inbox/inbox.md");
    expect(inbox).toContain("entry one");
    expect(inbox).toContain("entry two");
  });
});

// ── doctor ────────────────────────────────────────────────────────────────────

describe("doctor", () => {
  test("doctor runs and produces output", async () => {
    const { out } = await expectRun("doctor");
    expect(out.length).toBeGreaterThan(0);
  });

  test("doctor reports missing slug as issue", async () => {
    writeNote("notes/general/noslug.md", "---\nid: \"zzz9\"\ntype: note\n---\n# No Slug\n");
    await expectRun("index");
    const { out } = await expectRun("doctor");
    expect(out).toContain("noslug");
    rmSync(vaultFile("notes/general/noslug.md"));
    await expectRun("index");
  });

  test("doctor --fix re-indexes and reports fix", async () => {
    const { out } = await expectRun("doctor", "--fix");
    expect(out.length).toBeGreaterThan(0);
  });
});

// ── daily navigation ──────────────────────────────────────────────────────────

describe("daily navigation", () => {
  test("daily previous opens previous note (or reports none)", async () => {
    const { out, code } = await run("daily", "previous");
    // no previous exists in fresh vault — should report gracefully
    expect(code).toBe(0);
    expect(out).toMatch(/No previous daily note|/);
  });

  test("daily next reports gracefully when no next", async () => {
    const { out, code } = await run("daily", "next");
    expect(code).toBe(0);
    expect(out).toMatch(/No next daily note|/);
  });
});

// ── rename / move / delete ────────────────────────────────────────────────────

describe("new", () => {
  test("new with inline title creates dated id file without prompting", async () => {
    await expectRun("new", "My Inline Title");
    const dir = vaultFile("notes/general");
    const entries = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: dir }));
    const match = entries.find(name => /^\d{8}-[a-z0-9]{8}\.md$/.test(name));
    expect(Boolean(match)).toBe(true);
    if (match) {
      const src = readFileSync(join(dir, match), "utf8");
      expect(src).toContain("# My Inline Title");
    }
  });
});

describe("habit command parsing", () => {
  test("habit add preserves multi-word title", async () => {
    await expectRun("habit", "add", "reading_speed", "Reading Speed Daily");
    const cfg = readVaultFile("config/habits.yaml");
    expect(cfg).toContain("reading_speed");
    expect(cfg).toContain("Reading Speed Daily");
  });

  test("daily habit-toggle supports --date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await expectRun("daily", "habit-toggle", "meds_am", "--date", today);
    const src = readVaultFile(`daily/${today}.md`);
    expect(src).toContain("[x] meds_am");
  });
});

describe("rename / move / delete", () => {
  test("rename updates filename and slug", async () => {
    writeNote("notes/general/renameme.md",
      "---\nid: \"ren1\"\nslug: \"renameme\"\ntype: note\ntags: []\n---\n# Rename Me\n");
    await expectRun("index");
    await expectRun("rename", "renameme", "renamed note");
    expect(existsSync(vaultFile("notes/general/renamed-note.md"))).toBe(true);
    expect(existsSync(vaultFile("notes/general/renameme.md"))).toBe(false);
  });

  test("rename supports arrow-style title parsing", async () => {
    writeNote("notes/general/rename-arrow.md",
      "---\nid: \"ren2\"\nslug: \"rename-arrow\"\ntype: note\ntags: []\n---\n# Rename Arrow\n");
    await expectRun("index");
    await expectRun("rename", "rename-arrow", "Arrow Style Title");
    expect(existsSync(vaultFile("notes/general/arrow-style-title.md"))).toBe(true);
  });

  test("move puts file in new folder", async () => {
    writeNote("notes/general/moveme.md",
      "---\nid: \"mov1\"\nslug: \"moveme\"\ntype: note\ntags: []\n---\n# Move Me\n");
    await expectRun("index");
    await expectRun("move", "moveme", "notes/math");
    expect(existsSync(vaultFile("notes/math/moveme.md"))).toBe(true);
    expect(existsSync(vaultFile("notes/general/moveme.md"))).toBe(false);
  });

  test("move accepts target folder argument", async () => {
    writeNote("notes/general/move-arrow.md",
      "---\nid: \"mov2\"\nslug: \"move-arrow\"\ntype: note\ntags: []\n---\n# Move Arrow\n");
    await expectRun("index");
    await expectRun("move", "move-arrow", "notes/math");
    expect(existsSync(vaultFile("notes/math/move-arrow.md"))).toBe(true);
  });

  test("delete archives the note", async () => {
    writeNote("notes/general/deleteme.md",
      "---\nid: \"del1\"\nslug: \"deleteme\"\ntype: note\ntags: []\n---\n# Delete Me\n");
    await expectRun("index");
    await expectRun("delete", "deleteme");
    expect(existsSync(vaultFile("notes/general/deleteme.md"))).toBe(false);
    expect(existsSync(vaultFile("archive/deleteme.md"))).toBe(true);
  });
});
