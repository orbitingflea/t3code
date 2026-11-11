// T3 Code's `codex exec` call for generated text runs no hooks, like the Claude helper: a hook could
// refuse the prompt or keep the turn going. `--disable` after the user's launch arguments wins over
// `--enable hooks` and `--config features.hooks=true` there; a `--config` value loses to `--enable`.
export const CODEX_HELPER_NO_HOOKS_ARGS = ["--disable", "hooks"] as const;
