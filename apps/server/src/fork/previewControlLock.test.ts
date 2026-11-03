import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "../preview/DesktopBrowserChannel.ts";
import * as Manager from "../preview/Manager.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";

// A smaller copy of the fake Chromium in ServerBrowser.test.ts: one headless tab, viewers only.

vi.mock("../preview/ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeSession(viewport: { width: number; height: number }) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => events.on(name, callback)),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data: "ZnJhbWU=" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        const world = (input as { worldName?: string }).worldName;
        return { executionContextId: world === "t3-preview-viewport" ? 9 : 1 };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 9)
        return { result: { value: { ...viewport } } };
      return { result: { value: "evaluated" } };
    }),
  };
}

function makeContext() {
  const events = new NodeEvents.EventEmitter();
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
  let viewport: ReturnType<Page["viewportSize"]> = { width: 1280, height: 800 };
  const cssViewport = { width: 1920, height: 1080 };
  let closed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
    }),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  const context = {
    page,
    sessions,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (_target: unknown) => {
      const session = makeSession(cssViewport);
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {
      await page.close();
    }),
  };
  return context;
}

const contexts: ReturnType<typeof makeContext>[] = [];
const scope = {
  environmentId: EnvironmentId.make("control-lock-test-environment"),
  thread: {
    threadId: ThreadId.make("control-lock-test-thread"),
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
const layer = ServerBrowser.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Broker.layer,
      Manager.layer,
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(scope.environmentId),
        getDescriptor: Effect.die("unused descriptor"),
      }),
      Layer.succeed(PreviewBrowser.PreviewBrowser, {
        executable: Effect.die("mock Chromium does not need an executable"),
        installed: Effect.die("mock Chromium does not need an executable"),
      }),
      Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
        available: false,
        awaitAttached: () => Effect.succeed(false),
        detached: Stream.never,
        attached: Stream.never,
        isAttached: () => Effect.succeed(false),
        endpoint: () => Effect.die("no desktop"),
        pointer: () => Effect.void,
        turn: () => Effect.void,
      }),
      PreviewAgentActivity.layer,
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-lock-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

beforeEach(() => {
  contexts.length = 0;
});

it.live("a viewer that reconnects behind a stuck click still connects with control", () => {
  const started = Promise.withResolvers<void>();
  const stuck = Promise.withResolvers<Record<string, unknown>>();
  return Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const { tabId } = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const before = yield* Scope.make();
      const clicking = yield* browser
        .attachViewer(viewerInput(tabId, true))
        .pipe(Scope.provide(before));
      const session = contexts[0]!.sessions.at(-1)!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method !== "Input.dispatchMouseEvent") return send(method, input);
        started.resolve();
        return stuck.promise;
      });
      yield* clicking
        .input({
          type: "mouse",
          action: "down",
          x: 10,
          y: 10,
          button: "left",
          buttons: 1,
          clickCount: 1,
          modifiers: 0,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      // A reload: the old stream ends while its click still waits on the page.
      yield* Scope.close(before, Exit.void).pipe(Effect.forkScoped({ startImmediately: true }));
      const reloaded = yield* browser
        .attachViewer(viewerInput(tabId, true))
        .pipe(Effect.timeout("5 seconds"));
      expect(yield* Queue.takeAll(reloaded.output)).toContainEqual(
        expect.objectContaining({ _tag: "control", controller: "you" }),
      );
      // Viewer finalizers wait on the queue, so the click must end before the scope closes.
    }).pipe(Effect.ensuring(Effect.sync(() => stuck.resolve({})))),
  ).pipe(Effect.provide(layer));
});

it.live("a viewer whose connect never finishes does not hold control", () => {
  const started = Promise.withResolvers<void>();
  const frozen = Promise.withResolvers<Record<string, unknown>>();
  return Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const { tabId } = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      yield* browser.attachViewer(viewerInput(tabId, false));
      const context = contexts[0]!;
      const newCDPSession = context.newCDPSession;
      context.newCDPSession = async (target) => {
        context.newCDPSession = newCDPSession;
        const session = await newCDPSession(target);
        const send = session.send.getMockImplementation()!;
        session.send.mockImplementation(async (method, input) => {
          if (method !== "Page.startScreencast") return send(method, input);
          started.resolve();
          return frozen.promise;
        });
        return session;
      };
      // The client gave up on this connect, but a proxy that never aborts it keeps it running.
      yield* browser.attachViewer(viewerInput(tabId, true)).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      const next = yield* browser
        .attachViewer(viewerInput(tabId, true))
        .pipe(Effect.timeout("5 seconds"));
      expect(
        (yield* Queue.takeAll(next.output)).findLast((item) => item._tag === "control"),
      ).toEqual(expect.objectContaining({ controller: "you" }));
    }).pipe(Effect.ensuring(Effect.sync(() => frozen.resolve({})))),
  ).pipe(Effect.provide(layer));
});

it.live("tells a viewer without control which viewer holds it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const { tabId } = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const holding = yield* browser.attachViewer(viewerInput(tabId, true));
      const holder = (yield* Queue.takeAll(holding.output)).findLast(
        (item) => item._tag === "control",
      );
      const other = yield* browser.attachViewer(viewerInput(tabId, true));
      expect(
        (yield* Queue.takeAll(other.output)).findLast((item) => item._tag === "control"),
      ).toEqual(
        expect.objectContaining({
          controller: "another-viewer",
          holder: { viewer: holder?.viewer, attachedAt: expect.any(Number), connected: true },
        }),
      );
      expect(holder).toEqual(expect.objectContaining({ controller: "you", holder: null }));
    }),
  ).pipe(Effect.provide(layer)),
);
