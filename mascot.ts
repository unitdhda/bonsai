// Generated from bonsai.txt — do not hand-edit. Regenerate: python3 /tmp/gm.py
export type MascotRow = { indent: number; text: string; dim?: boolean };
export const IMAGE_MASCOT_WIDTH = 41;
export const IMAGE_MASCOT_ROWS: MascotRow[] = [
  { indent: 20, text: `,. s8b.` },
  { indent: 18, text: `,:88p.'J8ls.` },
  { indent: 16, text: `,?88\`s<._,\`*:..` },
  { indent: 15, text: `d8bs**.<)P*?ss.J88s.` },
  { indent: 9, text: `,._  *lYs.',sdPl,s:*-T8?8b` },
  { indent: 6, text: `,s8888bs. Gr;-*P*b8PY88P "* \`` },
  { indent: 5, text: `d88dsd*88,+'ssd8lsdb:s,  ,d:..` },
  { indent: 5, text: `"\`*"\` *Y*Yb8p,\`*y\`.s:-<:_?sd88b` },
  { indent: 10, text: `,-J r*'_,-'   \`"'=._\`*BONSAi,` },
  { indent: 6, text: `>\`',c ,'\`\`         \`*d8bs\`-"*"\`` },
  { indent: 1, text: `__.-',j .<'__              \`*'` },
  { indent: 0, text: `K===-==-=----'7` },
  { indent: 0, text: `\\\\.           :` },
  { indent: 1, text: `\\  \`   \`    /` },
  { indent: 2, text: `\`=-'""\`---'       ` },
];

const ANIM_SYMBOLS = [".", "'", "`", ",", "*"];

export function animateMascotLine(line: string, row: number, t: number, seed: number): string {
  const chars = [...line];
  for (let col = 0; col < chars.length; col++) {
    if (!/[8bsoY?*.'`,]/.test(chars[col])) continue;
    if ((cellHash(row, col, seed) & 15) !== 0) continue;
    const h = cellHash(row, col, seed);
    const period = 4 + (h % 11);
    const hold = 2 + ((h >>> 5) % 4);
    const pause = 3 + ((h >>> 9) % 9);
    const phase = (h >>> 3) % (period + hold + pause);
    const cycle = period + hold + pause;
    const pos = (t + phase) % cycle;
    if (pos < period) {
      const wobble = (t + (h >>> 1)) % 3 === 0 ? 0 : 1;
      chars[col] = ANIM_SYMBOLS[(h + t + wobble) % ANIM_SYMBOLS.length];
    } else if (pos === cycle - 1 && (h & 15) === 0) {
      chars[col] = chars[col] === "," ? "`" : ",";
    }
  }
  return chars.join("");
}

function cellHash(row: number, col: number, seed: number): number {
  let h = seed ^ (row * 2654435761) ^ (col * 2246822519);
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function mascot(t: number, seed: number): MascotRow[] {
  return IMAGE_MASCOT_ROWS.map((row, i) => ({
    ...row, text: animateMascotLine(row.text, i, t, seed)
  }));
}
