import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../test/render";
import ChatMarkdown from "../components/ChatMarkdown";
import { collectThreadFindRanges } from "../components/chat/threadFindHighlights";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "../hooks/useSettings";

const TEXT = [
  "See [glossary](docs/review-pipeline/glossary.md#L12), [web](src/web/index.ts), [server](src/server/index.ts) and [readme](README.md).",
  "The review is done.",
].join("\n\n");

it("draws the chosen folders before file names, outside the label text", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };
  await using screen = await render(
    <div data-timeline-row-id="row" data-thread-find-text="true">
      <ChatMarkdown cwd="/home/me/project" text={TEXT} />
    </div>,
  );
  const chips = () =>
    [...screen.container.querySelectorAll(".chat-markdown-file-link")].map((chip) => {
      const prefix = chip.querySelector("[data-file-link-prefix]");
      return [prefix && getComputedStyle(prefix, "::after").content, chip.textContent];
    });
  const labels = ["glossary.md · L12", "index.ts · src/web", "index.ts · src/server", "README.md"];
  expect(chips()).toEqual(labels.map((label) => [null, label]));

  await act(() => persistClientSettingsPatch({ fileLinkPathDepth: 2 }, async () => {}));

  expect(chips()).toEqual([
    ['"review-pipeline/"', labels[0]],
    ...labels.slice(1).map((label) => [null, label]),
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
});
