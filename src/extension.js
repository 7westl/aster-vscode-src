const vscode = require("vscode");
const { TOKEN_TYPES, TOKEN_MODIFIERS, analyzeDocument } = require("./semantic");
const { registerDefinitionSupport } = require("./definitions");
const { registerRunSupport } = require("./run");

const TOKEN_TYPE_INDEX = new Map(TOKEN_TYPES.map((type, index) => [type, index]));

function activate(context) {
  const legend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

  const provider = {
    provideDocumentSemanticTokens(document, cancelToken) {
      if (cancelToken && cancelToken.isCancellationRequested) return undefined;

      let tokens;
      try {
        tokens = analyzeDocument(document.getText());
      } catch (error) {
        console.error("[aster] semantic token analysis failed:", error);
        return new vscode.SemanticTokens(new Uint32Array(0));
      }

      const builder = new vscode.SemanticTokensBuilder(legend);
      for (const token of tokens) {
        const typeIndex = TOKEN_TYPE_INDEX.get(token.type);
        if (typeIndex === undefined) continue;
        builder.push(token.line, token.start, token.length, typeIndex, token.modifiers);
      }
      return builder.build();
    },
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "aster" },
      provider,
      legend,
    ),
  );

  registerDefinitionSupport(context);
  registerRunSupport(context);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
