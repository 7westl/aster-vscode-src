"use strict";

const fs = require("fs");
const vscode = require("vscode");
const {
  TOKEN_MODIFIERS,
  analyzeDocumentDetailed,
} = require("./semantic");

const IDENT_PATTERN = /[\p{L}_][\p{L}\p{N}\p{M}_]*/u;
const DEFAULT_LIBRARY = 1 << TOKEN_MODIFIERS.indexOf("defaultLibrary");

const TYPE_TOKEN_TYPES = new Set([
  "type",
  "class",
  "interface",
  "struct",
  "enum",
  "typeParameter",
  "namespace",
]);
const MEMBER_TOKEN_TYPES = new Set(["method", "property", "enumMember"]);

const AST_GLOB = "**/*.ast";
const AST_EXCLUDE = "**/{node_modules,.git,out,dist,build,.vscode-test}/**";

const documentAnalyses = new Map();
const fileAnalyses = new Map();
const moduleResolutions = new Map();
let workspaceFilesPromise = null;

function sameUri(a, b) {
  return a.toString() === b.toString();
}

function normalizePath(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function readUtf8(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function analyzeDocumentTokens(document) {
  const key = document.uri.toString();
  const cached = documentAnalyses.get(key);
  if (cached && cached.version === document.version) return cached.tokens;
  const tokens = analyzeDocumentDetailed(document.getText());
  documentAnalyses.set(key, { version: document.version, tokens });
  return tokens;
}

function analyzeFileTokens(uri) {
  const open = vscode.workspace.textDocuments.find((doc) =>
    sameUri(doc.uri, uri),
  );
  if (open) return analyzeDocumentTokens(open);

  const filePath = uri.fsPath;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = fileAnalyses.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.tokens;
  }
  let text;
  try {
    text = readUtf8(filePath);
  } catch {
    return null;
  }
  const tokens = analyzeDocumentDetailed(text);
  fileAnalyses.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    tokens,
  });
  return tokens;
}

function tokensForUri(uri) {
  const open = vscode.workspace.textDocuments.find((doc) =>
    sameUri(doc.uri, uri),
  );
  if (open) return analyzeDocumentTokens(open);
  return analyzeFileTokens(uri);
}

function getWorkspaceFiles() {
  if (!workspaceFilesPromise) {
    workspaceFilesPromise = Promise.resolve(
      vscode.workspace.findFiles(AST_GLOB, AST_EXCLUDE),
    );
  }
  return workspaceFilesPromise;
}

function resetWorkspaceIndex() {
  workspaceFilesPromise = null;
  fileAnalyses.clear();
  moduleResolutions.clear();
}

function directoryDistance(fromFile, toFile) {
  const from = normalizePath(fromFile).split("/").slice(0, -1);
  const to = normalizePath(toFile).split("/").slice(0, -1);
  let common = 0;
  while (
    common < from.length &&
    common < to.length &&
    from[common] === to[common]
  ) {
    common++;
  }
  return from.length - common + (to.length - common);
}

function moduleSuffix(modulePath) {
  return modulePath.replace(/\./g, "/") + ".ast";
}

function pickNearest(matches, fromUri) {
  const sorted = matches.slice().sort((a, b) => {
    const byDistance =
      directoryDistance(fromUri.fsPath, a.fsPath) -
      directoryDistance(fromUri.fsPath, b.fsPath);
    if (byDistance !== 0) return byDistance;
    return a.fsPath.length - b.fsPath.length;
  });
  return sorted[0] || null;
}

async function resolveImportEntry(entry, fromUri) {
  if (entry.symbol) {
    const symbolFile = await resolveModuleFile(
      entry.path + "." + entry.symbol,
      fromUri,
    );
    if (symbolFile) return symbolFile;
  }
  return resolveModuleFile(entry.path, fromUri);
}

async function resolveModuleFile(modulePath, fromUri) {
  if (!modulePath) return null;
  const cacheKey = modulePath + "|" + fromUri.fsPath;
  if (moduleResolutions.has(cacheKey)) return moduleResolutions.get(cacheKey);

  const files = await getWorkspaceFiles();
  const suffix = moduleSuffix(modulePath).toLowerCase();
  const withSlash = "/" + suffix;
  const matches = [];
  for (const uri of files) {
    const candidate = normalizePath(uri.fsPath);
    if (candidate === suffix || candidate.endsWith(withSlash)) {
      matches.push(uri);
    }
  }
  const resolved = pickNearest(matches, fromUri);
  moduleResolutions.set(cacheKey, resolved);
  return resolved;
}

const MODULE_PATH = "[\\p{L}_][\\p{L}\\p{N}_]*(?:\\.[\\p{L}_][\\p{L}\\p{N}_]*)*";
const IMPORT_RE = new RegExp(
  "^import\\s+(" + MODULE_PATH + ")\\s*(\\.\\s*\\*)?\\s*(?:as\\s+([\\p{L}_][\\p{L}\\p{N}]*))?\\s*;\\s*$",
  "u",
);
const FROM_RE = new RegExp(
  "^from\\s+(" + MODULE_PATH + ")\\s+import\\s+(.+?)\\s*;?\\s*$",
  "u",
);
const IMPORT_ITEM_RE = new RegExp(
  "^([\\p{L}_][\\p{L}\\p{N}]*)(?:\\s+as\\s+([\\p{L}_][\\p{L}\\p{N}]*))?$",
  "u",
);

function parseImports(text) {
  const symbols = new Map();
  const modules = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const from = FROM_RE.exec(line);
    if (from) {
      const modulePath = from[1];
      for (const rawItem of from[2].split(",")) {
        const item = IMPORT_ITEM_RE.exec(rawItem.trim());
        if (!item) continue;
        symbols.set(item[2] || item[1], {
          path: modulePath,
          symbol: item[1],
          namespace: false,
        });
      }
      continue;
    }

    const imp = IMPORT_RE.exec(line);
    if (!imp) continue;
    const fullPath = imp[1];
    const wildcard = Boolean(imp[2]);
    const alias = imp[3];

    if (alias) {
      symbols.set(alias, {
        path: fullPath,
        symbol: null,
        namespace: true,
      });
      continue;
    }
    if (wildcard) {
      modules.push(fullPath);
      continue;
    }
    const segments = fullPath.split(".");
    const last = segments[segments.length - 1];
    if (segments.length > 1 && /^\p{Lu}/u.test(last)) {
      symbols.set(last, {
        path: fullPath,
        symbol: last,
        namespace: false,
      });
    } else {
      modules.push(fullPath);
    }
  }

  return { symbols, modules };
}

function findTokenAt(tokens, position) {
  for (const token of tokens) {
    if (token.line !== position.line) continue;
    if (
      position.character >= token.start &&
      position.character < token.start + token.length
    ) {
      return token;
    }
  }
  return null;
}

function tokenLocation(uri, token) {
  return new vscode.Location(
    uri,
    new vscode.Range(
      token.line,
      token.start,
      token.line,
      token.start + token.length,
    ),
  );
}

function startOfFile(uri) {
  return new vscode.Location(uri, new vscode.Range(0, 0, 0, 0));
}

function isTypeToken(type) {
  return TYPE_TOKEN_TYPES.has(type);
}

function scoreDefinition(def, refType, owner) {
  if (def.modifiers & DEFAULT_LIBRARY) return 0;
  if (owner) {
    if (def.owner !== owner) return 0;
    return def.type === refType ? 100 : 80;
  }
  if (def.type === refType) return 100;
  if (isTypeToken(refType) && isTypeToken(def.type)) return 70;
  if (refType === "function" && def.type === "function") return 90;
  if (refType === "method" && def.type === "method") return 90;
  if (refType === "property" && def.type === "property") return 90;
  if (refType === "enumMember" && def.type === "enumMember") return 90;
  if (!isTypeToken(refType) && !isTypeToken(def.type)) return 40;
  return 0;
}

function pickBest(tokens, name, refType, options) {
  const exclude = options && options.exclude ? options.exclude : null;
  const owner = options && options.owner ? options.owner : null;
  let best = null;
  let bestScore = 0;
  for (const token of tokens) {
    if (!token.isDefinition || token.name !== name) continue;
    if (exclude && token === exclude) continue;
    const score = scoreDefinition(token, refType, owner);
    if (score > bestScore) {
      best = token;
      bestScore = score;
    }
  }
  return best;
}

async function findInFile(uri, name, refType, owner) {
  const tokens = tokensForUri(uri);
  if (!tokens) return null;
  const def = pickBest(tokens, name, refType, { owner });
  return def ? tokenLocation(uri, def) : null;
}

async function findInModuleFiles(modulePaths, fromUri, name, refType, owner) {
  for (const modulePath of modulePaths) {
    const uri = await resolveModuleFile(modulePath, fromUri);
    if (!uri) continue;
    const found = await findInFile(uri, name, refType, owner);
    if (found) return found;
  }
  return null;
}

async function workspaceTypeFiles(name, fromUri, imports) {
  const entry = imports.symbols.get(name);
  if (entry && !entry.namespace) {
    const target = await resolveImportEntry(entry, fromUri);
    if (target) {
      const found = await findInFile(target, name, "type", null);
      if (found) return found;
    }
  }

  const found = await findInModuleFiles(imports.modules, fromUri, name, "type", null);
  if (found) return found;

  const files = await getWorkspaceFiles();
  const scored = [];
  for (const uri of files) {
    if (sameUri(uri, fromUri)) continue;
    const tokens = tokensForUri(uri);
    if (!tokens) continue;
    const def = pickBest(tokens, name, "type", null);
    if (def) {
      scored.push({
        uri,
        def,
        distance: directoryDistance(fromUri.fsPath, uri.fsPath),
      });
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.distance - b.distance || a.uri.fsPath.length - b.uri.fsPath.length);
  return tokenLocation(scored[0].uri, scored[0].def);
}

async function findMemberDefinition(owner, name, refType, fromUri, imports) {
  if (!owner) return null;

  const entry = imports.symbols.get(owner);
  let ownerFile = null;
  if (entry && !entry.namespace) {
    ownerFile = await resolveImportEntry(entry, fromUri);
  }

  const local = await findInFile(fromUri, name, refType, owner);
  if (local) return local;

  if (ownerFile) {
    const found = await findInFile(ownerFile, name, refType, owner);
    if (found) return found;
  }

  const files = await getWorkspaceFiles();
  const near = [];
  for (const uri of files) {
    if (sameUri(uri, fromUri)) continue;
    near.push(uri);
  }
  near.sort(
    (a, b) =>
      directoryDistance(fromUri.fsPath, a.fsPath) -
      directoryDistance(fromUri.fsPath, b.fsPath),
  );
  for (const uri of near) {
    const tokens = tokensForUri(uri);
    if (!tokens) continue;
    const def = pickBest(tokens, name, refType, { owner });
    if (def) return tokenLocation(uri, def);
  }
  return null;
}

function baseWordAt(document, position) {
  const before = document.lineAt(position.line).text.slice(0, position.character);
  const match =
    /([\p{L}_][\p{L}\p{N}\p{M}_]*)\s*(?:->|\?\.|\.)\s*$/u.exec(before);
  return match ? match[1] : null;
}

async function provideDefinition(document, position, cancelToken) {
  const tokens = analyzeDocumentTokens(document);
  const token = findTokenAt(tokens, position);
  const wordRange = document.getWordRangeAtPosition(position, IDENT_PATTERN);
  const word = token ? token.name : wordRange ? document.getText(wordRange) : null;
  if (!word) return null;

  const refType = token ? token.type : null;
  const currentUri = document.uri;
  const imports = parseImports(document.getText());

  if (token && token.isDefinition) {
    if (token.importAlias) {
      const entry = imports.symbols.get(word);
      if (entry) {
        const target = await resolveImportEntry(entry, currentUri);
        if (target) {
          if (entry.symbol) {
            const found = await findInFile(target, entry.symbol, "type", null);
            if (found) return found;
          }
          return startOfFile(target);
        }
      }
    }
    return tokenLocation(currentUri, token);
  }

  if (token && token.target) {
    return new vscode.Location(
      currentUri,
      new vscode.Range(
        token.target.line,
        token.target.start,
        token.target.line,
        token.target.start + token.target.length,
      ),
    );
  }

  if (cancelToken && cancelToken.isCancellationRequested) return null;

  if (MEMBER_TOKEN_TYPES.has(refType)) {
    const owner = token.owner || null;
    if (owner) {
      const found = await findMemberDefinition(
        owner,
        word,
        refType,
        currentUri,
        imports,
      );
      if (found) return found;
    }

    const base = baseWordAt(document, position);
    const baseEntry = base ? imports.symbols.get(base) : null;
    if (baseEntry) {
      const found = await findInModuleFiles(
        [baseEntry.path],
        currentUri,
        word,
        refType,
        null,
      );
      if (found) return found;
    }

    const nearby = pickBest(tokens, word, refType, { exclude: token });
    if (nearby) return tokenLocation(currentUri, nearby);

    return findInModuleFiles(imports.modules, currentUri, word, refType, null);
  }

  const entry = imports.symbols.get(word);
  if (entry) {
    const target = await resolveImportEntry(entry, currentUri);
    if (target) {
      if (!entry.symbol) return startOfFile(target);
      const found = await findInFile(target, entry.symbol, refType || "type", null);
      return found || startOfFile(target);
    }
  }

  const sameFile = pickBest(tokens, word, refType || "type", { exclude: token });
  if (sameFile) return tokenLocation(currentUri, sameFile);

  if (refType === "function" || refType === "method" || refType === null) {
    const imported = await findInModuleFiles(
      imports.modules,
      currentUri,
      word,
      refType || "function",
      null,
    );
    if (imported) return imported;
  }

  if (isTypeToken(refType) || refType === null) {
    const wildcardFile = await findModulePathBySegment(imports.modules, currentUri, word);
    if (wildcardFile) return startOfFile(wildcardFile);
    return workspaceTypeFiles(word, currentUri, imports);
  }

  return null;
}

async function findModulePathBySegment(modulePaths, fromUri, segment) {
  for (const modulePath of modulePaths) {
    const segments = modulePath.split(".");
    if (segments[segments.length - 1] !== segment) continue;
    const uri = await resolveModuleFile(modulePath, fromUri);
    if (uri) return uri;
  }
  return null;
}

function registerDefinitionSupport(context) {
  const provider = {
    provideDefinition,
  };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider({ language: "aster" }, provider),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(AST_GLOB);
  watcher.onDidChange((uri) => {
    fileAnalyses.delete(uri.fsPath);
  });
  watcher.onDidCreate(() => resetWorkspaceIndex());
  watcher.onDidDelete((uri) => {
    fileAnalyses.delete(uri.fsPath);
    resetWorkspaceIndex();
  });
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId === "aster") {
        documentAnalyses.delete(document.uri.toString());
      }
    }),
  );
}

module.exports = {
  registerDefinitionSupport,
  // Exposed for tests.
  parseImports,
  resolveModuleFile,
  provideDefinition,
};
