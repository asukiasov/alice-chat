// Runs before every deploy (see "build" in wrangler.jsonc). Writes the commit shown in the menu.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (args) => {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const sha = process.env.WORKERS_CI_COMMIT_SHA || git("rev-parse HEAD");
const date = git("log -1 --format=%cs") || new Date().toISOString().slice(0, 10);
writeFileSync("public/version.json", JSON.stringify({ commit: sha.slice(-6), date }) + "\n");
