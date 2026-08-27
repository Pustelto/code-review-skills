#!/usr/bin/env node
// Deterministic static pre-review layer for the code-review skill.
// Node + web-tree-sitter (vendored WASM) — no Python, no network.
// Languages: TypeScript/TSX/JS, Kotlin, Python, Go, Ruby, Java (see EXT_LANG).
//
// Emits a MUST-CHECK report: off-diff files that depend on changed symbols
// (import blast radius + symbol usage) and resource read-vs-destroy pairs.
// Consumed by the skill to seed the hazard declaration so cross_file /
// resource_lifecycle can't be silently declared NO.
//
// Usage:
//   node blast-radius.mjs <repo> --base <sha> [--scope <subdir>] [--json]
//   node blast-radius.mjs <repo> --changed a.kt,b.kt [--scope <subdir>]
//   node blast-radius.mjs <repo> --seed-symbol Name [--resource noun] [--scope d]

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Parser = require(path.join(__dirname, "vendor", "tree-sitter.js"));

const EXT_LANG = {
  ".kt": "kotlin", ".kts": "kotlin",
  ".ts": "tsx", ".tsx": "tsx", ".mts": "tsx", ".cts": "tsx",
  ".js": "tsx", ".jsx": "tsx", ".mjs": "tsx", ".cjs": "tsx",
  ".py": "python", ".pyi": "python",
  ".go": "go", ".rb": "ruby", ".rake": "ruby", ".java": "java",
};
const GRAMMAR = {
  kotlin: "vendor/grammars/tree-sitter-kotlin.wasm",
  tsx: "vendor/grammars/tree-sitter-tsx.wasm",
  python: "vendor/grammars/tree-sitter-python.wasm",
  go: "vendor/grammars/tree-sitter-go.wasm",
  ruby: "vendor/grammars/tree-sitter-ruby.wasm",
  java: "vendor/grammars/tree-sitter-java.wasm",
};
const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", ".gradle", "generated", "__generated__"]);

const DESTROY = ["delete", "drop", "remove", "destroy", "purge", "truncate", "evict"];
const CREATE = ["create", "insert", "write", "save", "store", "persist", "rebase", "publish"];
const READ = ["get", "read", "fetch", "load", "query", "evaluate", "eval", "find", "list", "exists", "compute", "resolve"];

function walkFiles(root) {
  const out = [];
  (function rec(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(path.join(dir, e.name)); }
      else if (EXT_LANG[path.extname(e.name)]) out.push(path.join(dir, e.name));
    }
  })(root);
  return out;
}

const parsers = {};
let _inited = false;
async function ensureInit() {
  if (_inited) return;
  await Parser.init({ locateFile: () => path.join(__dirname, "vendor", "tree-sitter.wasm") });
  _inited = true;
}
async function getParser(lang) {
  await ensureInit();
  if (parsers[lang]) return parsers[lang];
  const L = await Parser.Language.load(path.join(__dirname, GRAMMAR[lang]));
  const p = new Parser();
  p.setLanguage(L);
  parsers[lang] = p;
  return p;
}

// Per-language node-type sets. tsx/kotlin keep the original generic-regex path
// (identical behavior, zero regression risk); the others match explicit node
// types so def/import/call extraction works on Python/Go/Ruby/Java too.
const IMPORT_NODES = new Set([
  "import_header", "import_statement", "import_declaration", "import_from_statement",
]);
const CALL_NODES = new Set([
  "call_expression", "call_suffix", "navigation_expression", "call", "method_invocation",
]);
const DEF_NODES = {
  python: new Set(["function_definition", "class_definition"]),
  go: new Set(["function_declaration", "method_declaration", "type_declaration"]),
  java: new Set(["class_declaration", "interface_declaration", "enum_declaration",
                 "record_declaration", "method_declaration", "annotation_type_declaration"]),
  ruby: new Set(["class", "module", "method", "singleton_method"]),
};

// def NAME via the grammar's `name` field (robust across grammars); Go's
// type_declaration carries the name one level down on its type_spec child.
function defName(n, txt) {
  let nm = null;
  try { nm = n.childForFieldName ? n.childForFieldName("name") : null; } catch { /* older node */ }
  if (!nm) {
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      try { const inner = c.childForFieldName && c.childForFieldName("name"); if (inner) { nm = inner; break; } } catch { /* skip */ }
    }
  }
  return nm ? txt(nm) : null;
}

// Parse one file → {imports:[raw], defs:[name], refs:Set<name>, calls:[{name,line}]}
function analyze(tree, src, lang) {
  const info = { imports: [], defs: [], refs: new Set(), calls: [] };
  const txt = (n) => src.slice(n.startIndex, n.endIndex);
  const defSet = DEF_NODES[lang];
  (function visit(n, depth) {
    const t = n.type;
    if (IMPORT_NODES.has(t)) {
      info.imports.push(txt(n).replace(/^(import|from)\s+/, "").trim());
    }
    if (defSet) {
      // Python/Go/Ruby/Java: explicit def node types (any depth — a nested
      // function_definition / method_declaration is still a real def).
      if (defSet.has(t)) { const nm = defName(n, txt); if (nm) info.defs.push(nm); }
    } else if (depth <= 2 && /(_declaration$|object_declaration)/.test(t) &&
        /(class|object|function|interface|type_alias|lexical|enum)/.test(t)) {
      // tsx/kotlin: original generic path, unchanged.
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (/identifier/.test(c.type)) { info.defs.push(txt(c)); break; }
        if (c.type === "variable_declarator" && c.childCount) { info.defs.push(txt(c.child(0))); }
      }
    }
    if (/identifier/.test(t)) info.refs.add(txt(n));
    if (CALL_NODES.has(t)) {
      const callee = txt(n).split("(")[0].trim();
      const name = callee.split(".").pop().split("::").pop();
      if (/^[A-Za-z_]\w*$/.test(name)) info.calls.push({ name, line: n.startPosition.row + 1 });
    }
    for (let i = 0; i < n.childCount; i++) visit(n.child(i), depth + 1);
  })(tree.rootNode, 0);
  return info;
}

async function buildIndex(files) {
  const idx = new Map();
  for (const f of files) {
    const lang = EXT_LANG[path.extname(f)];
    let src;
    try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    try {
      const tree = (await getParser(lang)).parse(src);
      idx.set(f, analyze(tree, src, lang));
    } catch { /* skip unparseable */ }
  }
  return idx;
}

// Resolve a TS import module string to a repo file (relative + index). Alias
// imports (non-relative) fall back to basename match, flagged approximate.
function importStemTail(raw) {
  const m = raw.match(/from\s+['"]([^'"]+)['"]/) || raw.match(/['"]([^'"]+)['"]/);
  const mod = m ? m[1] : raw.replace(/[;'"]/g, "").trim();
  return mod.split("/").pop().split(".").pop();
}

function importBlastRadius(idx, changedStems, hops = 2) {
  const importers = new Map(); // stem -> Set<file>
  for (const [f, info] of idx) {
    for (const imp of info.imports) {
      const tail = importStemTail(imp);
      if (!importers.has(tail)) importers.set(tail, new Set());
      importers.get(tail).add(f);
    }
  }
  const reached = new Map();
  let frontier = new Set(changedStems);
  for (let hop = 1; hop <= hops; hop++) {
    const next = new Set();
    for (const stem of frontier) {
      for (const f of importers.get(stem) || []) {
        const st = path.basename(f).replace(/\.[^.]+$/, "");
        if (!reached.has(f) && !changedStems.has(st)) { reached.set(f, hop); next.add(st); }
      }
    }
    frontier = next;
    if (!frontier.size) break;
  }
  return reached;
}

function symbolUsage(idx, symbol, defFiles) {
  const sites = [];
  for (const [f, info] of idx) {
    if (defFiles.has(f)) continue;
    if (info.refs.has(symbol)) sites.push(f);
  }
  return sites;
}

function resourceUsage(idx, noun) {
  const low = noun.toLowerCase();
  const cat = { destroy: [], create: [], read: [] };
  const seen = new Set();
  for (const [f, info] of idx) {
    for (const c of info.calls) {
      const cl = c.name.toLowerCase();
      if (!cl.includes(low)) continue;
      const key = f + "::" + c.name;
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = DESTROY.some(v => cl.includes(v)) ? "destroy"
        : CREATE.some(v => cl.includes(v)) ? "create"
        : READ.some(v => cl.includes(v)) ? "read" : null;
      if (bucket) cat[bucket].push({ file: f, line: c.line, callee: c.name });
    }
  }
  return cat;
}

// derive candidate resource nouns from changed symbol names (camelCase nouns >3 chars)
function deriveNouns(symbols) {
  const nouns = new Set();
  for (const s of symbols) {
    for (const part of s.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z]+/)) {
      const w = part.toLowerCase();
      if (w.length > 4 && !["service", "handler", "event", "listener", "factory", "config"].includes(w)) nouns.add(w);
    }
  }
  return [...nouns];
}

function rel(root, f) { return path.relative(root, f); }

async function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(args[0]);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const scope = opt("--scope");
  const base = opt("--base");
  const changedArg = opt("--changed");
  const seedSymbol = opt("--seed-symbol");
  const resourceArg = opt("--resource");
  const asJson = args.includes("--json");
  const cap = 20;

  // 1. changed files
  let changed = [];
  if (changedArg) changed = changedArg.split(",").map(s => s.trim());
  else if (base) {
    const out = execSync(`git -C ${JSON.stringify(root)} diff ${base}...HEAD --name-only`, { encoding: "utf8" });
    changed = out.split("\n").filter(Boolean);
  }
  changed = changed.filter(f => EXT_LANG[path.extname(f)]);
  const changedAbs = new Set(changed.map(f => path.resolve(root, f)));

  // 2. index the scope
  const scopeRoot = scope ? path.join(root, scope) : root;
  const files = walkFiles(scopeRoot);
  const idx = await buildIndex(files);

  // 3. changed symbols = top-level defs in changed files (or explicit seed)
  const changedSymbols = new Set();
  const defFiles = new Set();
  if (seedSymbol) {
    changedSymbols.add(seedSymbol);
    for (const [f, info] of idx) if (info.defs.includes(seedSymbol)) defFiles.add(f);
  } else {
    for (const f of changedAbs) {
      const info = idx.get(f);
      if (info) { info.defs.forEach(d => changedSymbols.add(d)); defFiles.add(f); }
    }
  }

  // 4. import blast radius (off-diff)
  const stems = new Set([...defFiles].map(f => path.basename(f).replace(/\.[^.]+$/, "")));
  for (const f of changedAbs) stems.add(path.basename(f).replace(/\.[^.]+$/, ""));
  const br = [...importBlastRadius(idx, stems).entries()]
    .filter(([f]) => !changedAbs.has(f))
    .sort((a, b) => a[1] - b[1]).slice(0, cap);

  // 5. symbol usage (off-diff)
  const usage = {};
  for (const s of changedSymbols) {
    const sites = symbolUsage(idx, s, defFiles).filter(f => !changedAbs.has(f));
    if (sites.length) usage[s] = sites.slice(0, cap);
  }

  // 6. resource read/destroy
  const nouns = resourceArg ? [resourceArg] : deriveNouns([...changedSymbols]);
  const resources = {};
  for (const n of nouns) {
    const ru = resourceUsage(idx, n);
    // only interesting when the change READS it AND something else DESTROYS it
    const readsInChanged = ru.read.some(x => changedAbs.has(x.file)) || ru.create.some(x => changedAbs.has(x.file));
    if (ru.destroy.length && (readsInChanged || ru.read.length)) {
      resources[n] = {
        destroy: ru.destroy.filter(x => !changedAbs.has(x.file)).slice(0, cap),
        readInChange: ru.read.filter(x => changedAbs.has(x.file)).slice(0, 5),
      };
    }
  }

  const report = {
    changedFiles: changed,
    changedSymbols: [...changedSymbols],
    importBlastRadius: br.map(([f, h]) => ({ file: rel(root, f), hop: h })),
    symbolUsage: Object.fromEntries(Object.entries(usage).map(([s, fs_]) => [s, fs_.map(f => rel(root, f))])),
    resourceHazards: Object.fromEntries(Object.entries(resources).map(([n, v]) => [n, {
      destroyedBy: v.destroy.map(x => `${rel(root, x.file)}:${x.line} (${x.callee})`),
      readInChange: v.readInChange.map(x => `${rel(root, x.file)}:${x.line} (${x.callee})`),
    }])),
  };

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }

  // markdown MUST-CHECK
  const L = [];
  L.push(`## STATIC BLAST-RADIUS — MUST CHECK (deterministic; no LLM)`);
  L.push(`Changed symbols: ${report.changedSymbols.join(", ") || "(none extracted)"}\n`);
  L.push(`### Off-diff files that depend on changed symbols (import graph ≤2 hops)`);
  if (report.importBlastRadius.length) report.importBlastRadius.forEach(x => L.push(`- h${x.hop}  ${x.file}`));
  else L.push(`- (none via import edges)`);
  L.push(`\n### Direct symbol references (off-diff)`);
  const su = Object.entries(report.symbolUsage);
  if (su.length) su.forEach(([s, fs_]) => L.push(`- \`${s}\` → ${fs_.join(", ")}`));
  else L.push(`- (none)`);
  L.push(`\n### Resource lifecycle — read here, destroyed elsewhere`);
  const rh = Object.entries(report.resourceHazards);
  if (rh.length) rh.forEach(([n, v]) => {
    L.push(`- resource \`${n}\`:`);
    v.readInChange.forEach(x => L.push(`    READ (in change):  ${x}`));
    v.destroyedBy.forEach(x => L.push(`    DESTROY elsewhere: ${x}`));
  });
  else L.push(`- (no read-here/destroy-elsewhere resource pairs found)`);
  L.push(`\n> Any file/pair above that your review does not account for = incomplete cross-file/resource analysis.`);
  console.log(L.join("\n"));
}

main().catch(e => { console.error("blast-radius error:", e.message); process.exit(1); });
