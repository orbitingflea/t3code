import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderPoolId,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  buildPoolTable,
  place,
  resolvePoolSelection,
  type MemberState,
  type PoolCandidate,
  type PoolSelectionRequest,
  type ProviderPool,
} from "./pools.ts";

const id = ProviderInstanceId.make;
const DRIVER_KINDS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "antigravity"]);
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const HOUR = 3_600_000;

const instances: Record<string, ProviderInstanceConfig> = {
  claude_a: { driver: ProviderDriverKind.make("claudeAgent") },
  claude_b: { driver: ProviderDriverKind.make("claudeAgent") },
  claude_c: { driver: ProviderDriverKind.make("claudeAgent") },
  codex_a: { driver: ProviderDriverKind.make("codex") },
};

const settingsWith = (
  providerPools: Record<string, unknown>,
): Pick<ServerSettings, "providerPools" | "providerInstances"> => ({
  providerPools,
  providerInstances: instances as ServerSettings["providerInstances"],
});

const claudeAuto = {
  displayName: "Claude Auto",
  members: ["claude_a", "claude_b", "claude_c"],
};

const pool: ProviderPool = {
  id: ProviderPoolId.make("claude_auto"),
  displayName: "Claude Auto",
  driver: ProviderDriverKind.make("claudeAgent"),
  members: [id("claude_a"), id("claude_b"), id("claude_c")],
};

const eligible = (instanceId: string, limitedUntil: number | null = null): MemberState => ({
  instanceId: id(instanceId),
  eligibility: { kind: "eligible", limitedUntil },
});

const candidate = (instanceId: string, overrides: Partial<PoolCandidate> = {}): PoolCandidate => ({
  instanceId: id(instanceId),
  unusableReason: null,
  enabledForProject: true,
  supportsModel: (model) => model === "opus" || model === "sonnet",
  limitedUntil: null,
  ...overrides,
});

const table = buildPoolTable(settingsWith({ claude_auto: claudeAuto }), DRIVER_KINDS);

const launch = (overrides: Partial<PoolSelectionRequest> = {}): PoolSelectionRequest =>
  ({
    kind: "launch",
    requestedInstanceId: id("claude_auto"),
    seedKey: "command:1",
    table,
    candidates: [candidate("claude_a"), candidate("claude_b"), candidate("claude_c")],
    now: NOW,
    ...overrides,
  }) as PoolSelectionRequest;

describe("buildPoolTable", () => {
  it("keeps valid pools, drops each invalid pool with its reason and ignores instance ids", () => {
    const built = buildPoolTable(
      settingsWith({
        claude_auto: claudeAuto,
        claude_a: { members: ["claude_b"] },
        codex: { members: ["codex_a"] },
        empty: { members: [] },
        twice: { members: ["claude_a", "claude_a"] },
        nested: { members: ["claude_auto"] },
        missing: { members: ["claude_z"] },
        mixed: { members: ["claude_a", "codex_a"] },
        malformed: { members: "claude_a" },
        "bad id!": { members: ["claude_a"] },
        defaults: { members: ["claudeAgent", "claude_b"] },
      }),
      DRIVER_KINDS,
    );

    assert.deepStrictEqual([...built.pools.keys()].toSorted(), ["claude_auto", "defaults"]);
    assert.deepStrictEqual(built.pools.get("claude_auto"), pool);
    assert.strictEqual(built.pools.get("defaults")?.driver, "claudeAgent");
    assert.deepStrictEqual(
      [...built.dropped.values()],
      [
        "Provider pool 'bad id!' has an id that is not a valid instance id.",
        "Provider pool 'empty' has no members.",
        "Provider pool 'malformed' is not an object with a members list of instance ids.",
        "Provider pool 'missing' lists 'claude_z', which is not a provider instance.",
        "Provider pool 'mixed' mixes members of different drivers.",
        "Provider pool 'nested' lists the pool 'claude_auto' as a member; pools cannot contain pools.",
        "Provider pool 'twice' lists a member more than once.",
      ],
    );
  });

  it("gives an empty table when no pools are set", () => {
    const built = buildPoolTable(
      { providerInstances: instances as ServerSettings["providerInstances"] },
      DRIVER_KINDS,
    );
    assert.strictEqual(built.pools.size, 0);
    assert.strictEqual(built.dropped.size, 0);
  });
});

describe("place", () => {
  it("lands a retried key on the same member and spreads different keys", () => {
    const members = [eligible("claude_a"), eligible("claude_b"), eligible("claude_c")];
    const first = place(pool, members, "command:retry", NOW);
    for (const attempt of [1, 2, 3]) {
      assert.deepStrictEqual(place(pool, members, "command:retry", NOW), first, `try ${attempt}`);
    }
    const chosen = new Set(
      Array.from({ length: 30 }, (_, index) => {
        const placement = place(pool, members, `command:${index}`, NOW);
        return placement.kind === "placed" ? placement.instanceId : null;
      }),
    );
    assert.deepStrictEqual([...chosen].map(String).toSorted(), [
      "claude_a",
      "claude_b",
      "claude_c",
    ]);
  });

  it("skips limited members while another member is free", () => {
    const members = [
      eligible("claude_a", NOW + HOUR),
      eligible("claude_b"),
      eligible("claude_c", NOW + 2 * HOUR),
    ];
    for (const key of ["k1", "k2", "k3", "k4"]) {
      assert.deepStrictEqual(place(pool, members, key, NOW), {
        kind: "placed",
        poolId: pool.id,
        instanceId: id("claude_b"),
        limited: false,
      });
    }
  });

  it("treats a limit that has passed as free", () => {
    const placement = place(pool, [eligible("claude_a", NOW - 1)], "k", NOW);
    assert.deepStrictEqual(placement, {
      kind: "placed",
      poolId: pool.id,
      instanceId: id("claude_a"),
      limited: false,
    });
  });

  it("picks the member whose limit ends first when all are limited", () => {
    const members = [
      eligible("claude_a", NOW + 3 * HOUR),
      eligible("claude_b", NOW + HOUR),
      eligible("claude_c", NOW + 2 * HOUR),
    ];
    assert.deepStrictEqual(place(pool, members, "any", NOW), {
      kind: "placed",
      poolId: pool.id,
      instanceId: id("claude_b"),
      limited: true,
    });
  });

  it("reports every member's reason when none is eligible", () => {
    const placement = place(
      pool,
      [
        { instanceId: id("claude_a"), eligibility: { kind: "ineligible", reason: "is off." } },
        { instanceId: id("claude_b"), eligibility: { kind: "ineligible", reason: "no auth." } },
      ],
      "k",
      NOW,
    );
    assert.deepStrictEqual(placement, {
      kind: "noEligibleMember",
      poolId: pool.id,
      reasons: ["claude_a: is off.", "claude_b: no auth."],
    });
  });
});

describe("resolvePoolSelection", () => {
  it("passes an explicit instance through, including a pool member", () => {
    for (const requested of ["claude_b", "codex_a"]) {
      assert.deepStrictEqual(resolvePoolSelection(launch({ requestedInstanceId: id(requested) })), {
        kind: "concrete",
        instanceId: id(requested),
      });
    }
  });

  it("places a launch on a pool and gives the same member on retry", () => {
    const first = resolvePoolSelection(launch());
    assert.strictEqual(first.kind, "placed");
    assert.deepStrictEqual(resolvePoolSelection(launch()), first);
  });

  it("filters members by registration, health, project, driver and model", () => {
    const candidates = [
      candidate("claude_a", { enabledForProject: false }),
      candidate("claude_b", { supportsModel: (model) => model === "sonnet" }),
    ];
    assert.deepStrictEqual(resolvePoolSelection(launch({ candidates, model: "opus" })), {
      kind: "noEligibleMember",
      poolId: pool.id,
      reasons: [
        "claude_a: is turned off for this project.",
        "claude_b: does not offer model opus.",
        "claude_c: is not registered.",
      ],
    });
    assert.deepStrictEqual(
      resolvePoolSelection(
        launch({
          candidates: [
            candidate("claude_a", { unusableReason: "is not signed in." }),
            candidate("claude_b", { supportsModel: null }),
            candidate("claude_c", { supportsModel: (model) => model === "sonnet" }),
          ],
          model: "opus",
        }),
      ),
      { kind: "placed", poolId: pool.id, instanceId: id("claude_b"), limited: false },
    );
    const wrongDriver = resolvePoolSelection(launch({ driver: ProviderDriverKind.make("codex") }));
    assert.strictEqual(wrongDriver.kind, "noEligibleMember");
    assert.include(
      wrongDriver.kind === "noEligibleMember" ? wrongDriver.reasons[0] : "",
      "runs claudeAgent, not codex.",
    );
  });

  it("keeps the current instance on a switch to the pool that holds it", () => {
    assert.deepStrictEqual(
      resolvePoolSelection({ ...launch(), kind: "switch", currentInstanceId: id("claude_c") }),
      { kind: "kept", poolId: pool.id, instanceId: id("claude_c") },
    );
  });

  it("moves a switch off a current member that is no longer eligible", () => {
    for (const current of [
      candidate("claude_c", { enabledForProject: false }),
      candidate("claude_c", { unusableReason: "is not signed in." }),
    ]) {
      const selection = resolvePoolSelection({
        ...launch(),
        kind: "switch",
        currentInstanceId: id("claude_c"),
        candidates: [candidate("claude_a"), candidate("claude_b"), current],
      });
      assert.strictEqual(selection.kind, "placed");
      assert.include(
        ["claude_a", "claude_b"],
        selection.kind === "placed" ? selection.instanceId : "",
      );
    }
    assert.strictEqual(
      resolvePoolSelection({
        ...launch(),
        kind: "switch",
        currentInstanceId: id("claude_c"),
        candidates: [],
      }).kind,
      "noEligibleMember",
    );
  });

  it("places a switch from outside the pool like a launch", () => {
    const fromCodex = resolvePoolSelection({
      ...launch(),
      kind: "switch",
      currentInstanceId: id("codex_a"),
    });
    assert.deepStrictEqual(fromCodex, resolvePoolSelection(launch()));
  });
});
