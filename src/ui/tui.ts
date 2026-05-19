// TUI main loop and event handling
import { fstatSync } from "node:fs";
import { setTuiScreen, setTuiStatus, setTuiStream } from "../core/index.ts";
import { TerminalScreen } from "./screen.ts";
import { fuzzySuggest, inlineCommandHint, resolveSubmittedCommand, executeLine } from "./commands.ts";
import { vaultStats, leftTable, rightTable } from "./components.ts";
import { mascot, IMAGE_MASCOT_WIDTH } from "../../mascot.ts";

const SESSION_BONSAI_SEED = Math.floor(Math.random() * 1e9);

type KeyEvent = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
};

function isTty() {
  try { return fstatSync(0).isCharacterDevice() && fstatSync(1).isCharacterDevice(); } catch { return false; }
}

export async function cmdTui() {
  if (!isTty()) {
    printHelp(false);
    return;
  }

  const screen = new TerminalScreen();
  setTuiScreen(screen);

  let input = "";
  let selected = 0;
  let scrollOffset = 0;
  let frame = 0;
  let message = "Type naturally. Tab/↑/↓/Enter/Esc";
  let busy = false;
  let liveLines: string[] = [];
  let fullRedraw = () => {};

  setTuiStatus(text => { message = text; fullRedraw(); });
  setTuiStream(line => { liveLines = [...liveLines, line].slice(-8); fullRedraw(); });
  screen.enter();

  fullRedraw = () => {
    screen.resize();
    screen.clear();

    const w = screen.width;
    const h = screen.height;
    const stats = vaultStats();

    // Layout: left (tasks+habits) | bonsai (center) | right (vault+tags)
    const mascotRows = mascot(frame, SESSION_BONSAI_SEED);
    const topPaneY = 1;
    const leftLines = leftTable(stats).split("\n");
    const rightLines = rightTable(stats).split("\n");
    const topPaneH = Math.max(mascotRows.length, leftLines.length, rightLines.length);
    const padding = 2;

    const bonsaiX = Math.floor((w - IMAGE_MASCOT_WIDTH) / 2);
    const rightPaneWidth = Math.max(...rightLines.map(line => line.length), 0);
    const rightX = Math.max(padding, w - padding - rightPaneWidth);

    // Left: tasks + habits, top-aligned
    leftLines.forEach((line, i) => {
      screen.write(padding, topPaneY + i, line, { fg: "#64748b" });
    });

    // Center: bonsai
    mascotRows.forEach((row, i) => {
      screen.write(bonsaiX + row.indent, topPaneY + i, row.text, { fg: "#a5b4fc", dim: i > 10 });
    });

    // Right: vault + tags, top-aligned
    rightLines.forEach((line, i) => {
      if (rightX < w) screen.write(rightX, topPaneY + i, line.padStart(rightPaneWidth), { fg: "#64748b" });
    });

    // Prompt: one line below top pane
    const promptY = topPaneY + topPaneH + 1;
    screen.write(0, promptY - 1, "─".repeat(w), { fg: "#475569" });
    const promptText = `> ${input}`;
    screen.write(padding, promptY, promptText, { fg: "#67e8f9" });

    const allSuggestions = fuzzySuggest(input);
    const hint = inlineCommandHint(input);
    const visibleRows = 7;
    if (selected < scrollOffset) scrollOffset = selected;
    if (selected >= scrollOffset + visibleRows) scrollOffset = selected - visibleRows + 1;
    const visibleSuggestions = allSuggestions.slice(scrollOffset, scrollOffset + visibleRows);
    if (hint) {
      screen.write(padding + promptText.length, promptY, ` ${hint.desc}`, { fg: "#94a3b8" });
    }

    const suggY = promptY + 2;
    for (let i = 0; i < visibleRows; i++) {
      const s = visibleSuggestions[i];
      if (!s) break;
      const absIdx = scrollOffset + i;
      const prefix = absIdx === selected ? "> " : "  ";
      screen.write(padding, suggY + i, `${prefix}${s.name.padEnd(14)} ${s.desc}`,
        absIdx === selected ? { fg: "#e0f2fe", bold: true } : { fg: "#cbd5e1" });
    }

    const liveY = h - 10;
    if (liveLines.length) {
      screen.write(2, liveY - 1, "─".repeat(Math.max(0, w - 4)), { fg: "#334155" });
      liveLines.forEach((line, i) => {
        screen.write(2, liveY + i, line.slice(0, Math.max(0, w - 4)), { fg: "#cbd5e1" });
      });
    }
    screen.write(2, h - 1, message.slice(0, Math.max(0, w - 4)), { fg: "#64748b", dim: true });
    screen.redraw();
  };

  const onKey = (str: string, key: KeyEvent) => {
    if (busy) return;
    if (key.name === "return" || key.name === "enter") {
      const suggestions = fuzzySuggest(input);
      const cmd = resolveSubmittedCommand(input, suggestions, selected);
      if (cmd) {
        const live = cmd === "sync" || cmd.startsWith("sync ");
        liveLines = [];
        if (!live) {
          screen.suspend();
          process.stdin.setRawMode(false);
        } else {
          busy = true;
        }
        executeLine(cmd).then(keep => {
          if (!keep) {
            setTuiStatus(null);
            setTuiStream(null);
            screen.cleanup();
            process.exit(0);
          }
          if (!live) {
            process.stdin.setRawMode(true);
            screen.resume();
          } else {
            busy = false;
          }
          input = "";
          selected = 0;
          scrollOffset = 0;
          if (!liveLines.length) message = `Ran: ${cmd}`;
          fullRedraw();
        }).catch(err => {
          if (!live) {
            process.stdin.setRawMode(true);
            screen.resume();
          } else {
            busy = false;
          }
          message = String(err?.message ?? err ?? `Failed: ${cmd}`);
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
    if (key.name === "left" || key.name === "right") {
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
    const esc = String.fromCharCode(27); // ESC character
    const mousePattern = new RegExp(`^${esc}\\[(<[\\d;]+[Mm]|M.{3})`);
    if (mousePattern.test(str)) { fullRedraw(); return; }
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

  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    frame++;
    fullRedraw();
    const h = ((frame * 1103515245) ^ SESSION_BONSAI_SEED) >>> 0;
    const base = 100 + (h % 61);
    const pause = (h % 19 === 0) ? 220 + ((h >>> 8) % 280) : 0;
    const drift = (h % 5 === 0) ? ((h >>> 3) % 40) : 0;
    const delay = base + pause + drift;
    timer = setTimeout(tick, delay);
  };

  fullRedraw();
  timer = setTimeout(tick, 100);
  await new Promise<void>(() => {});
  if (timer) clearTimeout(timer);
  setTuiStatus(null);
  setTuiStream(null);
}

function printHelp(verbose = false) {
  console.log("notes — Obsidian-like notes CLI/TUI\n");
  console.log("Usage:");
  console.log("  notes                 # start TUI (default)");
  console.log("  notes tui");
  console.log("  notes <command> [args]\n");
  if (!verbose) {
    console.log("Commands:");
    console.log("  index                          Rebuild markdown index cache");
    console.log("  find                           Fuzzy note+content picker with action menu");
    console.log("  search <query>                 Search id/title/aliases/tags");
    console.log("  backlinks <note>               Show incoming links");
    console.log("  preview <note>                 dprint-formatted preview");
    console.log("  view <note>                    pretty markdown view with path header");
    console.log("  daily open [--date YYYY-MM-DD] Create/open daily note from template");
    console.log("  daily habit-toggle <habit> [--date YYYY-MM-DD] Toggle habit checkbox");
    console.log("  recent                         Show recent notes");
    console.log("  stats                          Vault, task, habit statistics");
    console.log("  new <title>                    Create a new note from template");
    console.log("  quick <text>                   Append quick capture to inbox");
    console.log("  inbox                          Open the inbox note");
    console.log("\nType 'notes help' for full command list.\n");
  } else {
    console.log("Vault:");
    console.log("  index                          Rebuild markdown index cache");
    console.log("  find                           Fuzzy-pick note by path/title/tags");
    console.log("  search <query>                 Search titles, aliases, tags, ids");
    console.log("  backlinks <note>               Show notes linking to a note");
    console.log("  stats                          Vault statistics");
    console.log("  doctor [--fix]                 Check or repair vault health\n");
    console.log("Notes:");
    console.log("  new <title>                    Create a new note");
    console.log("  quick <text>                   Capture to inbox");
    console.log("  inbox                          Open inbox");
    console.log("  preview [note]                 dprint preview");
    console.log("  view [note]                    Pretty view");
    console.log("  recent [n]                     Show n recent notes (default 10)");
    console.log("  orphans                        Show notes with no backlinks\n");
    console.log("Editing:");
    console.log("  rename [note] [new title]      Rename note");
    console.log("  move [note] [folder]           Move note");
    console.log("  delete [note]                  Archive note\n");
    console.log("Daily:");
    console.log("  today                          Create/open today's daily note");
    console.log("  daily open [--date DATE]       Open a daily note");
    console.log("  yesterday                      Open previous daily note");
    console.log("  tomorrow                       Open next daily note\n");
    console.log("Tasks:");
    console.log("  tasks [open|done]              List all tasks");
    console.log("  task add [note] [text]         Add a task\n");
    console.log("Habits:");
    console.log("  habits                         List habits");
    console.log("  habit add [name] [title]       Add a habit");
    console.log("  habit remove [name]            Remove a habit");
    console.log("  habit fill [name] [date]       Manually fill a habit\n");
    console.log("Jujutsu:");
    console.log("  jj status                      Show jj status");
    console.log("  jj log                         Show jj history");
    console.log("  jj diff                        Show diff");
    console.log("  jj tui                         Interactive jj menu");
    console.log("  sync                           Run jj sync");
    console.log("  snapshot                       Create snapshot");
    console.log("  review                         Review changes\n");
    console.log("Television:");
    console.log("  tv install-channels            Install fuzzy picker channels");
    console.log("  tv notes                       Browse notes");
    console.log("  tv dailies                     Browse dailies");
    console.log("  tv habits                      Browse habits\n");
    console.log("Other:");
    console.log("  init                           Initialize vault");
    console.log("  tutorial                       Interactive tutorial");
    console.log("  migrate                        Migrate vault structure");
  }
}
