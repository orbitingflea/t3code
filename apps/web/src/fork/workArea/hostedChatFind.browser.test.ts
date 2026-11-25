import { expect, it } from "vite-plus/test";

import { openThreadFind, useThreadFindStore } from "~/components/chat/threadFindStore";

import { findHasNoBar, registerFindBar } from "./hostedChatFind";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

it("keeps a thread's Find while one of its chats shows the bar, and closes it with the last", async () => {
  const threadKey = "find-env:find-thread";
  expect(findHasNoBar(threadKey)).toBe(true);
  const first = registerFindBar(threadKey);
  const second = registerFindBar(threadKey);
  openThreadFind(threadKey);
  expect(findHasNoBar(threadKey)).toBe(false);

  first();
  await flush();
  expect(useThreadFindStore.getState().threadKey).toBe(threadKey);

  second();
  const remounted = registerFindBar(threadKey);
  await flush();
  expect(useThreadFindStore.getState().threadKey).toBe(threadKey);

  remounted();
  await flush();
  expect(findHasNoBar(threadKey)).toBe(true);
  expect(useThreadFindStore.getState().threadKey).toBeNull();
});
