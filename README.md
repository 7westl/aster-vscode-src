# Aster Language Support

VS Code extension for Aster (`.ast`) with TextMate lexical highlighting, a scope-aware semantic token provider, and the **Aster Material** color theme.

## Theme

The bundled theme uses the Material Theme Ocean palette (background `#263238`, foreground `#EEFFFF`, purple keywords `#C792EA`, blue functions `#82AAFF`, yellow types `#FFCB6B`, green strings `#C3E88D`, cyan operators `#89DDFF`, orange parameters `#F78C6C`, teal properties `#80CBC4`).

Select it with **Preferences: Color Theme → Aster Material**. Semantic highlighting is enabled in the theme, so scoped types, parameters, fields, enum variants, and calls override the TextMate fallback colors.

## Semantic highlighting

The provider tokenizes source while excluding comments and strings, constructs lexical brace scopes, and classifies nominal types, functions/methods, parameters, variables, fields, enum variants, and references. It uses the hard/soft keyword sets and declaration forms in `Grammar/aster.gram`.

Supported declaration contexts include classes/interfaces/structs/enums, `typedef struct` tags and aliases, `typedef Alias Type;` type aliases, `export type Name;` forward declarations, exceptions, methods, constructors, getters/setters, `@property` fields, struct constructors, enum payload parameters, generics, imports, `for`/`catch` bindings, comprehensions, casts, `sizeof`, `is`, `new`, and both new-style `(params) -> ret => body` and old-style `(params) => body -> ret` / `x -> ret => body` lambdas. Lambda and comprehension bindings are scoped to their expression instead of leaking into the enclosing block.

**Implementation boundary:** this is an editor-side semantic analyzer, not a direct binding to the C compiler's `Checker` / `Scope` / `Sym` objects. Full overload resolution, flow-sensitive narrowing, and complete generic/member inference require a compiler-side semantic-token API.

## Go to definition (F12)

`F12` / **Go to Definition** resolves the symbol under the cursor in the same file and across imported modules:

- Locals, parameters, fields, methods, enum members, lambdas, comprehension bindings, and type parameters resolve through the analyzer's scope and member tables.
- Member access is type-aware: `reader.readLine()`, `self->src`, `this.count`, and `Type.member` resolve through the declared type of the receiver.
- Imports are parsed as module files: `import a.b.C;` and `import a.b.C as X;` map to a file ending in `a/b/C.ast`, `import a.b.*;` registers a wildcard module, and `from a.b import C as D;` resolves the symbol `C` (preferring `a/b/C.ast`, then `a/b.ast`). When multiple files match a module path, the one nearest to the current file wins.
- Imported types that are only referenced (not declared locally) still resolve without semantic classification.
- Unresolved type names fall back to a workspace-wide search restricted to declarations of the same name; methods and properties are only searched through the receiver's type (same file, imported module, then matching owner type). Built-in library symbols (`println`, `len`, exception types, `Scanner`, `Files`) intentionally produce no location.

The resolver caches analyses per open document version and per file modification time. A `.ast` file watcher invalidates changed files and rebuilds the workspace module index when files are created or deleted.

**Known limits:** inheritance chains are not followed (a method inherited from a base class is not found unless called on that base type), and chained calls such as `a.b().c` only resolve their first member.

## Running `.ast` files

An `.ast` file can be run straight from the editor:

- Click the play button in the editor title bar, or run **Aster: Run Aster File** from the Command Palette.
- Press `Ctrl+F5`, or right-click the editor, a tab, or a file in the Explorer and choose **Run Aster File**.

The command saves the file and then executes `aster <file>` in an integrated terminal named **Aster**, so program output and standard input work as usual.

The compiler is located in this order:

1. The `aster.executablePath` setting (supports `~`, `${userHome}`, and `${workspaceFolder}`).
2. The `ASTER_HOME` environment variable (`ASTER_HOME/aster(.exe)` or `ASTER_HOME/bin/aster(.exe)`).
3. `aster` / `aster.exe` on `PATH`.
4. A shallow search of the workspace, including a sibling `Aster-Alpha-Version` folder.

When the binary sits next to a `Lib` directory, the extension sets `ASTER_HOME` for the terminal so the standard library resolves. If no compiler is found, the error message links to the `aster.executablePath` setting.

## Validation

The repository is checked with:

```sh
npm run check
```

The grammar was tokenized against all 357 `.ast` files in `Aster-Alpha-Version` with `vscode-textmate` + `vscode-oniguruma` (0 tokenizer failures), and the semantic analyzer processed the same corpus (30,400 tokens, 0 errors) with all tokens within document bounds. Definition resolution was checked on multi-file fixtures and against the real library (`BufferedReader extends Reader`, `sb.append` into `String.ast`, `self->src`, aliased `from ... import DayOfWeek as Dow`), including an Extension Host run of `editor.action.revealDefinition`.

## Extension development

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Open an `.ast` file and select the **Aster Material** color theme.

To package as VSIX, install `vsce` and run `vsce package`.
