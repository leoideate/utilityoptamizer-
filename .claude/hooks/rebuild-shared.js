// PostToolUse hook: rebuild @uo/shared after an edit under packages/shared/src.
// The API and web consume its dist/, so a stale build hides type errors and runtime changes.
// Exit 2 sends the compiler output back to Claude when the build fails.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let file = "";
  try {
    file = JSON.parse(input).tool_input?.file_path ?? "";
  } catch {
    return;
  }
  if (!/packages[\\/]shared[\\/]src[\\/]/.test(file)) return;

  const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "../..");
  const r = spawnSync("npm", ["run", "build", "-w", "@uo/shared"], { cwd: root, shell: true, encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(`@uo/shared build failed after editing ${file}:\n${r.stdout}${r.stderr}`);
    process.exit(2);
  }
});
