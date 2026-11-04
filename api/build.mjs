// Bundles the Lambda handler into dist/lambda.mjs (zip that file to deploy).
import { build } from "esbuild";

await build({
  entryPoints: ["src/lambda.ts"],
  outfile: "dist/lambda.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: true,
  external: ["pg-native"],
  // Some dependencies still use require(); give ESM output a working one.
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
console.log("Built dist/lambda.mjs");
