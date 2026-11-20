import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../provider/Drivers/CodexHomeLayout.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const linkTarget = Effect.fn("codexOverlayControl.test.linkTarget")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readLink(path).pipe(Effect.orElseSucceed(() => null));
});

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-control-" });
  const base = path.join(root, "base");
  const control = path.join(base, "app-server-control");
  yield* fileSystem.makeDirectory(control, { recursive: true });
  yield* fileSystem.writeFileString(path.join(control, "daemon.sock"), "");
  yield* fileSystem.writeFileString(path.join(base, "hooks.json"), "{}\n");
  const overlay = (name: string) => path.join(root, "overlays", name);
  const materialize = (shadow: string) =>
    resolveCodexHomeLayout(decodeCodexSettings({ homePath: base, shadowHomePath: shadow })).pipe(
      Effect.flatMap(materializeCodexShadowHome),
    );
  return { fileSystem, path, base, control, overlay, materialize };
});

it.layer(NodeServices.layer)("Codex overlay app-server-control", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "never links a new overlay's app-server-control to the shared home",
    () =>
      Effect.gen(function* () {
        const { path, base, overlay, materialize } = yield* setup;
        const fresh = overlay("fresh");
        yield* materialize(fresh);
        assert.strictEqual(yield* linkTarget(path.join(fresh, "app-server-control")), null);
        assert.strictEqual(
          yield* linkTarget(path.join(fresh, "hooks.json")),
          path.join(base, "hooks.json"),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "drops an older overlay's link into the shared home and keeps the shared daemon's files",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, control, overlay, materialize } = yield* setup;
        const old = overlay("old");
        yield* fileSystem.makeDirectory(old, { recursive: true });
        yield* fileSystem.symlink(control, path.join(old, "app-server-control"));
        yield* materialize(old);
        yield* materialize(old);
        assert.strictEqual(yield* linkTarget(path.join(old, "app-server-control")), null);
        assert.isFalse(yield* fileSystem.exists(path.join(old, "app-server-control")));
        assert.isTrue(yield* fileSystem.exists(path.join(control, "daemon.sock")));
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "drops an overlay's link to an earlier base or through an aliased path",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, base, control, overlay, materialize } = yield* setup;
        const root = path.dirname(base);
        const earlier = path.join(root, "earlier-base", "app-server-control");
        yield* fileSystem.makeDirectory(earlier, { recursive: true });
        const alias = path.join(root, "base-alias");
        yield* fileSystem.symlink(base, alias);
        const links = {
          earlier,
          aliased: path.join(alias, "app-server-control"),
        };
        for (const [name, target] of Object.entries(links)) {
          const shadow = overlay(name);
          yield* fileSystem.makeDirectory(shadow, { recursive: true });
          yield* fileSystem.symlink(target, path.join(shadow, "app-server-control"));
          yield* materialize(shadow);
          assert.strictEqual(yield* linkTarget(path.join(shadow, "app-server-control")), null);
          assert.isFalse(yield* fileSystem.exists(path.join(shadow, "app-server-control")), name);
        }
        assert.isTrue(yield* fileSystem.exists(path.join(control, "daemon.sock")));
        assert.isTrue(yield* fileSystem.exists(earlier));
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)("keeps an overlay's own app-server-control", () =>
    Effect.gen(function* () {
      const { fileSystem, path, overlay, materialize } = yield* setup;
      const local = overlay("local");
      yield* fileSystem.makeDirectory(path.join(local, "app-server-control"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(local, "app-server-control", "own.sock"), "");
      yield* materialize(local);
      assert.isTrue(yield* fileSystem.exists(path.join(local, "app-server-control", "own.sock")));
    }).pipe(Effect.scoped),
  );
});
