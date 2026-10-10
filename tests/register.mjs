import { register } from "node:module";

// Lets `node --test` resolve the frontend's "@/" path alias (see tsconfig).
register("./alias-loader.mjs", import.meta.url);
