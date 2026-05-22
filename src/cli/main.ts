// Main entry point and CLI handler
import { fstatSync } from "node:fs";

function isTty() {
  try { return fstatSync(0).isCharacterDevice() && fstatSync(1).isCharacterDevice(); } catch { return false; }
}

import {
  getVault,
  cmdIndex,
  cmdSearch,
  cmdBacklinks,
  cmdDailyOpen,
  cmdHabitToggle,
  cmdDailyHabitToggle,
  cmdInit,
  cmdTutorial,
  cmdMigrate,
  cmdJjAlias,
  cmdPreview,
  cmdView,
  cmdLinks,
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
  cmdHabitFill,
  cmdDailyNav,
  cmdDoctor,
  cmdStats,
  cmdTag,
  cmdExplore,
  cmdTvInstallChannels,
  cmdTv,
  cmdTvItems,
  cmdTvOpenNote,
  cmdTvPreview,
  withSuspend,
} from "../core/index.ts";
import { cmdTui } from "../ui/tui.ts";

type CliCommandHandler = (args: string[]) => void | Promise<void>;

const CLI_COMMAND_HANDLERS: Record<string, CliCommandHandler> = {
  index: () => cmdIndex(),
  search: args => { const q = args.join(" "); if (q) return cmdSearch(q); return cmdSearch(""); },
  backlinks: args => cmdBacklinks(args[0]),
  today: () => cmdDailyOpen(),
  yesterday: () => cmdDailyNav("yesterday"),
  tomorrow: () => cmdDailyNav("tomorrow"),
  preview: args => cmdPreview(args[0]),
  view: args => cmdView(args[0]),
  links: args => cmdLinks(args[0]),
  init: () => cmdInit(),
  tutorial: () => cmdTutorial(),
  migrate: () => cmdMigrate(),
  sync: () => cmdJjAlias("sync"),
  new: args => cmdNew(args.join(" ")),
  quick: args => cmdQuick(args.join(" ")),
  inbox: () => cmdInbox(),
  recent: args => {
    if (!args.length && isTty()) return cmdTv("recent");
    cmdRecent(Number(args[0]) || 10);
  },
  explore: args => cmdExplore(args.join(" ")),
  browse: args => cmdExplore(args.join(" ")),
  tag: args => {
    const mode = args[0] === "remove" || args[0] === "delete" ? "remove" : "add";
    const note = args[0] === "add" || args[0] === "remove" || args[0] === "delete" ? args[1] : args[0];
    const tags = args[0] === "add" || args[0] === "remove" || args[0] === "delete" ? args.slice(2).join(" ") : args.slice(1).join(" ");
    cmdTag(note ?? "", mode, tags);
  },
  orphans: () => cmdOrphans(),
  rename: args => cmdRename(args[0], args.slice(1).join(" ")),
  move: args => cmdMove(args[0], args[1]),
  delete: args => cmdDelete(args[0]),
  tasks: args => {
    if (!args.length) return isTty() ? cmdTv("tasks") : cmdTasks();
    if (args[0] === "open" || args[0] === "done") return cmdTasks(args[0]);
    if (args[0] === "list" || args[0] === "--list") return cmdTasks(args[1]);
    if (args[0] === "add" || args[0] === "--add") return cmdTasksAdd(args[1], args.slice(2).join(" "));
    if (args[0] === "toggle" || args[0] === "--toggle") return cmdTaskAction(args[1], "toggle");
    if (args[0] === "close" || args[0] === "check" || args[0] === "--close") return cmdTaskAction(args[1], "close");
    if (args[0] === "delete" || args[0] === "remove" || args[0] === "--delete" || args[0] === "--remove") return cmdTaskAction(args[1], "delete");
    return isTty() ? cmdTv("tasks") : cmdTasks(args[0]);
  },
  task: args => {
    if (args[0] === "add") cmdTasksAdd(args[1], args.slice(2).join(" "));
  },
  habits: args => {
    if (!args.length) return isTty() ? cmdTv("habits") : cmdHabitList();
    if (args[0] === "list" || args[0] === "--list") return cmdHabitList();
    if (args[0] === "add" || args[0] === "--add") return cmdHabitAdd(args[1], args.slice(2).join(" ") || undefined);
    if (args[0] === "remove" || args[0] === "delete" || args[0] === "--remove" || args[0] === "--delete") return cmdHabitRemove(args[1]);
    if (args[0] === "toggle" || args[0] === "--toggle") return cmdHabitToggle(args[1], args[2] === "--date" ? args[3] : undefined);
    if (args[0] === "close" || args[0] === "check" || args[0] === "--close") return cmdHabitSet(args[1], args[2] === "--date" ? args[3] : undefined, true);
    if (args[0] === "open" || args[0] === "uncheck" || args[0] === "--open") return cmdHabitSet(args[1], args[2] === "--date" ? args[3] : undefined, false);
    return cmdTv("habits");
  },
  habit: args => {
    if (args[0] === "list") cmdHabitList();
    else if (args[0] === "add") cmdHabitAdd(args[1], args.slice(2).join(" ") || undefined);
    else if (args[0] === "remove") cmdHabitRemove(args[1]);
    else if (args[0] === "fill") cmdHabitFill(args[1], args[2]);
    else cmdHabitToggle(args[0], args[1]);
  },
  daily: args => {
    if (args[0] === "yesterday" || args[0] === "previous") cmdDailyNav("yesterday");
    else if (args[0] === "tomorrow" || args[0] === "next") cmdDailyNav("tomorrow");
    else if (args[0] === "open") cmdDailyOpen(args[1] === "--date" ? args[2] : undefined);
    else if (args[0] === "habit-toggle") cmdDailyHabitToggle(args[1], args[2] === "--date" ? args[3] : undefined);
    else console.log("today|yesterday|tomorrow");
  },
  stats: () => cmdStats(),
  doctor: args => cmdDoctor(args[0] === "--fix"),
  "command-bar": () => cmdCommandBar(),
  jj: args => {
    if (args[0] === "init") return cmdInit();
    console.log("Use 'sync' or 'init'.");
  },
  tv: args => {
    if (args[0] === "install-channels") cmdTvInstallChannels();
    else if (args[0] === "items") cmdTvItems(args[1]);
    else if (args[0] === "open-note") cmdTvOpenNote(args.slice(1).join(" "));
    else if (args[0] === "preview") cmdTvPreview(args.slice(2).join(" "), args[1]);
    else console.log("Use 'tv install-channels'.");
  },
  tui: () => cmdTui(),
  help: () => printHelp(true),
};

function printHelp(verbose = false) {
  console.log("notes — Obsidian-like notes CLI/TUI\n");
  console.log("Usage:");
  console.log("  notes                 # start TUI (default)");
  console.log("  notes tui");
  console.log("  notes <command> [args]\n");
  if (!verbose) {
    console.log("Commands:");
    console.log("  index                          Rebuild markdown index cache");
    console.log("  search <query>                 Search titles, ids, tags");
    console.log("  explore                        Browse notes in yazi");
    console.log("  backlinks <note>               Show incoming links");
    console.log("  preview <note>                 dprint-formatted preview");
    console.log("  view <note>                    pretty markdown view with path header");
    console.log("  today                          Create/open daily note");
    console.log("  yesterday                      Open previous daily note");
    console.log("  tomorrow                       Open next daily note");
    console.log("  recent [n]                     Browse or list recent notes");
    console.log("  daily habit-toggle <habit> [--date YYYY-MM-DD] Toggle habit checkbox");
    console.log("  new <title>                    Create a new note from template");
    console.log("  quick <text>                   Append quick capture to inbox");
    console.log("  tag [add|remove] <note> <tags>  Add or remove tags on a note");
    console.log("  inbox                          Open the inbox note");
    console.log("\nType 'notes help' for full command list.\n");
  } else {
    console.log("Vault:");
    console.log("  index                          Rebuild markdown index cache");
    console.log("  search <query>                 Search titles, ids, tags");
    console.log("  backlinks <note>               Show notes linking to a note");
    console.log("  doctor [--fix]                 Check or repair vault health\n");
    console.log("Notes:");
    console.log("  new <title>                    Create a new note");
    console.log("  quick <text>                   Capture to inbox");
    console.log("  inbox                          Open inbox");
    console.log("  preview [note]                 dprint preview");
    console.log("  view [note]                    Pretty view");
    console.log("  tag [add|remove] [note] [tags]  Add or remove tags on a note");
    console.log("  explore                        Browse notes in yazi");
    console.log("  recent [n]                     Show n recent notes (default 10)");
    console.log("  orphans                        Show notes with no backlinks\n");
    console.log("Editing:");
    console.log("  rename [note] [new title]      Rename note");
    console.log("  move [note] [folder]           Move note");
    console.log("  delete [note]                  Archive note\n");
    console.log("Daily:");
    console.log("  today                          Create/open today's daily note");
    console.log("  yesterday                      Open previous daily note");
    console.log("  tomorrow                       Open next daily note\n");
    console.log("Tasks:");
    console.log("  tasks                          Open tasks browser");
    console.log("  tasks --list [open|done]       List tasks in plain CLI");
    console.log("  tasks add [note] [text]        Add a task");
    console.log("  tasks toggle [path:line]       Toggle a task");
    console.log("  tasks close [path:line]        Mark a task done");
    console.log("  tasks delete [path:line]       Delete a task\n");
    console.log("Habits:");
    console.log("  habits                         Open habits browser");
    console.log("  habits --list                  List habits in plain CLI");
    console.log("  habits add [id] [title]        Add a habit");
    console.log("  habits remove [id]             Remove a habit");
    console.log("  habits toggle [id] [--date]    Toggle today's/date habit");
    console.log("  habits check [id] [--date]     Mark today's/date habit done");
    console.log("  habits uncheck [id] [--date]   Mark today's/date habit open\n");
    console.log("Version control:");
    console.log("  sync                           Sync vault with jj or git");
    console.log("  init                           Initialize vault and repo\n");
    console.log("Television:");
    console.log("  tv install-channels            Install fuzzy picker channels\n");
    console.log("Other:");
    console.log("  init                           Initialize vault");
    console.log("  tutorial                       Interactive tutorial");
    console.log("  migrate                        Migrate vault structure\n");
  }
}

export async function main() {
  const args = process.argv.slice(2);

  if (!args.length) {
    await cmdTui();
    return;
  }

  const command = args[0];
  const rest = args.slice(1);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp(true);
    return;
  }

  const handler = CLI_COMMAND_HANDLERS[command];
  if (handler) {
    return await withSuspend(() => handler(rest));
  }

  console.log(`Unknown command: ${command}`);
  printHelp(false);
  process.exit(1);
}
