// Utility functions

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "note";
}

export function yamlStringify(data: Record<string, any>) {
  const out: string[] = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string") {
      out.push(`${k}: "${v}"`);
    } else if (Array.isArray(v)) {
      out.push(`${k}:`);
      for (const item of v) out.push(`  - ${item}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.push(`${k}: ${v}`);
    }
  }
  out.push("---");
  return out.join("\n");
}

export function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}
