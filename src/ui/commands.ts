// Command definitions and matching logic
import {
  cmdIndex, cmdSearch, cmdBacklinks, cmdFind, cmdDailyOpen, cmdHabitToggle,
  cmdDailyHabitToggle, cmdInit, cmdTutorial, cmdMigrate, cmdJjAlias,
  cmdPreview, cmdView, cmdNew, cmdQuick, cmdInbox, cmdRecent, cmdOrphans,
  cmdRename, cmdMove, cmdDelete, cmdTasks, cmdTasksAdd, cmdTaskAction, cmdHabitList,
  cmdHabitAdd, cmdHabitRemove, cmdHabitSet, cmdHabitFill, cmdDailyNav,
  cmdDoctor, cmdTvInstallChannels,
  cmdTv, cmdCommandBar, cmdLinks,
} from "../core/index.ts";

export type CommandInfo = { name: string; desc: string; tags: string };

export const COMMANDS: CommandInfo[] = [
  {name: "index", desc: "rebuild the note index cache", tags: "rebuild refresh cache metadata parse vault"},
  {name: "find", desc: "find notes by path, title, or content", tags: "note picker fzf title alias tag editor search"},
  {name: "backlinks", desc: "show notes linking to a note", tags: "incoming links graph references mentions"},
  {name: "today", desc: "open or create today's daily note", tags: "daily journal date open create"},
  {name: "habit", desc: "toggle a habit checkbox in today's daily", tags: "daily tracker checkbox streak routine legacy"},
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
  {name: "tasks", desc: "browse and manage tasks in Television", tags: "tasks todo open done checklist television"},
  {name: "habits", desc: "browse and manage habits in Television", tags: "habits tracker streak consistency television"},
  {name: "yesterday", desc: "open yesterday's daily note", tags: "daily back navigate previous"},
  {name: "tomorrow", desc: "open tomorrow's daily note", tags: "daily forward navigate next"},
  {name: "doctor", desc: "check vault health", tags: "health check doctor lint validate"},
  {name: "doctor --fix", desc: "auto-fix vault issues", tags: "fix repair doctor validate"},
  {name: "sync", desc: "run jj sync alias", tags: "jj git push version control"},
  {name: "preview", desc: "render a note preview with dprint", tags: "markdown md read view format"},
  {name: "view", desc: "pretty markdown view with header (dprint)", tags: "markdown md view pretty dprint"},
  {name: "tv install", desc: "install Television channels", tags: "television fuzzy channels setup"},
  {name: "quit", desc: "exit the TUI", tags: "exit close"},
];

export function fuzzySuggest(input: string): CommandInfo[] {
  const trimmed = input.trim();
  if (!trimmed) return COMMANDS;

  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  const score = (c: CommandInfo) => {
    const hay = `${c.name} ${c.desc} ${c.tags}`.toLowerCase();
    const nameIdx = c.name.toLowerCase().indexOf(firstWord);
    const hayIdx = hay.indexOf(firstWord);
    if (nameIdx === 0) return 0;
    if (nameIdx > 0) return 10 + nameIdx;
    if (hayIdx >= 0) return 100 + hayIdx;
    return 9999;
  };

  let results = COMMANDS.filter(c => score(c) < 9999).sort((a, b) => score(a) - score(b));
  const exactMatch = COMMANDS.find(c => c.name === firstWord);
  if (exactMatch && results[0] !== exactMatch) {
    results = [exactMatch, ...results.filter(c => c !== exactMatch)];
  }
  return results;
}

export function inlineCommandHint(input: string): CommandInfo | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return [...COMMANDS]
    .sort((a, b) => b.name.length - a.name.length)
    .find(command => trimmed === command.name);
}

export function resolveSubmittedCommand(input: string, suggestions: CommandInfo[], selectedIndex = 0): string {
  const line = input.trim();
  if (!line) return suggestions[selectedIndex]?.name ?? suggestions[0]?.name ?? "";
  const hasArguments = line.includes(" ");
  if (hasArguments) return line;
  if (COMMANDS.some(command => command.name === line)) return line;
  return suggestions[selectedIndex]?.name ?? suggestions[0]?.name ?? line;
}

function splitArrowArgs(input: string) {
  const [left, ...right] = input.split(" -> ");
  return [left.trim(), right.join(" -> ").trim()] as const;
}

function hasInlineArgs(raw: string, command: string) {
  return raw.length > command.length && raw[command.length] === " ";
}

export type CommandMatcher = {
  match: (raw: string) => boolean;
  run: (raw: string) => void | Promise<void>;
};

export const COMMAND_MATCHERS: CommandMatcher[] = [
  {match: raw => raw === "index" || raw === "rebuild note index", run: () => cmdIndex()},
  {match: raw => raw === "find" || raw === "search" || raw === "find in notes" || raw.startsWith("find ") || raw.startsWith("search "),
   run: raw => { const q = raw.replace(/^(?:find|search)\s*/, "").trim(); cmdFind(q); }},
  {match: raw => raw === "backlinks" || raw.startsWith("backlinks ") || raw.startsWith("show backlinks "),
   run: raw => cmdBacklinks(raw === "backlinks" ? "" : raw.replace(/^show backlinks\s+|^backlinks\s+/, ""))},
  {match: raw => raw === "today" || raw === "open today note" || raw === "daily open", run: () => cmdDailyOpen()},
  {match: raw => raw === "yesterday", run: () => cmdDailyNav("yesterday")},
  {match: raw => raw === "tomorrow", run: () => cmdDailyNav("tomorrow")},
  {match: raw => raw === "recent", run: () => cmdRecent()},
  {match: raw => raw === "habits", run: () => cmdTv("habits")},
  {match: raw => raw === "habits list" || raw === "habits --list", run: () => cmdHabitList()},
  {match: raw => raw.startsWith("habits add ") || raw.startsWith("habits --add "),
   run: raw => {
     const parts = raw.replace(/^habits add\s+|^habits --add\s+/, "").trim().split(" ");
     const key = parts[0] ?? "";
     cmdHabitAdd(key, parts.slice(1).join(" ") || undefined);
   }},
  {match: raw => raw.startsWith("habits remove ") || raw.startsWith("habits delete ") || raw.startsWith("habits --remove ") || raw.startsWith("habits --delete "),
   run: raw => cmdHabitRemove(raw.replace(/^habits remove\s+|^habits delete\s+|^habits --remove\s+|^habits --delete\s+/, ""))},
  {match: raw => raw.startsWith("habits toggle ") || raw.startsWith("habits --toggle "),
   run: raw => cmdHabitToggle(raw.replace(/^habits toggle\s+|^habits --toggle\s+/, "").replace(/\s+--date\s+.+$/, ""), raw.match(/\s+--date\s+(\S+)$/)?.[1])},
  {match: raw => raw.startsWith("habits check ") || raw.startsWith("habits close ") || raw.startsWith("habits --close "),
   run: raw => cmdHabitSet(raw.replace(/^habits check\s+|^habits close\s+|^habits --close\s+/, "").replace(/\s+--date\s+.+$/, ""), raw.match(/\s+--date\s+(\S+)$/)?.[1], true)},
  {match: raw => raw.startsWith("habits uncheck ") || raw.startsWith("habits open ") || raw.startsWith("habits --open "),
   run: raw => cmdHabitSet(raw.replace(/^habits uncheck\s+|^habits open\s+|^habits --open\s+/, "").replace(/\s+--date\s+.+$/, ""), raw.match(/\s+--date\s+(\S+)$/)?.[1], false)},
  {match: raw => raw === "habit add" || raw.startsWith("habit add "),
   run: raw => {
     const parts = raw.slice("habit add".length).trim().split(" ");
     const key = parts[0] ?? "";
     cmdHabitAdd(key, parts.slice(1).join(" ") || undefined);
   }},
  {match: raw => raw === "habit remove" || raw.startsWith("habit remove "),
   run: raw => cmdHabitRemove(raw.slice("habit remove".length).trim())},
  {match: raw => raw === "habit list", run: () => cmdHabitList()},
  {match: raw => raw === "daily habit-toggle" || raw.startsWith("daily habit-toggle "),
   run: raw => cmdDailyHabitToggle(raw === "daily habit-toggle" ? "" : raw.replace(/^daily habit-toggle\s+/, ""))},
  {match: raw => raw === "habit" || raw.startsWith("habit ") || raw.startsWith("toggle daily habit "),
   run: raw => cmdHabitToggle(raw === "habit" ? "" : raw.replace(/^habit\s+|^toggle daily habit\s+/, ""))},
  {match: raw => raw === "init", run: () => cmdInit()},
  {match: raw => raw === "tutorial", run: () => cmdTutorial()},
  {match: raw => raw === "migrate", run: () => cmdMigrate()},
  {match: raw => raw === "sync", run: raw => cmdJjAlias(raw)},
  {match: raw => raw === "preview" || raw.startsWith("preview ") || raw.startsWith("preview note "),
   run: raw => cmdPreview(raw === "preview" ? "" : raw.replace(/^preview note\s+|^preview\s+/, ""))},
  {match: raw => raw === "view" || raw === "md" || raw.startsWith("view ") || raw.startsWith("md "),
   run: raw => cmdView(raw === "view" || raw === "md" ? "" : raw.replace(/^view\s+|^md\s+/, ""))},
  {match: raw => raw === "new" || raw.startsWith("new "),
   run: raw => cmdNew(hasInlineArgs(raw, "new") ? raw.slice(3).trim() : "")},
  {match: raw => raw === "quick" || raw.startsWith("quick "),
   run: raw => cmdQuick(hasInlineArgs(raw, "quick") ? raw.slice(5).trim() : "")},
  {match: raw => raw === "inbox", run: () => cmdInbox()},
  {match: raw => raw === "recent", run: () => cmdRecent()},
  {match: raw => raw === "orphans", run: () => cmdOrphans()},
  {match: raw => raw === "rename" || raw.startsWith("rename "),
   run: raw => {const rest = raw.slice(6).trim(); if (!rest) return cmdRename("", ""); const [note, newTitle] = splitArrowArgs(rest); cmdRename(note, newTitle);}},
  {match: raw => raw === "move" || raw.startsWith("move "),
   run: raw => {if (raw === "move") return cmdMove("", ""); const [note, folder] = splitArrowArgs(raw.slice(5).trim()); cmdMove(note, folder);}},
  {match: raw => raw === "delete" || raw.startsWith("delete "),
   run: raw => cmdDelete(raw === "delete" ? "" : raw.slice(7).trim())},
  {match: raw => raw === "tasks", run: () => cmdTv("tasks")},
  {match: raw => raw === "tasks open" || raw === "tasks done",
   run: raw => cmdTasks(raw.split(" ")[1])},
  {match: raw => raw === "tasks list" || raw === "tasks list open" || raw === "tasks list done" || raw === "tasks --list" || raw === "tasks --list open" || raw === "tasks --list done",
   run: raw => cmdTasks(raw.split(" ").at(-1) === "list" ? undefined : raw.split(" ").at(-1))},
  {match: raw => raw.startsWith("tasks add ") || raw.startsWith("tasks --add "),
   run: raw => {const [note, ...rest] = raw.replace(/^tasks add\s+|^tasks --add\s+/, "").trim().split(" "); cmdTasksAdd(note, rest.join(" "));}},
  {match: raw => raw.startsWith("tasks toggle ") || raw.startsWith("tasks --toggle "),
   run: raw => cmdTaskAction(raw.replace(/^tasks toggle\s+|^tasks --toggle\s+/, ""), "toggle")},
  {match: raw => raw.startsWith("tasks close ") || raw.startsWith("tasks check ") || raw.startsWith("tasks --close "),
   run: raw => cmdTaskAction(raw.replace(/^tasks close\s+|^tasks check\s+|^tasks --close\s+/, ""), "close")},
  {match: raw => raw.startsWith("tasks delete ") || raw.startsWith("tasks remove ") || raw.startsWith("tasks --delete ") || raw.startsWith("tasks --remove "),
   run: raw => cmdTaskAction(raw.replace(/^tasks delete\s+|^tasks remove\s+|^tasks --delete\s+|^tasks --remove\s+/, ""), "delete")},
  {match: raw => raw.startsWith("task add "),
   run: raw => {const [note, ...rest] = raw.slice(9).trim().split(" "); cmdTasksAdd(note, rest.join(" "));}},
  {match: raw => raw === "doctor" || raw === "doctor --fix", run: raw => cmdDoctor(raw.endsWith("--fix"))},
  {match: raw => raw === "tv install" || raw === "install television channels" || raw === "tv install-channels", run: () => cmdTvInstallChannels()},
];

export async function executeLine(line: string): Promise<boolean> {
  const raw = line.trim();
  if (!raw) return true;
  if (["quit", "exit"].includes(raw)) return false;
  if (["show help", "help"].includes(raw)) return true;

  const matcher = COMMAND_MATCHERS.find(entry => entry.match(raw));
  if (!matcher) {
    console.log("Unknown command");
    return true;
  }

  await matcher.run(raw);
  return true;
}
