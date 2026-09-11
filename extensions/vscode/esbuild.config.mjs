import { build } from "esbuild";

// Bundles the extension (including the @ai-engine/* workspace packages it imports) into a single
// CommonJS file. VS Code's extension host resolves `require("vscode")` itself at runtime, so it
// stays external; everything else is inlined, which is what makes `dist/` alone installable
// without also shipping node_modules (see docs/vscode.md).
await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info"
});
