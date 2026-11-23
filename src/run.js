const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const IS_WINDOWS = process.platform === "win32";
const EXECUTABLE_NAMES = IS_WINDOWS ? ["aster.exe", "aster"] : ["aster", "aster.exe"];
const TERMINAL_NAME = "Aster";
const SEARCH_DEPTH = 2;
const SEARCH_LIMIT = 2000;

let terminal;
let terminalKey;
let cachedWorkspaceExecutable;

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function findToolchainHome(executable) {
  const dir = path.dirname(executable);
  if (isDirectory(path.join(dir, "Lib"))) return dir;
  if (path.basename(dir).toLowerCase() === "bin") {
    const root = path.dirname(dir);
    if (isDirectory(path.join(root, "Lib"))) return root;
  }
  return undefined;
}

function expandPath(value) {
  let result = (value || "").trim();
  if (!result) return "";

  const home = os.homedir();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";

  if (result === "~") {
    result = home;
  } else if (result.startsWith("~/") || result.startsWith("~\\")) {
    result = path.join(home, result.slice(2));
  }

  return path.normalize(
    result
      .replace(/\$\{userHome\}/gi, home)
      .replace(/\$\{workspaceFolder\}/gi, workspaceFolder),
  );
}

function findOnPath(name) {
  const entries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of entries) {
    let dir = entry.trim();
    if (!dir) continue;
    if (dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1);
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function searchWorkspace() {
  const roots = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  const queue = [];

  for (const root of roots) {
    queue.push({ dir: root, depth: 0 });
    queue.push({ dir: path.join(path.dirname(root), "Aster-Alpha-Version"), depth: SEARCH_DEPTH });
  }

  const seen = new Set();
  let visited = 0;

  while (queue.length > 0 && visited < SEARCH_LIMIT) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    visited += 1;

    for (const name of EXECUTABLE_NAMES) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }

    if (depth >= SEARCH_DEPTH) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  return undefined;
}

function executableResult(executable, fallbackHome) {
  return {
    command: executable,
    toolchainHome: findToolchainHome(executable) || fallbackHome,
  };
}

function resolveExecutable() {
  const configured = expandPath(vscode.workspace.getConfiguration("aster").get("executablePath", ""));

  if (configured) {
    if (isFile(configured)) return executableResult(configured);
    if (IS_WINDOWS && isFile(`${configured}.exe`)) return executableResult(`${configured}.exe`);
    return { missingConfiguredPath: configured };
  }

  const asterHome = expandPath(process.env.ASTER_HOME);
  if (asterHome) {
    for (const name of EXECUTABLE_NAMES) {
      for (const candidate of [path.join(asterHome, name), path.join(asterHome, "bin", name)]) {
        if (isFile(candidate)) return executableResult(candidate, asterHome);
      }
    }
  }

  for (const name of EXECUTABLE_NAMES) {
    const onPath = findOnPath(name);
    if (onPath) return executableResult(onPath);
  }

  if (cachedWorkspaceExecutable === undefined) {
    cachedWorkspaceExecutable = searchWorkspace() || null;
  }
  if (cachedWorkspaceExecutable) return executableResult(cachedWorkspaceExecutable);

  return {};
}

function findDocument(uri) {
  return vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === "file" && samePath(document.uri.fsPath, uri.fsPath),
  );
}

async function resolveTarget(resource) {
  let uri;

  if (resource instanceof vscode.Uri) {
    uri = resource;
  } else if (Array.isArray(resource) && resource[0] instanceof vscode.Uri) {
    uri = resource[0];
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    if (editor.document.isUntitled) {
      const saved = await editor.document.save();
      if (!saved) return null;
    }
    uri = editor.document.uri;
  }

  if (uri.scheme !== "file") return undefined;

  const activeDocument = vscode.window.activeTextEditor?.document;
  const document =
    activeDocument &&
    activeDocument.uri.scheme === "file" &&
    samePath(activeDocument.uri.fsPath, uri.fsPath)
      ? activeDocument
      : findDocument(uri);

  if (document && document.isDirty) {
    const saved = await document.save();
    if (!saved) return null;
  }

  return { uri, fsPath: uri.fsPath };
}

function usesPowerShell() {
  if (!IS_WINDOWS) return false;
  const shell = path.basename(vscode.env.shell || "").toLowerCase();
  return shell === "powershell.exe" || shell === "pwsh.exe";
}

// PowerShell needs the call operator for a quoted executable path; other
// shells accept double quotes.
function quoteArgument(value) {
  if (usesPowerShell()) return `'${value.replace(/'/g, "''")}'`;
  return `"${value.replace(/"/g, "")}"`;
}

function buildCommandLine(executable, filePath) {
  const prefix = usesPowerShell() ? "& " : "";
  return `${prefix}${quoteArgument(executable)} ${quoteArgument(filePath)}`;
}

function getTerminal(cwd, env) {
  const key = JSON.stringify({ cwd, env });
  if (terminal && terminal.exitStatus === undefined && terminalKey === key) return terminal;

  if (terminal) terminal.dispose();

  const options = { name: TERMINAL_NAME, cwd };
  if (Object.keys(env).length > 0) options.env = env;

  terminal = vscode.window.createTerminal(options);
  terminalKey = key;
  return terminal;
}

async function showExecutableSettings(message) {
  const choice = await vscode.window.showErrorMessage(message, "Open Settings");
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "aster.executablePath");
  }
}

async function runFile(resource) {
  const target = await resolveTarget(resource);
  if (target === null) return;
  if (!target) {
    vscode.window.showErrorMessage("Open an Aster (.ast) file to run it.");
    return;
  }

  const resolution = resolveExecutable();

  if (resolution.missingConfiguredPath) {
    await showExecutableSettings(
      `Aster executable not found at "${resolution.missingConfiguredPath}". Update "aster.executablePath".`,
    );
    return;
  }

  if (!resolution.command) {
    await showExecutableSettings(
      'Aster executable not found. Install Aster, add it to PATH, or set "aster.executablePath".',
    );
    return;
  }

  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  const cwd = folder ? folder.uri.fsPath : path.dirname(target.fsPath);
  const env = resolution.toolchainHome ? { ASTER_HOME: resolution.toolchainHome } : {};

  const instance = getTerminal(cwd, env);
  instance.show();
  instance.sendText(buildCommandLine(resolution.command, target.fsPath));
}

function registerRunSupport(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("aster.runFile", runFile),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("aster.executablePath")) {
        cachedWorkspaceExecutable = undefined;
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      cachedWorkspaceExecutable = undefined;
    }),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        terminal = undefined;
        terminalKey = undefined;
      }
    }),
    {
      dispose() {
        if (terminal) {
          terminal.dispose();
          terminal = undefined;
          terminalKey = undefined;
        }
      },
    },
  );
}

module.exports = {
  registerRunSupport,
};
