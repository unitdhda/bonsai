// Parsing functions for notes content
import { basename } from "node:path";
import type { Habit, Task } from "../types/index.ts";
import { HABIT_RE, TASK_RE, TAG_RE, WIKILINK_RE, MDLINK_RE } from "../types/index.ts";

export function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } {
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
      if (!fm[current]) fm[current] = [];
      fm[current].push(line.slice(4).trim().replace(/^"|"$/g, ""));
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

export function parseHabits(body: string): Habit[] {
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

    const match = line.match(HABIT_RE);
    if (!match) continue;

    habits.push({
      key: match[2],
      done: match[1].toLowerCase() === "x",
    });
  }

  return habits;
}

export function parseTasks(body: string): Task[] {
  const tasks: Task[] = [];
  const lines = body.split("\n");
  let inHabits = false;

  for (const line of lines) {
    if (/^##\s+Habits\s*$/.test(line)) {
      inHabits = true;
      continue;
    }
    if (inHabits && /^##\s+/.test(line)) {
      inHabits = false;
    }
    if (inHabits) continue;

    const match = line.match(TASK_RE);
    if (!match) continue;

    tasks.push({
      done: match[1].toLowerCase() === "x",
      text: match[2],
    });
  }

  return tasks;
}

export function parseLinks(body: string): string[] {
  const links: string[] = [];

  for (const match of body.matchAll(WIKILINK_RE)) {
    links.push(match[1].trim());
  }

  for (const match of body.matchAll(MDLINK_RE)) {
    const target = match[1];
    if (!target.endsWith(".md") || target.includes("://")) continue;
    links.push(basename(target, ".md"));
  }

  return links;
}

export function parseTags(fmTags: unknown, body: string): string[] {
  const tags = new Set<string>();

  if (Array.isArray(fmTags)) {
    for (const tag of fmTags) tags.add(String(tag));
  } else if (typeof fmTags === "string" && fmTags) {
    tags.add(fmTags);
  }

  for (const match of body.matchAll(TAG_RE)) {
    tags.add(match[1]);
  }

  return [...tags].sort();
}
