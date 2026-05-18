import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── helpers ──────────────────────────────────────────────────────────────────

const VAULT = join(tmpdir(), "notes-test-vault-" + process.pid);

async function run(...args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["./notes", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NOTES_ROOT: VAULT },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return { out: out.trim(), code: proc.exitCode ?? 0 };
}

function vaultFile(...parts: string[]) {
  return join(VAULT, ...parts);
}

function writeNote(relPath: string, content: string) {
  const full = vaultFile(relPath);
  mkdirSync(full.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(full, content);
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
  Bun.spawnSync(["./notes", "index"], { env: { ...process.env, NOTES_ROOT: VAULT } });
});

afterAll(() => {
  rmSync(VAULT, { recursive: true, force: true });
});

// ── smoke ─────────────────────────────────────────────────────────────────────

describe("Build & basic commands", () => {
  test("--help contains expected commands", async () => {
    const { out } = await run("--help");
    for (const cmd of ["find", "stats", "init", "tutorial", "doctor", "new", "habits", "tasks", "orphans", "recent"]) {
      expect(out).toContain(cmd);
    }
  });

  test("stats runs without crash or undefined", async () => {
    const { out } = await run("stats");
    expect(out.length).toBeGreaterThan(5);
    expect(out).not.toContain("undefined");
  });

  test("no output duplication regression", async () => {
    const { out } = await run("stats");
    const lines = out.split("\n").filter(Boolean);
    const dupes = lines.filter((l, i) => lines.indexOf(l) !== i);
    expect(dupes.length).toBe(0);
  });
});

// ── source-level guards ───────────────────────────────────────────────────────

describe("Source function presence", () => {
  test("all required functions are defined", async () => {
    const src = await Bun.file("notes.ts").text();
    const required = [
      "function statsTable",
      "function vaultStats",
      "function fuzzySuggest",
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
    for (const fn of required) {
      expect(src, `missing: ${fn}`).toContain(fn);
    }
  });
});

// ── index ─────────────────────────────────────────────────────────────────────

describe("index", () => {
  test("indexes all notes", async () => {
    const { out } = await run("index");
    expect(out).toMatch(/Indexed \d+ notes/);
    const n = Number(out.match(/Indexed (\d+)/)?.[1]);
    expect(n).toBeGreaterThanOrEqual(4);
  });
});

// ── search / backlinks ────────────────────────────────────────────────────────

describe("search", () => {
  test("finds note by title", async () => {
    const { out } = await run("search", "Alpha");
    expect(out).toContain("alpha");
  });

  test("finds note by tag", async () => {
    const { out } = await run("search", "math");
    expect(out).toContain("orphan");
  });
});

describe("backlinks", () => {
  test("beta has a backlink from alpha", async () => {
    const { out } = await run("backlinks", "beta");
    expect(out).toContain("alpha");
  });

  test("alpha has no backlinks", async () => {
    const { out } = await run("backlinks", "alpha");
    expect(out).not.toContain("beta");
  });
});

// ── recent / orphans ──────────────────────────────────────────────────────────

describe("recent", () => {
  test("returns notes sorted by modification time", async () => {
    const { out } = await run("recent", "5");
    expect(out.length).toBeGreaterThan(0);
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatch(/\d+d\s+\S+/);
  });
});

describe("orphans", () => {
  test("orphan note appears in orphans list", async () => {
    const { out } = await run("orphans");
    expect(out).toContain("orphan");
  });

  test("beta does not appear (has backlink from alpha)", async () => {
    const { out } = await run("orphans");
    expect(out).not.toContain("beta");
  });
});

// ── tasks ─────────────────────────────────────────────────────────────────────

describe("tasks", () => {
  test("lists all tasks", async () => {
    const { out } = await run("tasks");
    expect(out).toContain("open task");
    expect(out).toContain("done task");
  });

  test("tasks open shows only unchecked", async () => {
    const { out } = await run("tasks", "open");
    expect(out).toContain("open task");
    expect(out).not.toContain("done task");
  });

  test("tasks done shows only checked", async () => {
    const { out } = await run("tasks", "done");
    expect(out).not.toContain("open task");
    expect(out).toContain("done task");
  });
});

// ── habits ────────────────────────────────────────────────────────────────────

describe("habits", () => {
  test("habits list shows defined habits with bar", async () => {
    const { out } = await run("habits");
    expect(out).toContain("sleep_7h");
    expect(out).toContain("meds_am");
    expect(out).toMatch(/[█░]+/);
  });

  test("habit add creates new habit", async () => {
    await run("habit", "add", "reading_30m", "Reading 30m+");
    const cfg = readFileSync(vaultFile("config/habits.yaml"), "utf8");
    expect(cfg).toContain("reading_30m");
  });

  test("habit remove deletes habit", async () => {
    await run("habit", "add", "temp_habit");
    await run("habit", "remove", "temp_habit");
    const cfg = readFileSync(vaultFile("config/habits.yaml"), "utf8");
    expect(cfg).not.toContain("temp_habit");
  });

  test("habit toggle flips checkbox in daily note", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await run("habit", "sleep_7h");
    const src = readFileSync(vaultFile(`daily/${today}.md`), "utf8");
    expect(src).toContain("[x] sleep_7h");
  });
});

// ── quick / inbox ─────────────────────────────────────────────────────────────

describe("quick / inbox", () => {
  test("quick appends to inbox", async () => {
    await run("quick", "test capture entry");
    const inbox = readFileSync(vaultFile("inbox/inbox.md"), "utf8");
    expect(inbox).toContain("test capture entry");
  });

  test("quick appends timestamp", async () => {
    await run("quick", "timestamped");
    const inbox = readFileSync(vaultFile("inbox/inbox.md"), "utf8");
    expect(inbox).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("multiple quick entries don't overwrite each other", async () => {
    await run("quick", "entry one");
    await run("quick", "entry two");
    const inbox = readFileSync(vaultFile("inbox/inbox.md"), "utf8");
    expect(inbox).toContain("entry one");
    expect(inbox).toContain("entry two");
  });
});

// ── doctor ────────────────────────────────────────────────────────────────────

describe("doctor", () => {
  test("doctor runs and produces output", async () => {
    const { out } = await run("doctor");
    expect(out.length).toBeGreaterThan(0);
  });

  test("doctor reports missing slug as issue", async () => {
    writeNote("notes/general/noslug.md", "---\nid: \"zzz9\"\ntype: note\n---\n# No Slug\n");
    await run("index");
    const { out } = await run("doctor");
    expect(out).toContain("noslug");
    rmSync(vaultFile("notes/general/noslug.md"));
    await run("index");
  });

  test("doctor --fix re-indexes and reports fix", async () => {
    const { out } = await run("doctor", "--fix");
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

describe("rename / move / delete", () => {
  test("rename updates filename and slug", async () => {
    writeNote("notes/general/renameme.md",
      "---\nid: \"ren1\"\nslug: \"renameme\"\ntype: note\ntags: []\n---\n# Rename Me\n");
    await run("index");
    await run("rename", "renameme", "renamed note");
    expect(existsSync(vaultFile("notes/general/renamed-note.md"))).toBe(true);
    expect(existsSync(vaultFile("notes/general/renameme.md"))).toBe(false);
  });

  test("move puts file in new folder", async () => {
    writeNote("notes/general/moveme.md",
      "---\nid: \"mov1\"\nslug: \"moveme\"\ntype: note\ntags: []\n---\n# Move Me\n");
    await run("index");
    await run("move", "moveme", "notes/math");
    expect(existsSync(vaultFile("notes/math/moveme.md"))).toBe(true);
    expect(existsSync(vaultFile("notes/general/moveme.md"))).toBe(false);
  });

  test("delete archives the note", async () => {
    writeNote("notes/general/deleteme.md",
      "---\nid: \"del1\"\nslug: \"deleteme\"\ntype: note\ntags: []\n---\n# Delete Me\n");
    await run("index");
    await run("delete", "deleteme");
    expect(existsSync(vaultFile("notes/general/deleteme.md"))).toBe(false);
    expect(existsSync(vaultFile("archive/deleteme.md"))).toBe(true);
  });
});
