import { handleHookCall } from "./hookRunner.ts";
import { describeKey, findProject, setTrusted } from "./projectHooks.ts";
import { AGENTS, errorText, type RunnerPaths, runnerPaths } from "./shapes.ts";

const NodeFS = process.getBuiltinModule("node:fs");

const USAGE = `Usage: agent-hooks <command>
  run <claude|codex|agy> <native event>   answer one hook call (the agents start this)
  install [--dry-run]                     add the runner and the hook entries of the three agents
  uninstall [--dry-run]                   remove them
  doctor                                  check the install, and the project hooks of this folder
  trust [folder]                          let the hooks of the project of this folder run
  untrust [folder]                        stop them again
`;

const changeTrust = (
  trusted: boolean,
  folder: string,
  paths: RunnerPaths,
  print: (text: string) => void,
): number => {
  const project = findProject(folder, paths);
  if (project === null) {
    print(`error: no project hook file (.agents/hooks/hooks.json) at or above ${folder}\n`);
    return 1;
  }
  if (project.key === null) {
    print(`error: ${project.folder} or its .git entry cannot be read\n`);
    return 1;
  }
  try {
    const changed = setTrusted(project.key, trusted, paths);
    const state = trusted
      ? changed
        ? "Trusted"
        : "Already trusted"
      : changed
        ? "No longer trusted"
        : "Was not trusted";
    print(`${state}: ${describeKey(project.key)}\n`);
    print(
      trusted
        ? `The hooks in ${project.file} run.\n`
        : `The hooks in ${project.file} do not run.\n`,
    );
    return 0;
  } catch (cause) {
    print(`error: ${errorText(cause)}\nNothing was written.\n`);
    return 1;
  }
};

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
  if (command === "trust" || command === "untrust") {
    if (args.length > 1) {
      print(`error: ${command} takes at most one folder\n${USAGE}`);
      return 1;
    }
    return changeTrust(command === "trust", args[0] ?? process.cwd(), runnerPaths(env), print);
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
    const findings = installer.doctor(homes, runnerPaths(env), runnerFiles, env, process.cwd());
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
