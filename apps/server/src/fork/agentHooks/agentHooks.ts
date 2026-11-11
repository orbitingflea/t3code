import { handleHookCall } from "./hookRunner.ts";
import { AGENTS, runnerPaths } from "./shapes.ts";

const NodeFS = process.getBuiltinModule("node:fs");

const USAGE = `Usage: agent-hooks <command>
  run <claude|codex|agy> <native event>   answer one hook call (the agents start this)
  install [--dry-run]                     add the runner and the hook entries of the three agents
  uninstall [--dry-run]                   remove them
  doctor                                  check the install
`;

export const main = async (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  print: (text: string) => void,
): Promise<number> => {
  const [command, ...args] = argv;
  if (command === "run") {
    const agent = AGENTS.find((candidate) => candidate === args[0]);
    if (agent === undefined) return 0;
    let stdinText = "";
    try {
      stdinText = NodeFS.readFileSync(0, "utf8");
    } catch {
      stdinText = "";
    }
    print(await handleHookCall(agent, args[1] ?? "", stdinText, env));
    return 0;
  }
  const isInstall = command === "install" || command === "uninstall";
  if (!isInstall && command !== "doctor") {
    print(USAGE);
    return command === undefined || command === "help" || command === "--help" ? 0 : 1;
  }
  const unknown = args.find((arg) => !isInstall || arg !== "--dry-run");
  if (unknown !== undefined) {
    print(`error: ${command} does not take the argument ${unknown}\n${USAGE}`);
    return 1;
  }
  // The other commands are loaded on demand: a hook call never pays for the installer.
  const installer = await import("./installer.ts");
  const homes = installer.resolveHomes(env);
  const runnerFiles = installer.installedRunnerFiles(import.meta.dirname);
  if (command === "doctor") {
    const findings = installer.doctor(homes, runnerPaths(env), runnerFiles, env);
    for (const finding of findings) print(`${finding.level.padEnd(5)} ${finding.text}\n`);
    return findings.some((finding) => finding.level === "error") ? 1 : 0;
  }
  const plan = installer.planInstall(homes, runnerFiles, command === "uninstall");
  for (const note of [...plan.notes, ...installer.otherFolderNotes(env, homes)]) {
    print(`${note}\n`);
  }
  if (plan.problems.length > 0) {
    for (const problem of plan.problems) print(`error: ${problem}\n`);
    print("Nothing was written.\n");
    return 1;
  }
  for (const change of plan.changes) print(`${installer.describeChange(change)}\n`);
  if (plan.changes.length === 0) print("Nothing to change.\n");
  else if (args.includes("--dry-run")) print("Dry run: nothing was written.\n");
  else {
    installer.applyChanges(plan.changes);
    print(
      command === "install"
        ? `Installed. Check with: ${installer.shellQuote(homes.runner)} doctor\n`
        : "Uninstalled.\n",
    );
  }
  return 0;
};

const startedAsProgram = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return NodeFS.realpathSync(entry) === import.meta.filename;
  } catch {
    return false;
  }
};

// Writing to file descriptor 1 skips the set-up of process.stdout, which costs a few milliseconds per hook call.
const printToStdout = (text: string): void => {
  const data = Buffer.from(text);
  let offset = 0;
  try {
    while (offset < data.length) offset += NodeFS.writeSync(1, data, offset);
  } catch {
    process.stdout.write(data.subarray(offset));
  }
};

if (startedAsProgram()) {
  process.exitCode = await main(process.argv.slice(2), process.env, printToStdout);
}
