// #region S-expression codec
// KiCad files (.kicad_sch, .kicad_pcb, .kicad_sym) are S-expressions.
// This is a faithful-enough parser/serializer: it preserves the quoted vs bare
// distinction so round-tripped files stay valid. KiCad reformats on its own
// save, so byte-exact indentation is not a goal, structural validity is.

export type Sx = SxList | SxAtom;

export interface SxList {
  kind: "list";
  items: Sx[];
}

export interface SxAtom {
  kind: "atom";
  value: string;
  quoted: boolean;
}

export function list(...items: Sx[]): SxList {
  return { kind: "list", items };
}

export function sym(value: string): SxAtom {
  return { kind: "atom", value, quoted: false };
}

export function str(value: string): SxAtom {
  return { kind: "atom", value, quoted: true };
}

export function num(value: number): SxAtom {
  // KiCad writes numbers without unnecessary trailing zeros.
  const s = Number.isInteger(value) ? value.toString() : value.toString();
  return { kind: "atom", value: s, quoted: false };
}

// Build a named list: (name child child ...)
export function node(name: string, ...children: Sx[]): SxList {
  return list(sym(name), ...children);
}

// #region parse
export function parse(input: string): SxList {
  const p = new Parser(input);
  const items: Sx[] = [];
  p.skipWs();
  while (!p.eof()) {
    items.push(p.readNode());
    p.skipWs();
  }
  // A KiCad file is a single top-level list.
  if (items.length === 1 && items[0].kind === "list") return items[0];
  return { kind: "list", items };
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  eof() {
    return this.i >= this.s.length;
  }

  skipWs() {
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i++;
      } else {
        break;
      }
    }
  }

  readNode(): Sx {
    const c = this.s[this.i];
    if (c === "(") return this.readList();
    if (c === '"') return this.readString();
    return this.readBareAtom();
  }

  private readList(): SxList {
    this.i++; // consume (
    const items: Sx[] = [];
    this.skipWs();
    while (!this.eof() && this.s[this.i] !== ")") {
      items.push(this.readNode());
      this.skipWs();
    }
    if (this.s[this.i] !== ")") throw new Error("Unbalanced S-expression: missing )");
    this.i++; // consume )
    return { kind: "list", items };
  }

  private readString(): SxAtom {
    this.i++; // consume opening quote
    let out = "";
    while (!this.eof()) {
      const c = this.s[this.i++];
      if (c === "\\") {
        const n = this.s[this.i++];
        switch (n) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          default: out += n; break;
        }
      } else if (c === '"') {
        return { kind: "atom", value: out, quoted: true };
      } else {
        out += c;
      }
    }
    throw new Error("Unterminated string in S-expression");
  }

  private readBareAtom(): SxAtom {
    let out = "";
    while (!this.eof()) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "(" || c === ")") break;
      out += c;
      this.i++;
    }
    return { kind: "atom", value: out, quoted: false };
  }
}

// #region serialize
function escapeString(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function atomToString(a: SxAtom): string {
  if (a.quoted) return `"${escapeString(a.value)}"`;
  // Bare atoms that would be ambiguous get quoted defensively.
  if (a.value === "" || /[\s()"]/.test(a.value)) return `"${escapeString(a.value)}"`;
  return a.value;
}

// A list is written on one line when it is small and contains no child lists.
function isLeafList(l: SxList): boolean {
  return l.items.every((it) => it.kind === "atom") && l.items.length <= 6;
}

export function serialize(sx: Sx, indent = 0): string {
  if (sx.kind === "atom") return atomToString(sx);
  const pad = "\t".repeat(indent);
  if (isLeafList(sx)) {
    return "(" + sx.items.map((it) => serialize(it, indent)).join(" ") + ")";
  }
  const parts: string[] = [];
  for (let idx = 0; idx < sx.items.length; idx++) {
    const it = sx.items[idx];
    if (idx === 0 && it.kind === "atom") {
      // Head symbol stays on the opening line.
      parts.push(atomToString(it));
    } else if (it.kind === "atom") {
      parts.push(atomToString(it));
    } else {
      parts.push("\n" + pad + "\t" + serialize(it, indent + 1));
    }
  }
  // Join head + inline atoms with spaces; child lists already carry newlines.
  let out = "(";
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (part.startsWith("\n")) out += part;
    else out += (k === 0 ? "" : " ") + part;
  }
  out += "\n" + pad + ")";
  return out;
}

// #region query helpers
export function findAll(l: SxList, name: string): SxList[] {
  const out: SxList[] = [];
  for (const it of l.items) {
    if (it.kind === "list" && it.items[0]?.kind === "atom" && it.items[0].value === name) {
      out.push(it);
    }
  }
  return out;
}

export function find(l: SxList, name: string): SxList | undefined {
  return findAll(l, name)[0];
}

// Value atoms of a named child, e.g. (version 20231120) -> ["20231120"]
export function values(l: SxList, name: string): string[] {
  const child = find(l, name);
  if (!child) return [];
  return child.items.slice(1).filter((x): x is SxAtom => x.kind === "atom").map((a) => a.value);
}

export function value(l: SxList, name: string): string | undefined {
  return values(l, name)[0];
}

export function numAt(l: SxList, idx: number): number {
  const it = l.items[idx];
  if (it?.kind === "atom") return parseFloat(it.value);
  return NaN;
}

export function atomVal(sx: Sx | undefined): string | undefined {
  if (sx?.kind === "atom") return sx.value;
  return undefined;
}
