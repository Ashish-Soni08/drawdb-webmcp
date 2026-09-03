// Node test-runner hook: resolves the extension-less relative imports that the
// Vite app uses (e.g. "../data/datatypes", "../utils/exportSQL") so pure
// modules under src/webmcp can be unit-tested with plain `node --test`,
// without a bundler.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSIONS = [".js", ".jsx", ".mjs"];
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|css)$/i;

export async function resolve(specifier, context, nextResolve) {
  // Vite turns imported assets into URLs; under Node they become empty strings.
  if (ASSET_RE.test(specifier)) {
    return {
      url: "data:text/javascript,export default %22%22;",
      shortCircuit: true,
    };
  }
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const path = fileURLToPath(new URL(specifier, context.parentURL));

    if (existsSync(path) && statSync(path).isDirectory()) {
      for (const ext of EXTENSIONS) {
        const index = `${path}/index${ext}`;
        if (existsSync(index)) {
          return nextResolve(pathToFileURL(index).href, context);
        }
      }
    }

    if (!existsSync(path)) {
      for (const ext of EXTENSIONS) {
        if (existsSync(path + ext)) {
          return nextResolve(pathToFileURL(path + ext).href, context);
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
