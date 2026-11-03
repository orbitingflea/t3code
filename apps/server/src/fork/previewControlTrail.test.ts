import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import * as PreviewControlTrail from "./previewControlTrail.ts";

const tab = { threadId: "thread", tabId: "tab_1", agentId: null };

it.effect("logs who got control, who lost it, and why", () => {
  const messages: unknown[] = [];
  const logger = Logger.make(({ message }) => messages.push(message));
  return Effect.gen(function* () {
    PreviewControlTrail.viewerAttaching("stale-viewer-id");
    PreviewControlTrail.viewerAttaching("fresh-viewer-id");
    PreviewControlTrail.viewerConnected("fresh-viewer-id");
    yield* PreviewControlTrail.logControlChange(tab, {
      from: null,
      to: "stale-viewer-id",
      reason: "attach",
    });
    yield* PreviewControlTrail.logControlChange(tab, {
      from: "stale-viewer-id",
      to: null,
      reason: "disconnect",
    });
    // Not a change: nothing to log.
    yield* PreviewControlTrail.logControlChange(tab, { from: null, to: null, reason: "tabClosed" });
    expect(messages).toEqual([
      [
        "server preview control changed",
        expect.objectContaining({
          tabId: "tab_1",
          reason: "attach",
          from: null,
          to: expect.objectContaining({ viewer: "stale-vi", connected: false }),
        }),
      ],
      [
        "server preview control changed",
        expect.objectContaining({
          reason: "disconnect",
          from: expect.objectContaining({ viewer: "stale-vi" }),
          to: null,
        }),
      ],
    ]);
    expect(PreviewControlTrail.controlFields("fresh-viewer-id", "stale-viewer-id")).toEqual({
      viewer: "fresh-vi",
      holder: { viewer: "stale-vi", attachedAt: expect.any(Number), connected: false },
    });
    expect(PreviewControlTrail.controlFields("fresh-viewer-id", "fresh-viewer-id").holder).toBe(
      null,
    );
    PreviewControlTrail.viewerGone("stale-viewer-id");
    PreviewControlTrail.viewerGone("fresh-viewer-id");
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.effect("names why each change of controller happened", () => {
  const changes: Array<string> = [];
  const logger = Logger.make(({ message }) => {
    const [, entry] = message as [string, { reason: string; from: unknown; to: unknown }];
    changes.push(
      `${entry.reason}:${entry.from === null ? "-" : "v"}>${entry.to === null ? "-" : "v"}`,
    );
  });
  return Effect.gen(function* () {
    const logs: Array<Effect.Effect<void>> = [];
    const control = new PreviewControlTrail.TracedSessionControl(tab, (log) => logs.push(log));
    yield* Effect.promise(() =>
      PreviewControlTrail.because("attach", () => control.take("viewer-a")),
    );
    yield* Effect.promise(() => control.release("viewer-a"));
    yield* Effect.promise(() => control.take("viewer-a"));
    yield* Effect.promise(() => control.disconnect("viewer-a"));
    yield* Effect.promise(() => control.take("viewer-a"));
    yield* Effect.promise(() => control.close());
    yield* Effect.all(logs);
    expect(changes).toEqual([
      "attach:->v",
      "release:v>-",
      "take:->v",
      "disconnect:v>-",
      "take:->v",
      "tabClosed:v>-",
    ]);
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});
