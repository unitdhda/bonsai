// Vault management and path operations
import { join, isAbsolute, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function detectVaultRoot() {
  const r = spawnSync("jj", ["root"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

let _JJ_ROOT: string | null = null;
function getJJRoot(): string {
  if (!_JJ_ROOT) {
    _JJ_ROOT = detectVaultRoot();
  }
  return _JJ_ROOT;
}

const JJ_ROOT = getJJRoot();
const PROJECT_ROOT = dirname(import.meta.path).startsWith("/$bunfs") ? process.cwd() : join(dirname(import.meta.path), "..", "..");

function isVaultDir(dir: string) {
  return existsSync(join(dir, ".notes_index.json")) || existsSync(join(dir, "config", "habits.yaml"));
}

function findVaultFromCwd(start: string) {
  let dir = start;
  while (true) {
    if (isVaultDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export function getVault() {
  if (process.env.NOTES_ROOT) return process.env.NOTES_ROOT;
  return findVaultFromCwd(process.cwd());
}

export function getIndex() { return join(getVault(), ".notes_index.json"); }
export function getDailyDir() { return join(getVault(), "daily"); }
export function getTemplate() { return join(getVault(), "templates", "daily-note.md"); }
export function getNoteTemplate() { return join(getVault(), "templates", "note.md"); }
export function getProjectTemplate() { return join(getVault(), "templates", "project.md"); }
export function getConfigDir() { return join(getVault(), "config"); }
export function getHabitsConfig() { return join(getConfigDir(), "habits.yaml"); }
export function getVaultConfig() { return join(getConfigDir(), "vault.yaml"); }

export function vaultPath(p: string) {
  return isAbsolute(p) ? p : join(getVault(), p);
}

export function ensureVaultDir() {
  mkdirSync(getVault(), { recursive: true });
}

export function ensureConfig() {
  const cfgDir = getConfigDir();
  mkdirSync(cfgDir, { recursive: true });
  const habitsPath = getHabitsConfig();
  const vaultCfgPath = getVaultConfig();
  if (!existsSync(habitsPath)) {
    writeFileSync(habitsPath, "habits:\n");
  }
  if (!existsSync(vaultCfgPath)) {
    writeFileSync(vaultCfgPath, "");
  }
}

export { PROJECT_ROOT, JJ_ROOT };
