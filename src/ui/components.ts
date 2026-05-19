// React components for TUI
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { IMAGE_MASCOT_WIDTH, mascot } from "../../mascot.ts";
import { loadIndex, buildHabitMap, countTasks, DAILY_NOTE_RE, streak } from "../core/index.ts";
import { fuzzySuggest, inlineCommandHint, resolveSubmittedCommand } from "./commands.ts";

const h = React.createElement;

export function vaultStats() {
  const notes = loadIndex();
  const dailyNotes = notes.filter(n => DAILY_NOTE_RE.test(n.path));
  const habits = buildHabitMap(notes);
  const { done, total } = countTasks(notes);
  const tags = new Map<string, number>();
  for (const n of notes) for (const t of n.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  const sortedTags = [...tags.entries()].sort((a, b) => b[1] - a[1]);

  const habitStrs = [...habits.entries()].map(([name, entries]) => ({
    name,
    streak: streak(entries),
  }));

  return { noteCount: notes.length, dailyNoteCount: dailyNotes.length, taskOpen: total - done, taskDone: done, topTags: sortedTags.slice(0, 5), habits: habitStrs };
}

function nb(s: string) {
  return s.replace(/ /g, "\xa0");
}

function fixedArt(lines: string[], width: number) {
  return lines.map(line => line.padEnd(width)).join("\n");
}

export function leftTable(stats: ReturnType<typeof vaultStats>): string {
  const lines: string[] = [];
  lines.push("Tasks");
  lines.push(`   Open: ${stats.taskOpen}   Done: ${stats.taskDone}`);
  lines.push("");
  lines.push("Habits");
  for (const h of stats.habits) {
    lines.push(`   ${h.name.padEnd(16)} ${h.streak}d`);
  }
  return lines.join("\n");
}

export function rightTable(stats: ReturnType<typeof vaultStats>): string {
  const lines: string[] = [];
  lines.push("Vault");
  lines.push(`   Notes: ${stats.noteCount}`);
  lines.push(`   Daily: ${stats.dailyNoteCount}`);
  lines.push("");
  lines.push("Top Tags");
  for (const [tag, count] of stats.topTags) {
    lines.push(`   ${(`#${tag}`).padEnd(16)} ${count}`);
  }
  return lines.join("\n");
}

export function statsTable(stats: ReturnType<typeof vaultStats>): string {
  return leftTable(stats);
}

export function Mascot({ frame }: { frame: number }) {
  const lines = mascot[frame % mascot.length];
  return h(Box, { flexDirection: "column" }, lines.map((line, i) => h(Text, { key: i }, line)));
}

export function CommandApp({ onSubmit }: { onSubmit: (line: string) => void }) {
  const [input, setInput] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [frame, setFrame] = useState(0);
  const suggestions = fuzzySuggest(input);
  const hint = inlineCommandHint(input);

  useInput((ch, key) => {
    if (key.upArrow) {
      setSelectedSuggestion(Math.max(0, selectedSuggestion - 1));
      setInput("");
    } else if (key.downArrow) {
      setSelectedSuggestion(Math.min(Math.max(0, suggestions.length - 1), selectedSuggestion + 1));
      setInput("");
    } else if (key.return) {
      const cmd = resolveSubmittedCommand(input, suggestions, selectedSuggestion);
      onSubmit(cmd);
      setInput("");
      setSelectedSuggestion(0);
    } else if (key.backspace) {
      setInput(input.slice(0, -1));
      setSelectedSuggestion(0);
    } else if (!key.ctrl && !key.meta && !key.shift && ch) {
      setInput(input + ch);
      setSelectedSuggestion(0);
    }
  });

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 200);
    return () => clearInterval(timer);
  }, []);

  const topBar = `> ${nb(input.padEnd(40))}${hint ? ` <- ${nb(hint.name)}` : ""}`;
  const maskHeight = 8;
  const maskWidth = IMAGE_MASCOT_WIDTH + 2;
  const contentHeight = 24 - maskHeight - 1 - 2;

  const displayedStats = suggestions.length === COMMANDS.length && input === "" ? statsTable(vaultStats()) : suggestions
    .slice(0, Math.max(0, contentHeight - 4))
    .map((cmd, i) => {
      const isSelected = i === selectedSuggestion;
      const marker = isSelected ? "> " : "  ";
      const text = `${marker}${cmd.name.padEnd(20)} ${cmd.desc}`;
      return {
        text,
        selected: isSelected,
      };
    })
    .map((line) => (line.selected ? `\x1b[7m${line.text}\x1b[0m` : line.text))
    .join("\n");

  const app = `${topBar}\n\n${displayedStats}\n${"─".repeat(60)}`;
  const appLines = app.split("\n");

  const mascotLines = (mascot[frame % mascot.length] ?? []).slice(0, maskHeight);
  const paddedMascot = mascotLines.map((line) => fixedArt([line], maskWidth));

  const maxAppLines = Math.max(appLines.length, paddedMascot.length);
  const output: string[] = [];
  for (let i = 0; i < maxAppLines; i++) {
    const appLine = appLines[i] || "";
    const mascotLine = paddedMascot[i] || "";
    output.push(`${appLine.padEnd(60)}  ${mascotLine}`);
  }

  return h(Box, { flexDirection: "column" }, output.map((line, i) => h(Text, { key: i, wrap: "truncate" }, line)));
}
