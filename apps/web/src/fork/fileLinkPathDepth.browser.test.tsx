import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type EditorId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../test/render";
import ChatMarkdown from "../components/ChatMarkdown";
import { collectThreadFindRanges } from "../components/chat/threadFindHighlights";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "../hooks/useSettings";

const SERVER_HOME_ENVIRONMENT = vi.hoisted(() => "server-home");

// One environment reports a home folder that its thread's cwd does not reveal.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make({
    availableEditors: [] as readonly EditorId[],
    environment: { platform: { os: "linux" }, capabilities: {} },
    homeDirectory: "/srv/me",
  });
  const configValueAtom = actual.serverEnvironment.configValueAtom;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: ((environmentId: EnvironmentId | null) =>
        environmentId === SERVER_HOME_ENVIRONMENT
          ? config
          : configValueAtom(environmentId)) as never,
    },
  };
});

const TEXT = [
  "See [glossary](docs/review-pipeline/glossary.md#L12), [web](src/web/index.ts), [server](src/server/index.ts), [readme](README.md) and [hosts](/etc/hosts).",
  "The review is done.",
].join("\n\n");

function withDefaultSettings(): Disposable {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  return { [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS) };
}

function chipPrefixes(container: HTMLElement) {
  return [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) => {
    const prefix = chip.querySelector("[data-file-link-prefix]");
    return [prefix && getComputedStyle(prefix, "::after").content, chip.textContent];
  });
}

it("draws the chosen folders before file names, outside the label text", async () => {
  using _settings = withDefaultSettings();
  await using screen = await render(
    <div data-timeline-row-id="row" data-thread-find-text="true">
      <ChatMarkdown cwd="/home/me/project" text={TEXT} />
    </div>,
  );
  const labels = [
    "glossary.md · L12",
    "index.ts · src/web",
    "index.ts · src/server",
    "README.md",
    "hosts",
  ];
  expect(chipPrefixes(screen.container)).toEqual([
    ['"review-pipeline/"', labels[0]],
    [null, labels[1]],
    [null, labels[2]],
    [null, labels[3]],
    ['"/etc/"', labels[4]],
  ]);
  await expect
    .element(
      screen.getByRole("button", { name: "File options for review-pipeline/glossary.md · L12" }),
    )
    .toBeVisible();
  const reviews = collectThreadFindRanges(screen.container, "review");
  expect(reviews).toHaveLength(1);
  expect(
    reviews[0]!.range.startContainer.parentElement?.closest(".chat-markdown-file-link"),
  ).toBeNull();

  const paragraph = screen.container.querySelector("p")!;
  const see = paragraph.firstChild!;
  const range = document.createRange();
  range.setStart(see, 0);
  range.setEnd(see, 3);
  const word = range.getBoundingClientRect();
  const box = paragraph.getBoundingClientRect();
  await userEvent.tripleClick(paragraph, {
    position: { x: word.left - box.left + 4, y: word.top - box.top + word.height / 2 },
  });
  expect(window.getSelection()?.toString().trim()).toBe(paragraph.textContent?.trim());

  await act(() => persistClientSettingsPatch({ fileLinkPathDepth: 1 }, async () => {}));

  expect(chipPrefixes(screen.container)).toEqual(labels.map((label) => [null, label]));
});

it("draws ~/ at the home folder the thread's server reports", async () => {
  using _settings = withDefaultSettings();
  const text = "See [a](/srv/me/notes/a.md) and [b](/srv/other/notes/b.md).";
  await using screen = await render(
    <>
      <ChatMarkdown
        cwd="/srv/me/project"
        threadRef={{
          environmentId: EnvironmentId.make(SERVER_HOME_ENVIRONMENT),
          threadId: ThreadId.make("thread"),
        }}
        text={text}
      />
      <ChatMarkdown cwd="/srv/me/project" text={text} />
    </>,
  );
  expect(chipPrefixes(screen.container)).toEqual([
    ['"~/notes/"', "a.md"],
    ['"notes/"', "b.md"],
    ['"notes/"', "a.md"],
    ['"notes/"', "b.md"],
  ]);
});
