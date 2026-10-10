// ESM resolve hook: maps the frontend "@/..." alias to real .ts files.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRONTEND_ROOT = path.resolve(import.meta.dirname, "..", "frontend");

function resolveFile(basePath) {
  const candidates = [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const url = resolveFile(path.join(FRONTEND_ROOT, specifier.slice(2)));
    if (url) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
