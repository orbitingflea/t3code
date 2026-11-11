/** Added to the thread title prompt, so that the title model names one sub-thread and not the thread. */
export const SUMMARY_INSTRUCTIONS = [
  "The messages are one discussion inside a longer chat. Name the subject of this discussion only.",
  "Use at most 7 words, or at most 12 Han characters when the discussion is in Chinese. This limit replaces the length rule above.",
  "Write in the language of the discussion.",
  "The name need not cover everything that was said.",
].join("\n");
