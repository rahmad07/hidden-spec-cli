// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Section 3: a file as its lines, its line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Section 5: matching lines at three tiers. */
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}
function occurrences(file: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(file: string[], o: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    let pos = occurrences(file, o, t, from);
    if (eofOnly) pos = pos.filter((p) => p + o.length === file.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noeol: boolean;
  /** The patch line this came from was empty (unified body trim rule, section 6). */
  fromEmpty: boolean;
}

const bodyItem = (kind: 'ctx' | 'old' | 'new', text: string): BodyItem => ({ kind, text, noeol: false, fromEmpty: false });

/** Build the lines a body writes in place of the matched O lines (section 5). */
function applyBody(file: string[], items: BodyItem[], pos: number, tier: number): string[] {
  const o: string[] = [];
  for (const it of items) if (it.kind !== 'new') o.push(it.text);
  const p = o.length > 0 ? leadOf(o[0]!) : '';
  const f = o.length > 0 ? leadOf(file[pos] ?? '') : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(file[pos + oi] ?? '');
      oi++;
    } else if (it.kind === 'old') {
      oi++;
    } else if (tier === 2 && it.text !== '' && !/^[ \t]+$/.test(it.text) && it.text.startsWith(p)) {
      out.push(f + it.text.slice(p.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

function lastCtxOrNew(items: BodyItem[]): BodyItem | undefined {
  let last: BodyItem | undefined;
  for (const it of items) if (it.kind === 'ctx' || it.kind === 'new') last = it;
  return last;
}

/** Section 6: unified diffs. */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface USectionRaw {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(before);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    let nLen = 0;
    for (const it of h.items) {
      if (it.kind !== 'new') o.push(it.text);
      if (it.kind !== 'old') nLen++;
    }
    if (o.length > 0) {
      const found = findTier(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const out = applyBody(f.lines, h.items, best, found.tier);
      const runsToEnd = best + o.length === f.lines.length;
      f.lines = [...f.lines.slice(0, best), ...out, ...f.lines.slice(best + o.length)];
      if (runsToEnd) {
        const lastCN = lastCtxOrNew(h.items);
        f.final = lastCN === undefined ? true : !lastCN.noeol;
      }
      d += nLen - o.length;
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const out = applyBody(f.lines, h.items, ins, 0);
      const atEnd = ins === f.lines.length;
      f.lines = [...f.lines.slice(0, ins), ...out, ...f.lines.slice(ins)];
      if (atEnd) {
        const lastCN = lastCtxOrNew(h.items);
        f.final = lastCN === undefined ? true : !lastCN.noeol;
      }
      d += nLen;
    }
  }
  return renderFile(f);
}

function unifiedSectionEdit(s: USectionRaw, strict: boolean): Edit {
  let oldPath = s.pairOld ?? s.renameFrom ?? s.gitOld;
  let newPath = s.pairNew ?? s.renameTo ?? s.gitNew;
  const oldNull = oldPath === '/dev/null';
  const newNull = newPath === '/dev/null';
  if (oldNull) oldPath = null;
  if (newNull) newPath = null;
  const create = oldNull || s.create;
  const remove = newNull || s.remove;
  const hunks = s.hunks;
  if (create) {
    const np = newPath;
    const plus: string[] = [];
    let lastPlusNoeol = false;
    let hasPlus = false;
    for (const h of hunks) {
      for (const it of h.items) {
        if (it.kind === 'new') {
          plus.push(it.text);
          hasPlus = true;
          lastPlusNoeol = it.noeol;
        }
      }
    }
    return (tree) => {
      if (np === null) return;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.now.set(np, renderFile({ lines: plus, br: '\n', final: hasPlus ? !lastPlusNoeol : false }));
    };
  }
  if (remove) {
    const op = oldPath;
    return (tree) => {
      if (op === null) return;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  const op = oldPath;
  const np = newPath;
  if (op === null || np === null) return () => {};
  const isMove = op !== np;
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const after = applyHunks(before, hunks, strict, op);
    if (isMove) {
      tree.now.set(np, after);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, after);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USectionRaw[] = [];
  let sec: USectionRaw | null = null;
  let hunk: Hunk | null = null;
  let state: 'out' | 'header' | 'body' | 'after' = 'out';
  let pairDone = false;
  const endHunk = (): void => {
    if (hunk !== null) {
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.fromEmpty) hunk.items.pop();
      if (sec !== null) sec.hunks.push(hunk);
      hunk = null;
    }
  };
  const endSection = (): void => {
    endHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
    state = 'out';
    pairDone = false;
  };
  const blankSection = (): USectionRaw => ({ pairOld: null, pairNew: null, renameFrom: null, renameTo: null, gitOld: null, gitNew: null, create: false, remove: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endSection();
      sec = blankSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      state = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      if (state === 'header' && !pairDone && sec !== null) {
        sec.pairOld = headerPath(line.slice(4));
        sec.pairNew = headerPath(next.slice(4));
        pairDone = true;
        i += 2;
        continue;
      }
      endSection();
      sec = blankSection();
      sec.pairOld = headerPath(line.slice(4));
      sec.pairNew = headerPath(next.slice(4));
      pairDone = true;
      state = 'header';
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (sec === null || m === null) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      hunk = { a: Number(m[1]), items: [] };
      state = 'body';
      i++;
      continue;
    }
    if (state === 'body') {
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
        const kind = line === '' || line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : 'new';
        const item = bodyItem(kind, line === '' ? '' : line.slice(1));
        item.fromEmpty = line === '';
        hunk!.items.push(item);
        i++;
        continue;
      }
      if (line.startsWith('\\')) {
        const items = hunk!.items;
        if (items.length > 0) items[items.length - 1]!.noeol = true;
        i++;
        continue;
      }
      endHunk();
      state = 'after';
    }
    if (state === 'header' && sec !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        if (sec.pairNew === null) sec.pairNew = headerPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        sec.create = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        sec.remove = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  endSection();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Section 7: SEARCH/REPLACE blocks. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const items: BodyItem[] = [
      ...oldLines.map((t) => bodyItem('old', t)),
      ...newLines.map((t) => bodyItem('new', t)),
    ];
    const out = applyBody(f.lines, items, pos, found.tier);
    f.lines = [...f.lines.slice(0, pos), ...out, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */
const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOV = '*** Move to: ';

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

function findAnchor(file: string[], anchor: string, from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let k = from; k < file.length; k++) {
      if (lineEq(file[k]!, anchor, t)) return k;
    }
  }
  return -1;
}

function v4aSectionEdit(kind: 'add' | 'delete' | 'update', path: string, content: string[], contentStart: number, strict: boolean, sectionLineNo: number): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < content.length; k++) {
      const l = content[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${contentStart + k + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (let k = 0; k < content.length; k++) {
      if (!blank(content[k]!)) throw new Exit2(`error: parse ${contentStart + k + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let rest = content;
  let restStart = contentStart;
  if (content.length > 0 && content[0]!.startsWith(V_MOV)) {
    moveTo = content[0]!.slice(V_MOV.length).trim();
    rest = content.slice(1);
    restStart = contentStart + 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = 0; k < rest.length; k++) {
    const l = rest[k]!;
    const ln = restStart + k + 1;
    if (l.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: l.slice(2).trim(), items: [], eof: false };
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, items: [], eof: false };
      }
      const k2 = l === '' || l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : 'new';
      cur.items.push(bodyItem(k2, l === '' ? '' : l.slice(1)));
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLineNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const idx = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      const o: string[] = [];
      for (const it of ch.items) if (it.kind !== 'new') o.push(it.text);
      if (o.length > 0) {
        const found = findTier(f.lines, o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.pos[0]!;
        const out = applyBody(f.lines, ch.items, pos, found.tier);
        f.lines = [...f.lines.slice(0, pos), ...out, ...f.lines.slice(pos + o.length)];
        cursor = pos + out.length;
      } else {
        const ins = ch.eof ? f.lines.length : cursor;
        const out = applyBody(f.lines, ch.items, ins, 0);
        f.lines = [...f.lines.slice(0, ins), ...out, ...f.lines.slice(ins)];
        cursor = ins + out.length;
      }
    }
    const text = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith(V_ADD) || line.startsWith(V_DEL) || line.startsWith(V_UPD)) {
      const kind = line.startsWith(V_ADD) ? 'add' : line.startsWith(V_DEL) ? 'delete' : 'update';
      const prefix = kind === 'add' ? V_ADD : kind === 'delete' ? V_DEL : V_UPD;
      const path = line.slice(prefix.length).trim();
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD)) break;
        j++;
      }
      const content = lines.slice(i + 1, j);
      while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
      edits.push(v4aSectionEdit(kind, path, content, i + 1, strict, i + 1));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      changed.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
