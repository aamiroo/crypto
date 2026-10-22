// ESM resolve hook: makes the frontend's TypeScript import style loadable by
// `node --test` — both the "@/…" alias and extensionless relative specifiers
// ("./symbol" → symbol.ts), which tsc/webpack resolve but Node does not.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FRONTEND_ROOT = path.resolve(import.meta.dirname, "..", "frontend");

function resolveFile(basePath) {
  const candidates = [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

function fromFrontendTs(context) {
  const parent = context?.parentURL;
  if (!parent?.startsWith("file:")) return false;
  const p = fileURLToPath(parent);
  return p.startsWith(FRONTEND_ROOT) && /\.tsx?$/.test(p);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const url = resolveFile(path.join(FRONTEND_ROOT, specifier.slice(2)));
    if (url) return { url, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && fromFrontendTs(context)) {
    const url = resolveFile(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
    if (url) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
