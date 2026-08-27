# Vendored third-party components

The static pre-pass (`../blast-radius.mjs`) needs to parse code without a network or a package
install, so the parser runtime and its grammars are checked in as WebAssembly.

| File | Upstream | License |
|---|---|---|
| `tree-sitter.js`, `tree-sitter.wasm` | [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) (`web-tree-sitter`) | MIT |
| `grammars/tree-sitter-typescript.wasm`, `grammars/tree-sitter-tsx.wasm` | [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | MIT |
| `grammars/tree-sitter-java.wasm` | [tree-sitter/tree-sitter-java](https://github.com/tree-sitter/tree-sitter-java) | MIT |
| `grammars/tree-sitter-python.wasm` | [tree-sitter/tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | MIT |
| `grammars/tree-sitter-go.wasm` | [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) | MIT |
| `grammars/tree-sitter-ruby.wasm` | [tree-sitter/tree-sitter-ruby](https://github.com/tree-sitter/tree-sitter-ruby) | MIT |
| `grammars/tree-sitter-kotlin.wasm` | [fwcd/tree-sitter-kotlin](https://github.com/fwcd/tree-sitter-kotlin) | MIT |
