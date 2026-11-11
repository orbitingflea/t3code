import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";

const PATH = process.env.PATH ?? "";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const MODEL = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini");
const TITLE_REPLY = JSON.stringify({ title: "Hooks stay off" });

const layer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-helper-hooks-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("the Codex text-generation call", (it) => {
  it.effect("turns hooks off after launch arguments that turn them on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-helper-hooks-" });
      const argsFile = path.join(folder, "args.json");
      const binaryPath = writeFakeCli({
        directory: path.join(folder, "bin"),
        name: "codex",
        source: [
          'import * as NodeFS from "node:fs";',
          "const args = process.argv.slice(2);",
          'if (args.includes("mcp")) { process.stdout.write("[]"); process.exit(0); }',
          `NodeFS.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));`,
          `NodeFS.writeFileSync(args[args.indexOf("--output-last-message") + 1], ${JSON.stringify(TITLE_REPLY)});`,
        ].join("\n"),
      });
      const userArgs = ["--enable", "hooks", "--config", "features.hooks=true"];
      const textGeneration = yield* makeCodexTextGeneration(
        decodeCodexSettings({ binaryPath, launchArgs: userArgs.join(" ") }),
        { PATH },
      );

      yield* textGeneration.generateThreadTitle({
        cwd: folder,
        message: "Name this thread",
        modelSelection: MODEL,
      });

      const args = yield* fs
        .readFileString(argsFile)
        .pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))),
        );
      expect(args.slice(1, 1 + userArgs.length)).toEqual(userArgs);
      const disable = args.lastIndexOf("--disable");
      expect(disable).toBeGreaterThan(userArgs.length);
      expect(args[disable + 1]).toBe("hooks");
    }).pipe(Effect.scoped),
  );
});
