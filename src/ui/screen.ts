// Terminal screen rendering and ANSI escape handling
type CellStyle = { fg?: string; bg?: string; bold?: boolean; italic?: boolean; dim?: boolean };
type Cell = { char: string; style: CellStyle };

export class TerminalScreen {
  width: number;
  height: number;
  buffer: Cell[][];
  
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.buffer = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ char: " ", style: {} }))
    );
  }
  
  resize() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.buffer = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ char: " ", style: {} }))
    );
  }
  
  clear() {
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++)
        this.buffer[y][x] = { char: " ", style: {} };
  }
  
  set(x: number, y: number, char: string, style: CellStyle = {}) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.buffer[y][x] = { char: char[0] || " ", style };
  }
  
  write(x: number, y: number, text: string, style: CellStyle = {}) {
    for (let i = 0; i < text.length; i++) this.set(x + i, y, text[i], style);
  }
  
  private sgr(s: CellStyle): string {
    const codes: number[] = [];
    if (s.bold) codes.push(1);
    if (s.italic) codes.push(3);
    if (s.dim) codes.push(2);
    if (s.fg) codes.push(38, 2, ...this.hexToRgb(s.fg));
    if (s.bg) codes.push(48, 2, ...this.hexToRgb(s.bg));
    return codes.length ? `\x1b[${codes.join(";")}m` : "";
  }
  
  private hexToRgb(hex: string): number[] {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }
  
  enter() {
    process.stdout.write(
      "\x1b[?1049h" + "\x1b[?25l" + "\x1b[2J\x1b[3J" + "\x1b[H" + 
      `\x1b[1;${this.height}r` + "\x1b[?1000h" + "\x1b[?1002h" + 
      "\x1b[?1006h" + "\x1b[?1007l"
    );
  }
  
  redraw() {
    let out = "\x1b[H";
    for (let y = 0; y < this.height; y++) {
      let line = "";
      let prev = "";
      for (let x = 0; x < this.width; x++) {
        const c = this.buffer[y][x];
        const code = this.sgr(c.style);
        if (code !== prev) {
          line += prev ? "\x1b[0m" : "";
          line += code;
          prev = code;
        }
        line += c.char;
      }
      line += "\x1b[0m";
      if (y < this.height - 1) line += "\r\n";
      out += line;
    }
    process.stdout.write(out);
  }
  
  suspend() {
    process.stdout.write("\x1b[?1007h" + "\x1b[?1002l" + "\x1b[?1006l" + "\x1b[?1000l" + "\x1b[?1049l" + "\x1b[?25h");
  }
  
  resume() {
    this.resize();
    process.stdout.write("\x1b[?1049h" + "\x1b[?25l" + "\x1b[2J\x1b[3J" + "\x1b[H" + 
      `\x1b[1;${this.height}r` + "\x1b[?1000h" + "\x1b[?1002h" + 
      "\x1b[?1006h" + "\x1b[?1007l");
  }
  
  cleanup() {
    process.stdout.write("\x1b[?1007h" + "\x1b[?1002l" + "\x1b[?1006l" + "\x1b[?1000l" + "\x1b[?1049l" + "\x1b[?25h" + "\x1b[r");
  }
}
