"use strict";

const TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "interface",
  "struct",
  "enum",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "function",
  "method",
];

const TOKEN_MODIFIERS = ["declaration", "readonly", "static", "defaultLibrary"];

const DECL = 1 << TOKEN_MODIFIERS.indexOf("declaration");
const READONLY = 1 << TOKEN_MODIFIERS.indexOf("readonly");
const STATIC = 1 << TOKEN_MODIFIERS.indexOf("static");
const DEFAULT_LIBRARY = 1 << TOKEN_MODIFIERS.indexOf("defaultLibrary");

const TYPE_KINDS = new Set(["class", "interface", "struct", "enum"]);

const HARD_KEYWORDS = new Set([
  "package", "import", "from", "as", "fn", "class", "extends", "implements",
  "interface", "new", "self", "public", "protected", "private", "internal",
  "if", "else", "while", "for", "break", "continue", "return", "yield",
  "throw", "try", "catch", "finally", "switch", "case", "default", "typedef",
  "type",
  "struct", "and", "or", "not", "is", "in", "true", "false", "sizeof", "int",
  "float", "bool", "str", "null", "void", "super", "exception", "export",
]);

const PRIMITIVES = new Set(["int", "float", "bool", "str", "void", "any"]);
const GENERIC_TYPE_NAMES = new Set(["list", "dict", "set", "tuple", "frozenset"]);
const ACCESS_MODIFIERS = new Set(["public", "protected", "private", "internal"]);

const BUILTIN_TYPE_NAMES = [
  "Exception", "ArithmeticError", "ZeroDivisionError", "OverflowError",
  "ValueError", "TypeError", "NameError", "AttributeError", "KeyError",
  "IndexError", "RuntimeError", "NullPointerError", "LookupError",
  "AssertionError", "OSError", "EOFError", "IOException", "ImportError",
  "ModuleNotFoundError", "RecursionError", "NumberFormatError",
  "NotImplementedError", "StopIteration", "NoSuchElementError", "RegexError",
  "Scanner", "Files",
];
const BUILTIN_TYPES = new Map(BUILTIN_TYPE_NAMES.map((name) => [name, "class"]));

const BUILTIN_FUNCTIONS = new Set([
  "memset", "len", "list", "tuple", "dict", "set", "frozenset", "range", "next",
  "typeName", "repr", "chr", "ord", "abs", "sum", "min", "max", "all", "any",
  "zip", "enumerate", "sorted", "round", "input", "print", "println",
]);

const MULTI_OPS = [
  "**=", "//=", "!=", "%=", "**", "*=", "++", "+=", "--", "-=", "->", "..",
  "//", "/=", "<=", "==", "=>", ">=", "?.", "??", "|>",
];

const SINGLE_PUNCT = new Set([
  "(", ")", "{", "}", "[", "]", ",", ";", ":", ".", "?", "@", "+", "-", "*",
  "/", "%", "<", ">", "=", "|", "&", "!",
]);

const IDENT_RE = /[\p{L}_][\p{L}\p{N}\p{M}_]*/uy;
const NUMBER_RE = /[0-9]+(?:\.[0-9]+)?/y;

function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f";
}

function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  let line = 0;
  let col = 0;

  function advanceTo(end) {
    const stop = end > n ? n : end;
    while (i < stop) {
      if (text.charCodeAt(i) === 10) {
        line++;
        col = 0;
      } else {
        col++;
      }
      i++;
    }
  }

  function push(kind, start, end, startLine, startCol) {
    tokens.push({
      kind,
      text: text.slice(start, end),
      line: startLine,
      start: startCol,
      length: end - start,
    });
  }

  while (i < n) {
    const ch = text[i];

    if (isWhitespace(ch)) {
      let j = i + 1;
      while (j < n && isWhitespace(text[j])) j++;
      advanceTo(j);
      continue;
    }

    if (ch === "#") {
      let j = text.indexOf("\n", i + 1);
      advanceTo(j < 0 ? n : j);
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      advanceTo(close < 0 ? n : close + 2);
      continue;
    }

    if (ch === "\"" || ch === "'") {
      let j = i + 1;
      while (j < n) {
        const c = text[j];
        if (c === "\n") break;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === ch) {
          j++;
          break;
        }
        j++;
      }
      advanceTo(j);
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(text);
      if (m) {
        push("number", i, i + m[0].length, line, col);
        advanceTo(i + m[0].length);
        continue;
      }
    }

    IDENT_RE.lastIndex = i;
    const ident = IDENT_RE.exec(text);
    if (ident) {
      push("ident", i, i + ident[0].length, line, col);
      advanceTo(i + ident[0].length);
      continue;
    }

    let matched = null;
    for (const op of MULTI_OPS) {
      if (text.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      push("op", i, i + matched.length, line, col);
      advanceTo(i + matched.length);
      continue;
    }

    if (SINGLE_PUNCT.has(ch)) {
      push("punct", i, i + 1, line, col);
      advanceTo(i + 1);
      continue;
    }

    advanceTo(i + 1);
  }

  return tokens;
}

function createContext(sig) {
  return {
    sig,
    types: new Map(),
    functions: new Set(),
    enumMembers: new Map(),
    members: new Map(),
    namespaces: new Set(),
    globals: new Map(),
    scopes: [],
    pending: null,
    activeTypeParams: null,
    out: [],
    classified: new Set(),
    definitionIndexes: new Set(),
    refTargets: new Map(),
    typeDeclarations: new Map(),
    functionDeclarations: new Map(),
    importAliases: new Set(),
    tokenOwners: new Map(),
  };
}

function textAt(ctx, i) {
  return ctx.sig[i] ? ctx.sig[i].text : undefined;
}

function isIdent(ctx, i) {
  return Boolean(ctx.sig[i]) && ctx.sig[i].kind === "ident";
}

function isName(ctx, i) {
  return isIdent(ctx, i) && !HARD_KEYWORDS.has(ctx.sig[i].text);
}

function typeKindFor(ctx, name) {
  if (ctx.activeTypeParams && ctx.activeTypeParams.has(name)) return "typeParameter";
  const symbol = lookup(ctx, name);
  if (symbol && symbol.tokenType === "typeParameter") return "typeParameter";
  return ctx.types.get(name) || (BUILTIN_TYPES.has(name) ? "class" : "type");
}

function matchBracket(ctx, open) {
  const openChar = textAt(ctx, open);
  const closeChar = openChar === "(" ? ")" : openChar === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < ctx.sig.length; i++) {
    const s = textAt(ctx, i);
    if (s === openChar) depth++;
    else if (s === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findBodyBrace(ctx, start) {
  let parens = 0;
  let brackets = 0;
  for (let i = start; i < ctx.sig.length; i++) {
    const s = textAt(ctx, i);
    if (s === "(") parens++;
    else if (s === ")") {
      if (parens > 0) parens--;
    } else if (s === "[") brackets++;
    else if (s === "]") {
      if (brackets > 0) brackets--;
    } else if (parens === 0 && brackets === 0) {
      if (s === "{") return i;
      if (s === ";" || s === "}") return -1;
    }
  }
  return -1;
}

function skipSeparators(ctx, start, stops) {
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let i = start; i < ctx.sig.length; i++) {
    const s = textAt(ctx, i);
    if (s === "(") parens++;
    else if (s === ")") {
      if (parens > 0) parens--;
      else if (stops.has(")")) return i;
    } else if (s === "[") brackets++;
    else if (s === "]") {
      if (brackets > 0) brackets--;
    } else if (s === "{") braces++;
    else if (s === "}") {
      if (braces > 0) braces--;
      else if (stops.has("}")) return i;
    }
    if (parens === 0 && brackets === 0 && braces === 0 && stops.has(s)) return i;
  }
  return ctx.sig.length;
}

function parseTypeArgs(ctx, i, depth) {
  if (depth > 24 || textAt(ctx, i) !== "<") return null;
  let j = i + 1;
  const refs = [];
  let suspicious = false;
  for (;;) {
    const ty = parseType(ctx, j, depth + 1);
    if (!ty) return null;
    refs.push(...ty.refs);
    suspicious = suspicious || ty.suspicious;
    j = ty.end;
    if (textAt(ctx, j) === ",") {
      j++;
      continue;
    }
    if (textAt(ctx, j) === ">") {
      return { end: j + 1, refs, suspicious };
    }
    return null;
  }
}

function parseFunctionType(ctx, i, depth) {
  if (depth > 24 || textAt(ctx, i) !== "fn" || textAt(ctx, i + 1) !== "(") {
    return null;
  }
  let j = i + 2;
  const refs = [];
  let suspicious = false;
  if (textAt(ctx, j) !== ")") {
    for (;;) {
      const ty = parseType(ctx, j, depth + 1);
      if (!ty) return null;
      refs.push(...ty.refs);
      suspicious = suspicious || ty.suspicious;
      j = ty.end;
      if (textAt(ctx, j) === ",") {
        j++;
        continue;
      }
      break;
    }
  }
  if (textAt(ctx, j) !== ")") return null;
  j++;
  if (textAt(ctx, j) !== "->") return null;
  j++;
  if (textAt(ctx, j) === "void") {
    j++;
  } else {
    const ret = parseType(ctx, j, depth + 1);
    if (!ret) return null;
    refs.push(...ret.refs);
    suspicious = suspicious || ret.suspicious;
    j = ret.end;
  }
  return { end: j, refs, suspicious };
}

function parseTypeArm(ctx, i, depth) {
  if (depth > 24) return null;
  let j = i;
  const refs = [];
  let suspicious = false;
  let baseKnown = true;

  const s = textAt(ctx, j);
  if (s === "struct") {
    if (!isName(ctx, j + 1)) return null;
    refs.push({ index: j + 1, kind: "struct" });
    j += 2;
  } else if (s === "fn" && textAt(ctx, j + 1) === "(") {
    const fn = parseFunctionType(ctx, j, depth + 1);
    if (!fn) return null;
    refs.push(...fn.refs);
    suspicious = fn.suspicious;
    j = fn.end;
  } else if (isIdent(ctx, j)) {
    if (PRIMITIVES.has(s) || s === "var" || s === "null") {
      j++;
    } else if (HARD_KEYWORDS.has(s)) {
      return null;
    } else {
      baseKnown =
        ctx.types.has(s) ||
        BUILTIN_TYPES.has(s) ||
        GENERIC_TYPE_NAMES.has(s) ||
        /^[A-Z]/.test(s);
      let kind = typeKindFor(ctx, s);
      let target = null;
      if (ctx.activeTypeParams && ctx.activeTypeParams.has(s)) {
        kind = "typeParameter";
        const param = ctx.activeTypeParams.get(s);
        if (param && param.declIndex !== undefined) target = param.declIndex;
      } else if (ctx.typeDeclarations.has(s)) {
        target = ctx.typeDeclarations.get(s);
      }
      refs.push({ index: j, kind, target });
      j++;
      const args = parseTypeArgs(ctx, j, depth + 1);
      if (args) {
        refs.push(...args.refs);
        suspicious = suspicious || args.suspicious;
        j = args.end;
      }
    }
  } else {
    return null;
  }

  let pointed = false;
  while (textAt(ctx, j) === "*" || textAt(ctx, j) === "**") {
    pointed = true;
    j++;
  }
  if (textAt(ctx, j) === "?") j++;

  return { end: j, refs, suspicious: suspicious || (!baseKnown && pointed) };
}

function parseType(ctx, i, depth) {
  if (depth > 24) return null;
  const first = parseTypeArm(ctx, i, depth + 1);
  if (!first) return null;
  let j = first.end;
  const refs = first.refs.slice();
  let suspicious = first.suspicious;
  while (textAt(ctx, j) === "|") {
    const arm = parseTypeArm(ctx, j + 1, depth + 1);
    if (!arm) break;
    refs.push(...arm.refs);
    suspicious = suspicious || arm.suspicious;
    j = arm.end;
  }
  return { end: j, refs, suspicious };
}

function emit(ctx, index, type, modifiers) {
  if (ctx.classified.has(index) || !ctx.sig[index]) return;
  ctx.classified.add(index);
  const mods = modifiers || 0;
  if (mods & DECL) ctx.definitionIndexes.add(index);
  ctx.out.push({ index, type, modifiers: mods });
}

function emitRefs(ctx, refs) {
  if (!refs) return;
  for (const ref of refs) {
    if (!ctx.classified.has(ref.index)) {
      emit(ctx, ref.index, ref.kind, 0);
    }
    if (ref.target !== undefined && ref.target !== null) {
      ctx.refTargets.set(ref.index, ref.target);
    }
  }
}

function extractTypeName(ctx, refs) {
  if (!refs) return null;
  for (const ref of refs) {
    const source = ctx.sig[ref.index];
    if (!source) continue;
    if (ref.kind === "typeParameter" || GENERIC_TYPE_NAMES.has(source.text)) continue;
    return source.text;
  }
  return null;
}

function addSymbol(frame, name, symbol) {
  frame.symbols.set(name, symbol);
}

function registerMember(ctx, frame, name, info) {
  if (!frame || !TYPE_KINDS.has(frame.kind) || !frame.members) return;
  frame.members.set(name, info);
  if (frame.name) {
    if (!ctx.members.has(frame.name)) ctx.members.set(frame.name, new Map());
    ctx.members.get(frame.name).set(name, info);
  }
}

function modifiersBefore(ctx, i) {
  let staticModifier = false;
  let extern = false;
  for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
    const s = textAt(ctx, k);
    if (s === "static") staticModifier = true;
    else if (s === "extern") extern = true;
    else if (s === "export" || s === "const" || ACCESS_MODIFIERS.has(s)) {
      continue;
    } else {
      break;
    }
  }
  return { staticModifier, extern };
}

function collectEnumMemberNames(ctx, enumName, body) {
  const close = matchBracket(ctx, body);
  if (close < 0) return;
  const members = ctx.enumMembers.get(enumName) || new Set();
  let i = body + 1;
  let atStart = true;
  while (i < close) {
    const s = textAt(ctx, i);
    if (s === ";") break;
    if (s === ",") {
      atStart = true;
      i++;
      continue;
    }
    if (atStart && isName(ctx, i)) {
      members.add(ctx.sig[i].text);
      atStart = false;
      i++;
      if (textAt(ctx, i) === "(") i = matchBracket(ctx, i) + 1;
      if (textAt(ctx, i) === "=") {
        i = skipSeparators(ctx, i + 1, new Set([",", "}"]));
      }
      continue;
    }
    if (s === "(" || s === "[" || s === "{") {
      const end = matchBracket(ctx, i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    i++;
  }
  ctx.enumMembers.set(enumName, members);
}

function collectDeclarations(ctx) {
  const len = ctx.sig.length;
  for (let i = 0; i < len; i++) {
    const s = textAt(ctx, i);

    if (s === "typedef" && textAt(ctx, i + 1) === "struct" && isName(ctx, i + 2)) {
      const tag = ctx.sig[i + 2].text;
      ctx.types.set(tag, "struct");
      ctx.typeDeclarations.set(tag, i + 2);
      const body = findBodyBrace(ctx, i + 3);
      if (body >= 0) {
        const close = matchBracket(ctx, body);
        if (close >= 0 && isName(ctx, close + 1) && textAt(ctx, close + 2) === ";") {
          ctx.types.set(ctx.sig[close + 1].text, "struct");
          ctx.typeDeclarations.set(ctx.sig[close + 1].text, close + 1);
        }
      }
      continue;
    }

    if (s === "typedef" && isName(ctx, i + 1)) {
      const underlying = parseType(ctx, i + 2, 0);
      if (underlying && textAt(ctx, underlying.end) === ";") {
        const name = ctx.sig[i + 1].text;
        ctx.types.set(name, "type");
        ctx.typeDeclarations.set(name, i + 1);
        continue;
      }
    }

    if (
      s === "type" &&
      textAt(ctx, i - 1) === "export" &&
      isName(ctx, i + 1) &&
      textAt(ctx, i + 2) === ";"
    ) {
      const name = ctx.sig[i + 1].text;
      ctx.types.set(name, "type");
      ctx.typeDeclarations.set(name, i + 1);
      continue;
    }

    if (s === "class" || s === "interface" || s === "struct" || s === "enum") {
      if (!isName(ctx, i + 1)) continue;
      const name = ctx.sig[i + 1].text;
      const body = findBodyBrace(ctx, i + 2);
      if (body < 0) continue;
      ctx.types.set(name, s);
      ctx.typeDeclarations.set(name, i + 1);
      if (s === "enum") collectEnumMemberNames(ctx, name, body);
      continue;
    }

    if (s === "exception" && isName(ctx, i + 1)) {
      ctx.types.set(ctx.sig[i + 1].text, "class");
      ctx.typeDeclarations.set(ctx.sig[i + 1].text, i + 1);
      continue;
    }

    if (s === "fn" && isName(ctx, i + 1)) {
      ctx.functions.add(ctx.sig[i + 1].text);
      if (!ctx.functionDeclarations.has(ctx.sig[i + 1].text)) {
        ctx.functionDeclarations.set(ctx.sig[i + 1].text, i + 1);
      }
    }
  }
}

function currentScope(ctx) {
  return ctx.scopes[ctx.scopes.length - 1];
}

function lookup(ctx, name) {
  for (let i = ctx.scopes.length - 1; i >= 0; i--) {
    const frame = ctx.scopes[i];
    if (frame.symbols && frame.symbols.has(name)) return frame.symbols.get(name);
    if (frame.members && frame.members.has(name)) return frame.members.get(name);
  }
  return null;
}

function parseTypeParameters(ctx, i) {
  const result = { end: i, symbols: new Map(), refs: [] };
  if (textAt(ctx, i) !== "<") return result;

  let depth = 0;
  let j = i;
  for (; j < ctx.sig.length; j++) {
    const s = textAt(ctx, j);
    if (s === "<") {
      depth++;
      continue;
    }
    if (s === ">") {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
      continue;
    }
    if (depth !== 1) continue;
    if (s === "extends") {
      const ty = parseType(ctx, j + 1, 0);
      if (ty) {
        result.refs.push(...ty.refs);
        j = ty.end - 1;
      }
      continue;
    }
    if (
      isName(ctx, j) &&
      (textAt(ctx, j - 1) === "<" || textAt(ctx, j - 1) === ",")
    ) {
      emit(ctx, j, "typeParameter", DECL);
      result.symbols.set(ctx.sig[j].text, {
        tokenType: "typeParameter",
        mods: 0,
        declIndex: j,
      });
    }
  }
  result.end = j;
  return result;
}

function parseParameters(ctx, open) {
  if (textAt(ctx, open) !== "(") return null;
  const close = matchBracket(ctx, open);
  if (close < 0) return null;

  const params = [];
  const paramTypes = new Map();
  const refs = [];
  let i = open + 1;
  let atStart = true;

  while (i < close) {
    const s = textAt(ctx, i);
    if (s === ",") {
      atStart = true;
      i++;
      continue;
    }
    if (!atStart) {
      if (s === "=") {
        i = skipSeparators(ctx, i + 1, new Set([",", ")"]));
        atStart = true;
        continue;
      }
      if (s === "(" || s === "[" || s === "{") {
        const end = matchBracket(ctx, i);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      i++;
      continue;
    }

    if (s === "vararg" || s === "varkwarg") i++;

    const ty = parseType(ctx, i, 0);
    if (!ty) {
      i++;
      continue;
    }
    refs.push(...ty.refs);
    const typeName = extractTypeName(ctx, ty.refs);
    i = ty.end;

    if (isName(ctx, i)) {
      params.push(i);
      if (typeName) paramTypes.set(i, typeName);
      i++;
    }
    atStart = false;
  }

  return { end: close + 1, params, paramTypes, refs };
}

function emitParameters(ctx, parsed) {
  if (!parsed) return new Map();
  emitRefs(ctx, parsed.refs);
  const symbols = new Map();
  for (const index of parsed.params) {
    emit(ctx, index, "parameter", DECL);
    const symbol = { tokenType: "parameter", mods: DECL, declIndex: index };
    const typeName = parsed.paramTypes ? parsed.paramTypes.get(index) : null;
    if (typeName) symbol.typeName = typeName;
    symbols.set(ctx.sig[index].text, symbol);
  }
  return symbols;
}

function tryDeclaration(ctx, i) {
  let j = i;
  let readonly = false;
  let staticModifier = false;
  for (;;) {
    const s = textAt(ctx, j);
    if (s === "const") {
      readonly = true;
      j++;
      continue;
    }
    if (s === "static") {
      staticModifier = true;
      j++;
      continue;
    }
    if (ACCESS_MODIFIERS.has(s) || s === "export" || s === "extern") {
      j++;
      continue;
    }
    break;
  }

  const ty = parseType(ctx, j, 0);
  if (!ty || ty.suspicious) return null;
  const typeName = extractTypeName(ctx, ty.refs);

  let k = ty.end;
  if (textAt(ctx, k) === "(") {
    const close = matchBracket(ctx, k);
    if (close < 0 || textAt(ctx, close + 1) !== "=") return null;
    const names = [];
    for (let p = k + 1; p < close; p++) {
      if (isName(ctx, p) && (textAt(ctx, p - 1) === "(" || textAt(ctx, p - 1) === ",")) {
        names.push(p);
      }
    }
    if (names.length === 0) return null;
    return {
      kind: "destructure",
      refs: ty.refs,
      names,
      typeName,
      end: close + 2,
      readonly,
      staticModifier,
    };
  }

  if (!isName(ctx, k)) return null;
  const after = textAt(ctx, k + 1);
  if (
    after !== "=" &&
    after !== ";" &&
    after !== "," &&
    after !== ")" &&
    after !== "in" &&
    after !== undefined
  ) {
    return null;
  }

  return {
    kind: "decl",
    refs: ty.refs,
    nameIndex: k,
    typeName,
    end: k + 1,
    readonly,
    staticModifier,
  };
}

function handleDeclaration(ctx, decl) {
  emitRefs(ctx, decl.refs);
  const frame = currentScope(ctx);

  const baseMods = DECL | (decl.readonly ? READONLY : 0) | (decl.staticModifier ? STATIC : 0);

  if (decl.kind === "destructure") {
    for (const index of decl.names) {
      emit(ctx, index, "variable", baseMods);
      const symbol = { tokenType: "variable", mods: baseMods, declIndex: index };
      if (decl.typeName) symbol.typeName = decl.typeName;
      addSymbol(frame, ctx.sig[index].text, symbol);
    }
    return;
  }

  const index = decl.nameIndex;
  const name = ctx.sig[index].text;
  if (TYPE_KINDS.has(frame.kind)) {
    emit(ctx, index, "property", baseMods);
    if (frame.name) ctx.tokenOwners.set(index, frame.name);
    const member = { tokenType: "property", mods: baseMods, declIndex: index };
    if (decl.typeName) member.typeName = decl.typeName;
    registerMember(ctx, frame, name, member);
  } else {
    emit(ctx, index, "variable", baseMods);
    const symbol = { tokenType: "variable", mods: baseMods, declIndex: index };
    if (decl.typeName) symbol.typeName = decl.typeName;
    addSymbol(frame, name, symbol);
    if (frame.kind === "file") {
      ctx.globals.set(name, symbol);
    }
  }
}

function handlePackage(ctx, i) {
  let j = i + 1;
  while (j < ctx.sig.length) {
    if (isName(ctx, j)) {
      emit(ctx, j, "namespace", 0);
      ctx.namespaces.add(ctx.sig[j].text);
      j++;
    } else if (textAt(ctx, j) === ".") {
      j++;
    } else {
      break;
    }
  }
  return j;
}

function handleImport(ctx, i) {
  let j = i + 1;
  while (j < ctx.sig.length) {
    if (isName(ctx, j)) {
      emit(ctx, j, "namespace", 0);
      ctx.namespaces.add(ctx.sig[j].text);
      j++;
    } else if (textAt(ctx, j) === ".") {
      j++;
    } else {
      break;
    }
  }
  if (textAt(ctx, j) === "as" && isName(ctx, j + 1)) {
    emit(ctx, j + 1, "namespace", DECL);
    ctx.namespaces.add(ctx.sig[j + 1].text);
    ctx.importAliases.add(j + 1);
    j += 2;
  }
  while (j < ctx.sig.length && textAt(ctx, j) !== ";") j++;
  return j < ctx.sig.length ? j + 1 : j;
}

function handleFromImport(ctx, i) {
  let j = i + 1;
  while (j < ctx.sig.length && textAt(ctx, j) !== "import") {
    if (isName(ctx, j)) {
      emit(ctx, j, "namespace", 0);
      ctx.namespaces.add(ctx.sig[j].text);
    }
    j++;
  }
  if (textAt(ctx, j) === "import") j++;

  while (j < ctx.sig.length) {
    const s = textAt(ctx, j);
    if (s === ";") return j + 1;
    if (s === ",") {
      j++;
      continue;
    }
    if (isName(ctx, j)) {
      if (ctx.types.has(s)) emit(ctx, j, ctx.types.get(s), 0);
      j++;
      if (textAt(ctx, j) === "as" && isName(ctx, j + 1)) {
        emit(ctx, j + 1, "namespace", DECL);
        ctx.namespaces.add(ctx.sig[j + 1].text);
        ctx.importAliases.add(j + 1);
        j += 2;
      }
      continue;
    }
    j++;
  }
  return j;
}

function handleTypeDeclaration(ctx, i, kind) {
  const nameIndex = i + 1;
  const name = ctx.sig[nameIndex].text;
  const body = findBodyBrace(ctx, i + 2);
  if (body < 0) return i + 1;

  emit(ctx, nameIndex, kind, DECL);
  ctx.types.set(name, kind);

  const symbols = new Map();
  let j = nameIndex + 1;

  if (textAt(ctx, j) === "<") {
    const tp = parseTypeParameters(ctx, j);
    emitRefs(ctx, tp.refs);
    for (const [key, value] of tp.symbols) symbols.set(key, value);
    j = tp.end;
  }

  const previousTypeParams = ctx.activeTypeParams;
  ctx.activeTypeParams = symbols;
  while (j < body) {
    const s = textAt(ctx, j);
    if (s === "extends" || s === "implements") {
      j++;
      while (j < body && textAt(ctx, j) !== "extends" && textAt(ctx, j) !== "implements") {
        if (textAt(ctx, j) === ",") {
          j++;
          continue;
        }
        const ty = parseType(ctx, j, 0);
        if (!ty) {
          j++;
          continue;
        }
        emitRefs(ctx, ty.refs);
        j = ty.end;
      }
      continue;
    }
    j++;
  }
  ctx.activeTypeParams = previousTypeParams;

  ctx.pending = {
    kind,
    name,
    symbols,
    members: new Map(),
    memberPhase: kind === "enum",
    constructorNames: [name],
    typedefAliasIndex: -1,
  };
  return body;
}

function handleTypedefStruct(ctx, i) {
  const tagIndex = i + 2;
  if (!isName(ctx, tagIndex)) return i + 1;
  const tag = ctx.sig[tagIndex].text;
  const body = findBodyBrace(ctx, i + 3);
  if (body < 0) {
    emit(ctx, tagIndex, "struct", DECL);
    return i + 3;
  }

  emit(ctx, tagIndex, "struct", DECL);
  ctx.types.set(tag, "struct");

  const close = matchBracket(ctx, body);
  let aliasIndex = -1;
  let aliasName = null;
  if (close >= 0 && isName(ctx, close + 1) && textAt(ctx, close + 2) === ";") {
    aliasIndex = close + 1;
    aliasName = ctx.sig[aliasIndex].text;
    ctx.types.set(aliasName, "struct");
  }

  ctx.pending = {
    kind: "struct",
    name: tag,
    symbols: new Map(),
    members: new Map(),
    memberPhase: false,
    constructorNames: aliasName ? [tag, aliasName] : [tag],
    typedefAliasIndex: aliasIndex,
  };
  return body;
}

function handleTypeAlias(ctx, i) {
  const nameIndex = i + 1;
  const underlying = parseType(ctx, i + 2, 0);
  if (!isName(ctx, nameIndex) || !underlying || textAt(ctx, underlying.end) !== ";") {
    return i + 1;
  }

  emit(ctx, nameIndex, "type", DECL);
  ctx.types.set(ctx.sig[nameIndex].text, "type");
  emitRefs(ctx, underlying.refs);
  return underlying.end + 1;
}

function handleForwardType(ctx, i) {
  const nameIndex = i + 1;
  if (
    textAt(ctx, i - 1) !== "export" ||
    !isName(ctx, nameIndex) ||
    textAt(ctx, i + 2) !== ";"
  ) {
    return i + 1;
  }

  const name = ctx.sig[nameIndex].text;
  emit(ctx, nameIndex, "type", DECL);
  ctx.types.set(name, "type");
  return i + 3;
}

function handleException(ctx, i) {
  const nameIndex = i + 1;
  if (!isName(ctx, nameIndex)) return i + 1;
  emit(ctx, nameIndex, "class", DECL);
  ctx.types.set(ctx.sig[nameIndex].text, "class");
  return nameIndex + 1;
}

function handleFunction(ctx, i) {
  const nameIndex = i + 1;
  if (!isName(ctx, nameIndex)) return i + 1;
  const frame = currentScope(ctx);
  const isMethod = TYPE_KINDS.has(frame.kind);
  const flags = modifiersBefore(ctx, i);
  let mods = DECL;
  if (flags.staticModifier) mods |= STATIC;
  if (flags.extern) mods |= DEFAULT_LIBRARY;

  emit(ctx, nameIndex, isMethod ? "method" : "function", mods);
  const name = ctx.sig[nameIndex].text;
  if (isMethod) {
    if (frame.name) ctx.tokenOwners.set(nameIndex, frame.name);
    registerMember(ctx, frame, name, {
      tokenType: "method",
      mods,
      declIndex: nameIndex,
    });
  }
  ctx.functions.add(name);

  let j = nameIndex + 1;
  const symbols = new Map();
  const typeParams = new Map();
  if (textAt(ctx, j) === "<") {
    const tp = parseTypeParameters(ctx, j);
    emitRefs(ctx, tp.refs);
    for (const [key, value] of tp.symbols) {
      symbols.set(key, value);
      typeParams.set(key, value);
    }
    j = tp.end;
  }

  const previousTypeParams = ctx.activeTypeParams;
  ctx.activeTypeParams = typeParams;
  const params = parseParameters(ctx, j);
  if (params) {
    const paramSymbols = emitParameters(ctx, params);
    for (const [key, value] of paramSymbols) symbols.set(key, value);
    j = params.end;
  }

  if (textAt(ctx, j) === "->") {
    const ret = parseType(ctx, j + 1, 0);
    if (ret) {
      emitRefs(ctx, ret.refs);
      j = ret.end;
    }
  }
  ctx.activeTypeParams = previousTypeParams;

  while (j < ctx.sig.length) {
    const s = textAt(ctx, j);
    if (s === "{") {
      ctx.pending = { kind: "function", name, symbols, members: null };
      return j;
    }
    if (s === ";" || s === "}") return j + 1;
    j++;
  }
  return j;
}

function handleConstructor(ctx, i) {
  const frame = currentScope(ctx);
  if (!TYPE_KINDS.has(frame.kind)) return i + 1;

  const params = parseParameters(ctx, i + 1);
  const symbols = params ? emitParameters(ctx, params) : new Map();
  let j = params ? params.end : i + 1;

  if (params) {
    registerMember(ctx, frame, "constructor", {
      tokenType: "method",
      mods: DECL,
      declIndex: i,
    });
  }

  while (j < ctx.sig.length) {
    const s = textAt(ctx, j);
    if (s === "{") {
      ctx.pending = { kind: "function", name: "constructor", symbols, members: null };
      return j;
    }
    if (s === ";" || s === "}") return j + 1;
    j++;
  }
  return j;
}

function handleAccessor(ctx, i) {
  const frame = currentScope(ctx);
  if (!TYPE_KINDS.has(frame.kind)) return i + 1;
  const kind = textAt(ctx, i);
  const nameIndex = i + 1;
  if (!isName(ctx, nameIndex)) return i + 1;

  emit(ctx, nameIndex, "method", DECL);
  if (frame.name) ctx.tokenOwners.set(nameIndex, frame.name);
  registerMember(ctx, frame, ctx.sig[nameIndex].text, {
    tokenType: "method",
    mods: DECL,
    declIndex: nameIndex,
  });

  let symbols = new Map();
  let j = nameIndex + 1;
  if (kind === "setter" && textAt(ctx, j) === "(") {
    const params = parseParameters(ctx, j);
    if (params) {
      symbols = emitParameters(ctx, params);
      j = params.end;
    }
  }

  while (j < ctx.sig.length) {
    const s = textAt(ctx, j);
    if (s === "{") {
      ctx.pending = { kind: "function", name: kind, symbols, members: null };
      return j;
    }
    if (s === "}" || s === ";") return j + 1;
    j++;
  }
  return j;
}

function handlePropertyDeclaration(ctx, i) {
  if (textAt(ctx, i) !== "@" || textAt(ctx, i + 1) !== "property") return i + 1;
  const frame = currentScope(ctx);
  const ty = parseType(ctx, i + 2, 0);
  if (!ty) return i + 1;
  emitRefs(ctx, ty.refs);
  let j = ty.end;
  if (!isName(ctx, j)) return j;
  emit(ctx, j, "property", DECL);
  if (frame.name) ctx.tokenOwners.set(j, frame.name);
  const member = { tokenType: "property", mods: DECL, declIndex: j };
  const typeName = extractTypeName(ctx, ty.refs);
  if (typeName) member.typeName = typeName;
  registerMember(ctx, frame, ctx.sig[j].text, member);
  return j + 1;
}

function handleStructConstructor(ctx, i) {
  const frame = currentScope(ctx);
  if (frame.kind !== "struct") return null;
  if (!isName(ctx, i) || textAt(ctx, i + 1) !== "(") return null;
  if (!frame.constructorNames.includes(ctx.sig[i].text)) return null;

  emit(ctx, i, "method", DECL);
  if (frame.name) ctx.tokenOwners.set(i, frame.name);
  registerMember(ctx, frame, ctx.sig[i].text, {
    tokenType: "method",
    mods: DECL,
    declIndex: i,
  });

  const params = parseParameters(ctx, i + 1);
  const symbols = params ? emitParameters(ctx, params) : new Map();
  let j = params ? params.end : i + 1;

  if (textAt(ctx, j) === ":") {
    j++;
    while (j < ctx.sig.length && textAt(ctx, j) !== "{") {
      if (isName(ctx, j) && textAt(ctx, j + 1) === "(") {
        emit(ctx, j, "property", 0);
        j++;
      } else {
        if (textAt(ctx, j) === "(") {
          const end = matchBracket(ctx, j);
          j = end < 0 ? j + 1 : end + 1;
        } else {
          j++;
        }
      }
    }
  }

  while (j < ctx.sig.length) {
    const s = textAt(ctx, j);
    if (s === "{") {
      ctx.pending = { kind: "function", name: "constructor", symbols, members: null };
      return j;
    }
    if (s === "}" || s === ";") return j + 1;
    j++;
  }
  return j;
}

function handleEnumBody(ctx, i) {
  const frame = currentScope(ctx);
  const s = textAt(ctx, i);

  if (s === ";") {
    frame.memberPhase = false;
    return i + 1;
  }
  if (s === ",") return i + 1;
  if (s === "}") return i;
  if (!isName(ctx, i)) return i + 1;

  emit(ctx, i, "enumMember", DECL);
  if (frame.name) ctx.tokenOwners.set(i, frame.name);
  const member = { tokenType: "enumMember", mods: DECL, declIndex: i };
  frame.members.set(ctx.sig[i].text, member);
  if (!ctx.enumMembers.has(frame.name)) ctx.enumMembers.set(frame.name, new Set());
  ctx.enumMembers.get(frame.name).add(ctx.sig[i].text);
  if (!ctx.members.has(frame.name)) ctx.members.set(frame.name, new Map());
  ctx.members.get(frame.name).set(ctx.sig[i].text, member);

  let j = i + 1;
  if (textAt(ctx, j) === "(") {
    const params = parseParameters(ctx, j);
    if (params) {
      emitParameters(ctx, params);
      j = params.end;
    }
  }
  if (textAt(ctx, j) === "=") {
    j = skipSeparators(ctx, j + 1, new Set([",", "}"]));
  }
  return j;
}

function handleFor(ctx, i) {
  if (textAt(ctx, i + 1) !== "(") return i + 1;
  const decl = tryDeclaration(ctx, i + 2);
  if (!decl || decl.kind !== "decl") return i + 1;
  handleDeclaration(ctx, decl);
  return decl.nameIndex + 1;
}

function findComprehensionFor(ctx, start, close) {
  let depth = 0;
  for (let j = start; j < close; j++) {
    const s = textAt(ctx, j);
    if (s === "(" || s === "[" || s === "{") {
      depth++;
    } else if (s === ")" || s === "]" || s === "}") {
      depth--;
    } else if (
      depth === 0 &&
      s === "for" &&
      isName(ctx, j + 1) &&
      textAt(ctx, j + 2) === "in"
    ) {
      return j;
    }
  }
  return -1;
}

function handleCompositeLiteral(ctx, i) {
  const close = matchBracket(ctx, i);
  if (close < 0) return null;
  const forIndex = findComprehensionFor(ctx, i + 1, close);
  if (forIndex < 0) return null;
  const nameIndex = forIndex + 1;
  emit(ctx, nameIndex, "variable", DECL);
  const symbols = new Map([
    [
      ctx.sig[nameIndex].text,
      { tokenType: "variable", mods: DECL, declIndex: nameIndex },
    ],
  ]);
  scopeRange(ctx, i + 1, close, symbols, "block");
  return close + 1;
}

function handleCatch(ctx, i) {
  if (textAt(ctx, i + 1) !== "(") return i + 1;
  const ty = parseType(ctx, i + 2, 0);
  if (!ty) return i + 1;
  emitRefs(ctx, ty.refs);
  let j = ty.end;
  if (!isName(ctx, j)) return j;
  emit(ctx, j, "variable", DECL);
  const symbol = {
    tokenType: "variable",
    mods: DECL,
    declIndex: j,
  };
  const typeName = extractTypeName(ctx, ty.refs);
  if (typeName) symbol.typeName = typeName;
  addSymbol(currentScope(ctx), ctx.sig[j].text, symbol);
  return j + 1;
}

function handleNew(ctx, i) {
  if (!isName(ctx, i + 1)) return i + 1;
  const ty = parseType(ctx, i + 1, 0);
  if (!ty) return i + 1;
  emitRefs(ctx, ty.refs);
  return ty.end;
}

function handleSizeof(ctx, i) {
  if (textAt(ctx, i + 1) !== "(") return i + 1;
  const ty = parseType(ctx, i + 2, 0);
  if (!ty) return i + 2;
  emitRefs(ctx, ty.refs);
  return ty.end;
}

function handleIs(ctx, i) {
  let j = i + 1;
  if (textAt(ctx, j) === "not") j++;
  const ty = parseType(ctx, j, 0);
  if (!ty) return i + 1;
  emitRefs(ctx, ty.refs);
  return ty.end;
}

const EXPRESSION_STARTS = new Set([
  "=", "(", ",", ";", "{", "}", "return", "=>", ":", "?", "|>", "??", "and",
  "or", "not", "in", "is", "[",
]);

function scanExpressionEnd(ctx, start) {
  let depth = 0;
  for (let i = start; i < ctx.sig.length; i++) {
    const s = textAt(ctx, i);
    if (s === "(" || s === "[" || s === "{") {
      depth++;
    } else if (s === ")" || s === "]" || s === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (s === ";" || s === "," || s === "->")) {
      return i;
    }
  }
  return ctx.sig.length;
}

function findLambdaBodyArrow(ctx, start, end) {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const s = textAt(ctx, i);
    if (s === "(" || s === "[" || s === "{") {
      depth++;
    } else if (s === ")" || s === "]" || s === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (s === "->" || s === ";" || s === ",")) {
      return i;
    }
  }
  return end;
}

function scopeRange(ctx, start, end, symbols, kind) {
  if (start >= end) return;
  const depth = ctx.scopes.length;
  ctx.scopes.push({
    kind: kind || "block",
    name: null,
    symbols,
    members: null,
    parent: currentScope(ctx),
  });
  run(ctx, start, end, false);
  while (ctx.scopes.length > depth) ctx.scopes.pop();
}

function scopeLambdaBody(ctx, start, end, symbols) {
  scopeRange(ctx, start, end, symbols, "function");
}

function tryLambda(ctx, i) {
  if (textAt(ctx, i) === "(") {
    const close = matchBracket(ctx, i);
    if (close < 0) return null;
    const next = textAt(ctx, close + 1);
    if (next !== "->" && next !== "=>") return null;

    const params = parseParameters(ctx, i);
    const symbols = params ? emitParameters(ctx, params) : new Map();

    let bodyStart;
    let bodyEnd;
    let j = close + 1;
    if (next === "->") {
      const ret = parseType(ctx, close + 2, 0);
      if (!ret || textAt(ctx, ret.end) !== "=>") return null;
      emitRefs(ctx, ret.refs);
      bodyStart = ret.end + 1;
      bodyEnd = scanExpressionEnd(ctx, bodyStart);
      j = bodyEnd;
    } else {
      bodyStart = close + 1;
      bodyEnd = findLambdaBodyArrow(ctx, bodyStart, ctx.sig.length);
      const ret = parseType(ctx, bodyEnd + 1, 0);
      if (!ret) return null;
      emitRefs(ctx, ret.refs);
      j = ret.end;
    }

    scopeLambdaBody(ctx, bodyStart, bodyEnd, symbols);
    return j;
  }

  if (isName(ctx, i)) {
    const next = textAt(ctx, i + 1);
    const symbols = new Map();
    let bodyStart;
    let bodyEnd;
    let j;

    if (next === "=>") {
      const prev = i > 0 ? textAt(ctx, i - 1) : undefined;
      if (prev !== undefined && !EXPRESSION_STARTS.has(prev)) return null;
      emit(ctx, i, "parameter", DECL);
      symbols.set(ctx.sig[i].text, {
        tokenType: "parameter",
        mods: DECL,
        declIndex: i,
      });
      bodyStart = i + 2;
      bodyEnd = findLambdaBodyArrow(ctx, bodyStart, ctx.sig.length);
      const ret = parseType(ctx, bodyEnd + 1, 0);
      if (!ret) return null;
      emitRefs(ctx, ret.refs);
      j = ret.end;
    } else if (next === "->") {
      const ret = parseType(ctx, i + 2, 0);
      if (!ret || textAt(ctx, ret.end) !== "=>") return null;
      emit(ctx, i, "parameter", DECL);
      symbols.set(ctx.sig[i].text, {
        tokenType: "parameter",
        mods: DECL,
        declIndex: i,
      });
      emitRefs(ctx, ret.refs);
      bodyStart = ret.end + 1;
      bodyEnd = scanExpressionEnd(ctx, bodyStart);
      j = bodyEnd;
    } else {
      return null;
    }

    scopeLambdaBody(ctx, bodyStart, bodyEnd, symbols);
    return j;
  }

  return null;
}

function memberBaseTypeName(ctx, i) {
  if (i < 2 || !isIdent(ctx, i - 2)) return null;
  const base = ctx.sig[i - 2].text;
  if (base === "self" || base === "this" || base === "super") {
    for (let k = ctx.scopes.length - 1; k >= 0; k--) {
      const frame = ctx.scopes[k];
      if (TYPE_KINDS.has(frame.kind) && frame.name) return frame.name;
    }
    return null;
  }
  const symbol = lookup(ctx, base);
  if (symbol) return symbol.typeName || null;
  if (ctx.types.has(base)) return base;
  const global = ctx.globals.get(base);
  if (global && global.typeName) return global.typeName;
  return null;
}

function emitSymbolRef(ctx, i, info) {
  emit(ctx, i, info.tokenType, (info.mods || 0) & ~DECL);
  if (info.declIndex !== undefined) ctx.refTargets.set(i, info.declIndex);
}

function classifyReference(ctx, i) {
  if (ctx.classified.has(i) || !isIdent(ctx, i)) return;
  const name = ctx.sig[i].text;
  if (HARD_KEYWORDS.has(name)) return;

  const prev = i > 0 ? textAt(ctx, i - 1) : undefined;
  const next = textAt(ctx, i + 1);

  if (prev === "." || prev === "->" || prev === "?.") {
    const baseType = memberBaseTypeName(ctx, i);
    const baseKind = baseType ? ctx.types.get(baseType) : null;
    const memberInfo =
      baseType && ctx.members.has(baseType)
        ? ctx.members.get(baseType).get(name)
        : null;
    if (baseType) ctx.tokenOwners.set(i, baseType);

    if (
      baseKind === "enum" &&
      ((ctx.enumMembers.has(baseType) && ctx.enumMembers.get(baseType).has(name)) ||
        (memberInfo && memberInfo.tokenType === "enumMember"))
    ) {
      if (memberInfo) {
        emitSymbolRef(ctx, i, memberInfo);
      } else {
        emit(ctx, i, "enumMember", 0);
      }
      return;
    }
    if (next === "(") {
      if (memberInfo) {
        emitSymbolRef(ctx, i, memberInfo);
      } else {
        emit(ctx, i, "method", 0);
      }
      return;
    }
    if (memberInfo) {
      emitSymbolRef(ctx, i, memberInfo);
      return;
    }
    emit(ctx, i, "property", 0);
    return;
  }

  const symbol = lookup(ctx, name);
  if (symbol) {
    emitSymbolRef(ctx, i, symbol);
    return;
  }

  if (next === "(") {
    if (PRIMITIVES.has(name)) return;
    if (ctx.types.has(name) || BUILTIN_TYPES.has(name)) {
      emit(ctx, i, typeKindFor(ctx, name), 0);
      const target = ctx.typeDeclarations.get(name);
      if (target !== undefined) ctx.refTargets.set(i, target);
      return;
    }
    if (name === "list" || name === "dict" || name === "set" || name === "tuple" || name === "frozenset") {
      emit(ctx, i, "type", 0);
      return;
    }
    emit(ctx, i, "function", BUILTIN_FUNCTIONS.has(name) ? DEFAULT_LIBRARY : 0);
    const target = ctx.functionDeclarations.get(name);
    if (target !== undefined) ctx.refTargets.set(i, target);
    return;
  }

  if (ctx.types.has(name)) {
    emit(ctx, i, ctx.types.get(name), 0);
    const target = ctx.typeDeclarations.get(name);
    if (target !== undefined) ctx.refTargets.set(i, target);
    return;
  }
  if (BUILTIN_TYPES.has(name)) {
    emit(ctx, i, "class", DEFAULT_LIBRARY);
    return;
  }
  if (ctx.namespaces.has(name)) {
    emit(ctx, i, "namespace", 0);
    return;
  }
  if (ctx.globals.has(name)) {
    const global = ctx.globals.get(name);
    emit(ctx, i, global.tokenType, global.mods || 0);
    if (global.declIndex !== undefined) ctx.refTargets.set(i, global.declIndex);
    return;
  }
  if (ctx.functions.has(name)) {
    emit(ctx, i, name === "constructor" ? "method" : "function", 0);
    const target = ctx.functionDeclarations.get(name);
    if (target !== undefined) ctx.refTargets.set(i, target);
  }
}

function openBrace(ctx) {
  const parent = currentScope(ctx);
  if (ctx.pending) {
    const pending = ctx.pending;
    ctx.pending = null;
    ctx.scopes.push({
      kind: pending.kind,
      name: pending.name,
      symbols: pending.symbols || new Map(),
      members: pending.members || null,
      memberPhase: Boolean(pending.memberPhase),
      constructorNames: pending.constructorNames || [],
      typedefAliasIndex:
        pending.typedefAliasIndex === undefined ? -1 : pending.typedefAliasIndex,
      parent,
    });
    return;
  }
  ctx.scopes.push({ kind: "block", symbols: new Map(), members: null, parent });
}

function closeBrace(ctx) {
  if (ctx.scopes.length <= 1) return;
  const frame = ctx.scopes.pop();
  if (frame.typedefAliasIndex >= 0) {
    emit(ctx, frame.typedefAliasIndex, "struct", DECL);
  }
}

function run(ctx, start = 0, end = ctx.sig.length, pushFile = true) {
  if (pushFile) {
    ctx.scopes.push({ kind: "file", name: null, symbols: new Map(), members: null });
  }

  let i = start;
  while (i < end) {
    const s = textAt(ctx, i);
    const frame = currentScope(ctx);

    if (s === "[" || s === "{") {
      const composite = handleCompositeLiteral(ctx, i);
      if (composite !== null) {
        i = composite;
        continue;
      }
    }

    if (s === "{") {
      openBrace(ctx);
      i++;
      continue;
    }
    if (s === "}") {
      closeBrace(ctx);
      i++;
      continue;
    }

    if (frame.kind === "enum" && frame.memberPhase) {
      i = handleEnumBody(ctx, i);
      continue;
    }

    if (s === "typedef" && textAt(ctx, i + 1) === "struct") {
      i = handleTypedefStruct(ctx, i);
      continue;
    }
    if (s === "typedef") {
      const next = handleTypeAlias(ctx, i);
      if (next > i + 1) {
        i = next;
        continue;
      }
    }
    if (s === "type") {
      const next = handleForwardType(ctx, i);
      if (next > i + 1) {
        i = next;
        continue;
      }
    }
    if ((s === "class" || s === "interface" || s === "struct" || s === "enum") && isName(ctx, i + 1)) {
      const body = findBodyBrace(ctx, i + 2);
      if (body >= 0) {
        i = handleTypeDeclaration(ctx, i, s);
        continue;
      }
    }
    if (s === "exception" && isName(ctx, i + 1)) {
      i = handleException(ctx, i);
      continue;
    }
    if (s === "fn" && isName(ctx, i + 1)) {
      i = handleFunction(ctx, i);
      continue;
    }
    if (s === "constructor" && TYPE_KINDS.has(frame.kind)) {
      i = handleConstructor(ctx, i);
      continue;
    }
    if ((s === "getter" || s === "setter") && TYPE_KINDS.has(frame.kind)) {
      i = handleAccessor(ctx, i);
      continue;
    }
    if (s === "@" && textAt(ctx, i + 1) === "property" && TYPE_KINDS.has(frame.kind)) {
      i = handlePropertyDeclaration(ctx, i);
      continue;
    }
    if (frame.kind === "struct" && isName(ctx, i) && textAt(ctx, i + 1) === "(") {
      const next = handleStructConstructor(ctx, i);
      if (next !== null) {
        i = next;
        continue;
      }
    }
    if (s === "package") {
      i = handlePackage(ctx, i);
      continue;
    }
    if (s === "import") {
      i = handleImport(ctx, i);
      continue;
    }
    if (s === "from") {
      i = handleFromImport(ctx, i);
      continue;
    }
    if (s === "for" && textAt(ctx, i + 1) === "(") {
      i = handleFor(ctx, i);
      continue;
    }
    if (s === "catch" && textAt(ctx, i + 1) === "(") {
      i = handleCatch(ctx, i);
      continue;
    }
    if (s === "new" && isName(ctx, i + 1)) {
      i = handleNew(ctx, i);
      continue;
    }
    if (s === "sizeof" && textAt(ctx, i + 1) === "(") {
      i = handleSizeof(ctx, i);
      continue;
    }
    if (s === "is") {
      i = handleIs(ctx, i);
      continue;
    }
    if (s === "export") {
      i++;
      continue;
    }

    const lambda = tryLambda(ctx, i);
    if (lambda !== null) {
      i = lambda;
      continue;
    }

    const decl = tryDeclaration(ctx, i);
    if (decl) {
      handleDeclaration(ctx, decl);
      i = decl.end;
      continue;
    }

    classifyReference(ctx, i);
    i++;
  }
}

function analyzeDocumentDetailed(text) {
  const sig = tokenize(text);
  const ctx = createContext(sig);
  collectDeclarations(ctx);
  run(ctx);

  ctx.out.sort((a, b) => a.index - b.index);

  const result = [];
  let previous = -1;
  for (const token of ctx.out) {
    if (token.index === previous) continue;
    previous = token.index;
    const source = sig[token.index];
    if (!source) continue;
    const targetIndex = ctx.refTargets.get(token.index);
    const targetSource =
      targetIndex !== undefined ? sig[targetIndex] || null : null;
    const isDefinition = Boolean(token.modifiers & DECL);
    result.push({
      line: source.line,
      start: source.start,
      length: source.length,
      type: token.type,
      modifiers: token.modifiers,
      name: source.text,
      isDefinition,
      importAlias: ctx.importAliases.has(token.index),
      owner: ctx.tokenOwners.get(token.index) || null,
      target: targetSource
        ? {
            line: targetSource.line,
            start: targetSource.start,
            length: targetSource.length,
            name: targetSource.text,
          }
        : null,
    });
  }
  return result;
}

function analyzeDocument(text) {
  return analyzeDocumentDetailed(text).map((token) => ({
    line: token.line,
    start: token.start,
    length: token.length,
    type: token.type,
    modifiers: token.modifiers,
  }));
}

module.exports = {
  TOKEN_TYPES,
  TOKEN_MODIFIERS,
  analyzeDocument,
  analyzeDocumentDetailed,
};
