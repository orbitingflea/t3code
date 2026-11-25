import { closeThreadFindIn } from "~/components/chat/threadFindStore";

const findBars = new Map<string, number>();

export const findHasNoBar = (threadKey: string): boolean => !findBars.has(threadKey);

export function registerFindBar(threadKey: string): () => void {
  findBars.set(threadKey, (findBars.get(threadKey) ?? 0) + 1);
  return () => {
    const left = (findBars.get(threadKey) ?? 1) - 1;
    if (left > 0) findBars.set(threadKey, left);
    else findBars.delete(threadKey);
    // After the commit, so a chat of the thread that mounts in the same commit keeps its Find.
    queueMicrotask(() => {
      if (findHasNoBar(threadKey)) closeThreadFindIn(threadKey);
    });
  };
}
