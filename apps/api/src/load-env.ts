import { existsSync } from "node:fs";
import path from "node:path";

/** Loads apps/api/.env in development (Node's built-in loader). Production injects real environment variables. */
const file = path.resolve(__dirname, "..", ".env");
if (process.env.NODE_ENV !== "production" && existsSync(file)) process.loadEnvFile(file);
