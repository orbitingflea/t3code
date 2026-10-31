#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
const requiredCwd = process.env.T3_CLAUDE_REQUIRED_CWD;
if (requiredCwd && process.cwd() !== NodeFS.realpathSync(requiredCwd)) {
  process.stderr.write(`claude: refusing to run outside ${requiredCwd}\n`);
  process.exit(1);
}
if (process.argv.includes("--version")) {
  process.stdout.write("claude 2.1.219\n");
  process.exit(0);
}
const loginMarker = process.env.T3_CLAUDE_LOGIN_MARKER;
const signedOut = loginMarker !== undefined && !NodeFS.existsSync(loginMarker);
if (process.env.T3_CLAUDE_PROBE_LOG)
  NodeFS.appendFileSync(process.env.T3_CLAUDE_PROBE_LOG, "probe\n");
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request") return;
  if (message.request?.subtype !== "initialize") return;
  process.stdout.write(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          agents: [],
          models: [],
          output_style: "default",
          available_output_styles: ["default"],
          account: signedOut
            ? { tokenSource: "none", apiProvider: "firstParty" }
            : { email: "test@example.com", subscriptionType: "pro", tokenSource: "oauth" },
        },
      },
    }) + "\n",
  );
});
// Stay alive for control requests only while the parent lives; SDK abort does not await child exit.
const keepAlive = setInterval(() => {}, 1_000);
lines.on("close", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
