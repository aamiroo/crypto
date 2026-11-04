import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Two lockfiles (repo root + frontend) make Next guess the workspace root and
 *  warn on every build. It guesses the repo root, which is right — node_modules
 *  for the monorepo's own devDeps sits above `frontend/` — so say it explicitly
 *  instead of relying on the inference. */
const nextConfig = {
  turbopack: { root: join(dirname(fileURLToPath(import.meta.url)), "..") },
  allowedDevOrigins: ["192.168.100.69"],
};

export default nextConfig;
