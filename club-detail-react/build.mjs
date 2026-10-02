import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(
  new URL("../club-manager-react/package.json", import.meta.url),
);
const { build } = require("esbuild");
await build({
  entryPoints: [fileURLToPath(new URL("./src/main.jsx", import.meta.url))],
  outfile: fileURLToPath(
    new URL("../js/club-detail-react.js", import.meta.url),
  ),
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  nodePaths: [
    fileURLToPath(
      new URL("../club-manager-react/node_modules", import.meta.url),
    ),
  ],
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
});
console.log(
  "Built js/club-detail-react.js (React 18, lazy-loaded by the detail bridge)",
);
