// Type definitions for notes app

export type Habit = {
  key: string;
  done: boolean;
};

export type Task = {
  done: boolean;
  text: string;
};

export type Note = {
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

export type Suspendable = {
  enter(): void;
  resume(): void;
  suspend(): void;
  cleanup(): void;
};

// Regex patterns
export const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
export const MDLINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;
export const TASK_RE = /^\s*- \[( |x|X)\] (.+)$/;
export const H1_RE = /^#\s+(.+)$/m;
export const TAG_RE = /(?<!\w)#([\w\-/]+)/g;
export const HABIT_RE = /^\s*- \[( |x|X)\] ([a-zA-Z0-9_-]+)\s*$/;
export const DAILY_NOTE_RE = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/;

export const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".jj",
  "__pycache__",
  ".venv",
]);
