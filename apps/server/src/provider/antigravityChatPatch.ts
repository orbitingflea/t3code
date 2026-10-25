// @effect-diagnostics nodeBuiltinImport:off - Effect has no CRC-32 or SHA-256 over a byte range.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Bump when the patch content changes, so installs build a fresh cached copy.
 */
export const ANTIGRAVITY_CHAT_PATCH_REVISION = 1;

/**
 * Replaces each of exactly `count` matches of `find`. With `until`, a match
 * spans from `find` to the next `until`, which is kept.
 */
export interface AntigravityTextEdit {
  readonly find: string;
  readonly until?: string;
  readonly replace: string;
  readonly count?: number;
}

export type AntigravityParEntryPatch =
  | {
      readonly name: string;
      readonly sha256: string;
      readonly edits: ReadonlyArray<AntigravityTextEdit>;
    }
  // zipimport loads the .py source when the cached bytecode has a bad magic.
  | { readonly name: string; readonly sha256: string; readonly breakBytecode: true };

export interface AntigravityParPatch {
  readonly entries: ReadonlyArray<AntigravityParEntryPatch>;
}

export class AntigravityChatPatchError extends Schema.TaggedError<AntigravityChatPatchError>()(
  "AntigravityChatPatchError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

const patchError = (detail: string) => new AntigravityChatPatchError({ detail });

const ACP_SERVER = "google3/cloud/developer_experience/antigravity_extensions/acp_server/";

// The agy ACP server registers hooks.json Stop hooks as a session-end hook and
// ignores `decision: "continue"`; the agy CLI runs them at each turn end. This
// turns the hook into an SDK StopHook with CLI-shaped input, and shows each
// continue reason in the chat before the continued reply. The harness answers
// session/cancel only after the Stop hook returns, so a cancel kills a running
// hook command instead of waiting up to its timeout.
const STOP_HOOK_CLASS = String.raw`class ExternalOnSessionEndHook(hooks.StopHook):
  """Stop hooks from hooks.json, run at each turn end like the agy CLI."""

  def __init__(
      self,
      hooks_config: Mapping[str, Any],
      workspace_root: str,
      *,
      conversation_id: str | None = None,
      workspace_paths: list[str] | None = None,
      transcript_path: str | None = None,
      artifact_dir_path: str | None = None,
      on_continue: Callable[[str], Awaitable[None]] | None = None,
      is_cancelled: Callable[[], bool] | None = None,
  ):
    self._hooks_config = hooks_config
    self._workspace_root = workspace_root
    self._conversation_id = conversation_id
    self._workspace_paths = workspace_paths or [workspace_root]
    self._artifact_dir_path = artifact_dir_path
    self._on_continue = on_continue
    self._is_cancelled = is_cancelled or (lambda: False)
    self._last_reason = ""

  @override
  async def run(
      self, context: hooks.HookContext, data: types.StopArgs
  ) -> types.StopHookResult:
    if has_workspace_hooks(self._workspace_root):
      new_cfg = load_hooks_config(self._workspace_root)
      if isinstance(self._hooks_config, dict):
        self._hooks_config.clear()
        self._hooks_config.update(new_cfg)
    reason = data.stop_reason.value
    if self._is_cancelled():
      reason = "USER_CANCELED"
    elif reason == "UNSPECIFIED":
      reason = "ERROR" if data.error_message else "NO_TOOL_CALL"
    elif reason == "MAX_MODEL_CALLS_EXCEEDED":
      reason = "MAX_INVOCATIONS"
    elif reason.endswith("_TOKENS_EXCEEDED"):
      reason = "MAX_TOKEN_BUDGET_EXCEEDED"
    # The CLI transcript format: hooks read the reply from the last
    # PLANNER_RESPONSE and an earlier continue from the SYSTEM_MESSAGE before it.
    steps = [("MODEL", "PLANNER_RESPONSE", data.response_text)]
    if data.continuation_count and self._last_reason:
      steps.insert(0, ("SYSTEM", "SYSTEM_MESSAGE", (
          "The following is a <SYSTEM_MESSAGE> not actually sent by the user."
          " It is provided by the system as important information to pay"
          " attention to.\n\n<SYSTEM_MESSAGE>\nStop hook blocked termination: "
          + self._last_reason + "\n</SYSTEM_MESSAGE>")))
    now = datetime.datetime.now(datetime.timezone.utc)
    fd, transcript = tempfile.mkstemp(prefix="stop-", suffix=".jsonl")
    reasons = []
    try:
      with os.fdopen(fd, "w", encoding="utf-8") as f:
        for i, (source, kind, content) in enumerate(steps):
          f.write(json.dumps({
              "step_index": i, "source": source, "type": kind,
              "status": "DONE", "created_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "content": content}) + "\n")
      stdin_data = {
          "artifactDirectoryPath": self._artifact_dir_path,
          "conversationId": self._conversation_id,
          "error": data.error_message or "",
          "executionNum": data.continuation_count,
          "fullyIdle": True,
          "terminationReason": reason,
          "transcriptPath": transcript,
          "workspacePaths": self._workspace_paths,
      }
      for hook_name, hook_spec in self._hooks_config.items():
        for handler in hook_spec.get("Stop", []):
          if not isinstance(handler, Mapping):
            logger.warning("Invalid handler in Stop: %r", handler)
            continue
          command = handler.get("command")
          if handler.get("type", "command") != "command" or not command:
            continue
          hook = asyncio.ensure_future(run_hook_command_async(
              command, stdin_data, timeout=handler.get("timeout", 30),
              cwd=self._workspace_root))
          while not hook.done():
            await asyncio.wait([hook], timeout=0.2)
            if self._is_cancelled():
              hook.cancel()
              return types.StopHookResult()
          result = hook.result()
          if result is None:
            logger.error("External hook %r failed to execute.", hook_name)
          elif result.get("decision") == "continue":
            if text := str(result.get("reason") or "").strip():
              reasons.append(text)
    finally:
      os.unlink(transcript)
    self._last_reason = "\n".join(reasons)
    if not reasons or self._is_cancelled():
      return types.StopHookResult()
    if self._on_continue:
      await self._on_continue(self._last_reason)
    return types.StopHookResult(
        decision=types.StopDecision.CONTINUE, reason=self._last_reason)


`;

const INIT_DOCSTRING = String.raw`    """Initializes the instance.

    Args:
      hooks_config: The hooks configuration mapping.
      workspace_root: The workspace root directory.
      conversation_id: The unique ID of the conversation.
      workspace_paths: List of workspace paths.
      transcript_path: Path to the transcript file.
      artifact_dir_path: Path to the artifact directory.
      ask_user_fn: Optional callback function to prompt the user.
    """`;

const LOAD_HOOKS_CONFIG =
  "    hooks_config = await acp_hooks.load_hooks_config_async(resolved_cwd)\n";

// The marker step rides the SDK step queue so it reaches the client in order,
// between the reply the hook judged and the continued reply.
const STOP_HOOK_CALLBACKS = String.raw`    def stop_cancelled() -> bool:
      info = self._sessions.get(session_id)
      return bool(info and getattr(
          info.agent.conversation.connection, "_client_cancelled", False))

    async def stop_feedback(reason: str) -> None:
      info = self._sessions.get(session_id)
      if info:
        await info.agent.conversation.connection._processor.step_queue.put(
            sdk_types_module.Step(id=f"stop:{uuid.uuid4()}", t3_stop_reason=reason))

`;

const STOP_HOOK_MARKER = String.raw`    """Translates a single live SDK step into ACP session updates."""
    if not self._client:
      return
    if reason := getattr(step, "t3_stop_reason", None):
      await self._client.session_update(
          session_id=session_id,
          update=schema.AgentThoughtChunk(
              session_update="agent_thought_chunk",
              content=schema.TextContentBlock(
                  type="text", text="Stop hook feedback: " + reason),
              field_meta={"t3.stop_hook": {"id": step.id, "reason": reason}},
          ),
      )
      return
`;

const patches = new Map<string, AntigravityParPatch>([
  [
    "1.4.3",
    {
      entries: [
        {
          name: `${ACP_SERVER}hooks.py`,
          sha256: "c90d3db2df07ac3c76e8c3708c2c0413610c5b3e8a85e1b94c48375c2d289b72",
          edits: [
            { find: "import copy\n", replace: "import copy\nimport datetime\n" },
            { find: "import subprocess\n", replace: "import subprocess\nimport tempfile\n" },
            // Room for the larger class: the patch keeps every entry's size.
            { find: INIT_DOCSTRING, replace: `    """Initializes the instance."""`, count: 4 },
            {
              find: "class ExternalOnSessionEndHook(",
              until: "class ExternalOnInteractionHook(",
              replace: STOP_HOOK_CLASS,
            },
          ],
        },
        {
          name: `${ACP_SERVER}__pycache__/hooks.cpython-314.pyc`,
          sha256: "73425bd73a539dcf8e9cf6bc35b0c0a9d1a76642858d888682d4fd93846c94d3",
          breakBytecode: true,
        },
        {
          name: `${ACP_SERVER}server.py`,
          sha256: "5a51fe07811386fed8e31b2de36137beac76796a3b78272f14b226f310bd2c3b",
          edits: [
            { find: LOAD_HOOKS_CONFIG, replace: STOP_HOOK_CALLBACKS + LOAD_HOOKS_CONFIG },
            {
              find: "acp_hooks.ExternalOnSessionEndHook(\n              hooks_config,\n              resolved_cwd,\n",
              replace:
                "acp_hooks.ExternalOnSessionEndHook(\n              hooks_config,\n              resolved_cwd,\n              on_continue=stop_feedback,\n              is_cancelled=stop_cancelled,\n",
            },
            {
              find: '    """Translates a single live SDK step into ACP session updates.',
              until: "    if hidden_tool_calls is None:",
              replace: STOP_HOOK_MARKER,
            },
            // Room for the additions above.
            {
              find: '    """Maps an execution tool call to its permission-prompt frame id.',
              until: "    call_id = call.id\n",
              replace: '    """Maps an execution tool call to its permission-prompt frame id."""\n',
            },
          ],
        },
        {
          name: `${ACP_SERVER}__pycache__/server.cpython-314.pyc`,
          sha256: "d77bd8226329913bfe132cd113a0341ac9872fbc86531a234f362b72766cc4ef",
          breakBytecode: true,
        },
      ],
    },
  ],
]);

export function resolveAntigravityChatPatch(version: string | null) {
  return version === null ? undefined : patches.get(version);
}

const PADDING = 0x20;

/** Applies the edits and pads with trailing spaces, so the entry size never changes. */
const patchAntigravitySource = Effect.fn("AntigravityChatPatch.patchSource")(function* (
  original: Uint8Array,
  edits: ReadonlyArray<AntigravityTextEdit>,
) {
  let text = Buffer.from(original).toString("utf8");
  for (const edit of edits) {
    const pieces: Array<string> = [];
    let cursor = 0;
    let matches = 0;
    for (;;) {
      const start = text.indexOf(edit.find, cursor);
      if (start < 0) break;
      const end =
        edit.until === undefined
          ? start + edit.find.length
          : text.indexOf(edit.until, start + edit.find.length);
      if (end < 0) return yield* patchError(`No end anchor after "${edit.find}".`);
      pieces.push(text.slice(cursor, start), edit.replace);
      cursor = end;
      matches += 1;
    }
    if (matches !== (edit.count ?? 1)) {
      return yield* patchError(`Expected ${edit.count ?? 1} of "${edit.find}", found ${matches}.`);
    }
    text = pieces.join("") + text.slice(cursor);
  }
  const patched = Buffer.from(text, "utf8");
  if (patched.length > original.length) {
    return yield* patchError(`The patch is ${patched.length - original.length} bytes too long.`);
  }
  return Buffer.concat([patched, Buffer.alloc(original.length - patched.length, PADDING)]);
});

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
// Bit 0 is encryption; bit 3 moves the CRC to a data descriptor we would not update.
const UNSUPPORTED_FLAGS = 0x0001 | 0x0008;

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Patches STORED entries in place with same-length bytes and fixes their CRCs
 * in the local and central headers. Reads only the central directory and the
 * target entries, and writes nothing until every entry has been checked.
 */
export const patchAntigravityPar = Effect.fn("AntigravityChatPatch.patchPar")(function* (
  filePath: string,
  patch: AntigravityParPatch,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.open(filePath, { flag: "r+" });
  const readAt = (position: number, length: number) =>
    file
      .readAlloc(length, { position: BigInt(position) })
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes) && bytes.value.length === length
            ? Effect.succeed(Buffer.from(bytes.value.buffer, bytes.value.byteOffset, length))
            : Effect.fail(patchError("The archive ends early.")),
        ),
      );
  const writeAt = (position: number, bytes: Uint8Array) =>
    file.seek(BigInt(position), "start").pipe(Effect.andThen(file.writeAll(bytes)));

  const size = Number((yield* file.stat).size);
  const tailLength = Math.min(size, EOCD_BYTES + MAX_COMMENT_BYTES);
  const tailStart = size - tailLength;
  const tail = yield* readAt(tailStart, tailLength);
  let eocd = -1;
  for (let at = tail.length - EOCD_BYTES; at >= 0; at -= 1) {
    if (
      tail.readUInt32LE(at) === EOCD_SIGNATURE &&
      at + EOCD_BYTES + tail.readUInt16LE(at + 20) === tail.length
    ) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return yield* patchError("The archive has no end record.");
  const entryCount = tail.readUInt16LE(eocd + 10);
  const centralBytes = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (
    entryCount === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff ||
    (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE)
  ) {
    return yield* patchError("ZIP64 archives are not supported.");
  }
  // The PAR is an executable with the ZIP appended; offsets count from the ZIP start.
  const prefix = tailStart + eocd - centralBytes - centralOffset;
  if (prefix < 0) return yield* patchError("The archive offsets are invalid.");
  const centralStart = prefix + centralOffset;
  const central = yield* readAt(centralStart, centralBytes);

  const wanted = new Map(patch.entries.map((entry) => [entry.name, entry]));
  const found = new Map<
    string,
    { readonly centralAt: number; readonly localOffset: number; readonly bytes: number }
  >();
  for (let at = 0, index = 0; index < entryCount; index += 1) {
    if (at + 46 > central.length || central.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      return yield* patchError("The central directory is invalid.");
    }
    const nameLength = central.readUInt16LE(at + 28);
    const name = central.toString("utf8", at + 46, at + 46 + nameLength);
    if (wanted.has(name)) {
      const flags = central.readUInt16LE(at + 8);
      const method = central.readUInt16LE(at + 10);
      const compressed = central.readUInt32LE(at + 20);
      const bytes = central.readUInt32LE(at + 24);
      if (method !== 0 || (flags & UNSUPPORTED_FLAGS) !== 0 || compressed !== bytes) {
        return yield* patchError(`${name} is not a plain stored entry.`);
      }
      found.set(name, {
        centralAt: centralStart + at,
        localOffset: central.readUInt32LE(at + 42),
        bytes,
      });
    }
    at += 46 + nameLength + central.readUInt16LE(at + 30) + central.readUInt16LE(at + 32);
  }

  const writes: Array<{
    readonly dataAt: number;
    readonly localAt: number;
    readonly centralAt: number;
    readonly data: Uint8Array;
  }> = [];
  for (const entry of patch.entries) {
    const info = found.get(entry.name);
    if (info === undefined) return yield* patchError(`${entry.name} is missing.`);
    const localAt = prefix + info.localOffset;
    const local = yield* readAt(localAt, 30);
    const nameLength = local.readUInt16LE(26);
    if (
      local.readUInt32LE(0) !== LOCAL_SIGNATURE ||
      local.readUInt16LE(8) !== 0 ||
      (local.readUInt16LE(6) & UNSUPPORTED_FLAGS) !== 0 ||
      (yield* readAt(localAt + 30, nameLength)).toString("utf8") !== entry.name
    ) {
      return yield* patchError(`${entry.name} has an unexpected local header.`);
    }
    const dataAt = localAt + 30 + nameLength + local.readUInt16LE(28);
    const original = yield* readAt(dataAt, info.bytes);
    if (sha256(original) !== entry.sha256)
      return yield* patchError(`${entry.name} has unexpected bytes.`);
    const data =
      "breakBytecode" in entry
        ? Buffer.concat([Buffer.alloc(4), original.subarray(4)])
        : yield* patchAntigravitySource(original, entry.edits);
    writes.push({ dataAt, localAt, centralAt: info.centralAt, data });
  }

  for (const write of writes) {
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(NodeZlib.crc32(write.data));
    yield* writeAt(write.dataAt, write.data);
    yield* writeAt(write.localAt + 14, crc);
    yield* writeAt(write.centralAt + 16, crc);
  }
}, Effect.scoped);
