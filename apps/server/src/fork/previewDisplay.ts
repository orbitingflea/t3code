// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns an Xvfb process next to Playwright, outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Cloudflare Turnstile on grok.com loops in Chrome's new headless mode and passes in headed
// Chrome, so on Linux the preview browser runs headed on a private Xvfb display.
const SCREEN = "1920x1080x24";
const START_TIMEOUT_MS = 10_000;

/** ["Xvfb"] when no PATH directory holds it, so `t3 browser setup` installs it. */
export const missingDisplayServer = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = ((yield* HostProcess.Environment).PATH ?? "/usr/bin").split(":");
  for (const directory of directories.filter(Boolean)) {
    if (yield* fs.exists(path.join(directory, "Xvfb")).pipe(Effect.orElseSucceed(() => false))) {
      return [];
    }
  }
  return ["Xvfb"];
}).pipe(Effect.withSpan("previewDisplay.missingDisplayServer"));

/** One Xauthority entry for any display (FamilyWild), so only holders of the file can connect. */
export const xauthorityEntry = (cookie: Buffer) => {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    return [length, value];
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  return Buffer.concat([
    family,
    ...field(Buffer.alloc(0)),
    ...field(Buffer.alloc(0)),
    ...field(Buffer.from("MIT-MAGIC-COOKIE-1")),
    ...field(cookie),
  ]);
};

const readLine = (stream: NodeStream.Readable, timeoutMs: number) =>
  new Promise<string>((resolve, reject) => {
    let text = "";
    const done = (error?: Error) => {
      clearTimeout(timer);
      stream.off("data", onData).off("end", onEnd);
      if (error) reject(error);
      else resolve(text.split("\n")[0]!.trim());
    };
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) done();
    };
    const onEnd = () => done(new Error("Xvfb exited before it chose a display."));
    const timer = setTimeout(() => done(new Error("Xvfb did not start in time.")), timeoutMs);
    stream.on("data", onData).on("end", onEnd);
  });

interface Started {
  readonly env: NodeJS.ProcessEnv;
  readonly child: NodeChildProcess.ChildProcess;
}

export class PreviewDisplay {
  private readonly options: {
    readonly platform: NodeJS.Platform;
    readonly directory: string;
    readonly command?: string;
  };
  private started: Promise<Started | undefined> | undefined;
  private closed = false;

  constructor(options: PreviewDisplay["options"]) {
    this.options = options;
  }

  /** Chrome's environment on the display, or undefined when Chrome stays headless. */
  async env(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv | undefined> {
    if (this.options.platform !== "linux" || this.closed) return undefined;
    this.started ??= this.start().catch((cause) => {
      this.started = undefined;
      throw cause;
    });
    const started = await this.started;
    return started && { ...base, ...started.env };
  }

  private async start(): Promise<Started | undefined> {
    await NodeFSP.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const authority = NodePath.join(this.options.directory, "Xauthority");
    await NodeFSP.writeFile(authority, xauthorityEntry(NodeCrypto.randomBytes(16)), {
      mode: 0o600,
    });
    const child = NodeChildProcess.spawn(
      this.options.command ?? "Xvfb",
      ["-displayfd", "3", "-auth", authority, "-nolisten", "tcp", "-screen", "0", SCREEN],
      { stdio: ["ignore", "ignore", "pipe", "pipe"] },
    );
    const spawned = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      child.once("spawn", () => resolve(undefined));
      child.once("error", resolve);
    });
    // No Xvfb on this host: Chrome stays headless until `t3 browser setup` installs it.
    if (spawned?.code === "ENOENT") return undefined;
    if (spawned) throw spawned;
    let output = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2000);
    });
    const stop = () => child.kill();
    process.once("exit", stop);
    const started = this.started;
    child.once("exit", () => {
      process.off("exit", stop);
      // A later launch starts a new display; Chrome on this one has lost its screen.
      if (this.started === started) this.started = undefined;
    });
    try {
      const display = await readLine(child.stdio[3] as NodeStream.Readable, START_TIMEOUT_MS);
      if (!/^\d+$/.test(display)) throw new Error(`Xvfb reported display "${display}".`);
      return { child, env: { DISPLAY: `:${display}`, XAUTHORITY: authority } };
    } catch (cause) {
      child.kill();
      throw new Error(`T3's browser display did not start: ${String(cause)}\n${output}`.trim(), {
        cause,
      });
    }
  }

  async close() {
    this.closed = true;
    const started = await this.started?.catch(() => undefined);
    started?.child.kill();
  }
}
