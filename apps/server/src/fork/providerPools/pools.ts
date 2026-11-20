import {
  ProviderPoolConfig,
  ProviderPoolId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ProviderPool {
  readonly id: ProviderPoolId;
  readonly displayName: string;
  readonly driver: ProviderDriverKind;
  /** Never empty, no repeats, every member an instance of `driver`. */
  readonly members: ReadonlyArray<ProviderInstanceId>;
}

export interface PoolTable {
  readonly pools: ReadonlyMap<string, ProviderPool>;
  /** Each dropped pool's id and the reason it was dropped. */
  readonly dropped: ReadonlyMap<string, string>;
}

const decodePoolId = Schema.decodeUnknownOption(ProviderPoolId);
const decodePoolConfig = Schema.decodeUnknownOption(ProviderPoolConfig);

/**
 * Checks every pool and keeps only the valid ones, so a bad pool never blocks the rest. Members
 * must be distinct existing instances of one driver, never pools. A pool whose id equals an
 * instance id or a driver kind (the driver kinds name the default instances) is ignored, not
 * dropped: that id names the instance.
 */
export function buildPoolTable(
  settings: Pick<ServerSettings, "providerPools" | "providerInstances">,
  driverKinds: ReadonlySet<string>,
): PoolTable {
  const raw = settings.providerPools ?? {};
  const pools = new Map<string, ProviderPool>();
  const dropped = new Map<string, string>();
  const driverOf = (instanceId: string): ProviderDriverKind | undefined =>
    Object.hasOwn(settings.providerInstances, instanceId)
      ? settings.providerInstances[instanceId as ProviderInstanceId]?.driver
      : driverKinds.has(instanceId)
        ? (instanceId as ProviderDriverKind)
        : undefined;
  const poolIds = new Set(Object.keys(raw).filter((rawId) => driverOf(rawId) === undefined));

  for (const rawId of [...poolIds].toSorted()) {
    const problem = (detail: string) => dropped.set(rawId, `Provider pool '${rawId}' ${detail}`);
    const id = decodePoolId(rawId);
    if (Option.isNone(id)) {
      problem("has an id that is not a valid instance id.");
      continue;
    }
    const config = decodePoolConfig(raw[rawId]);
    if (Option.isNone(config)) {
      problem("is not an object with a members list of instance ids.");
      continue;
    }
    const members = config.value.members;
    if (members.length === 0) {
      problem("has no members.");
      continue;
    }
    if (new Set(members).size !== members.length) {
      problem("lists a member more than once.");
      continue;
    }
    const nested = members.find((member) => poolIds.has(member));
    if (nested !== undefined) {
      problem(`lists the pool '${nested}' as a member; pools cannot contain pools.`);
      continue;
    }
    const missing = members.find((member) => driverOf(member) === undefined);
    if (missing !== undefined) {
      problem(`lists '${missing}', which is not a provider instance.`);
      continue;
    }
    const drivers = new Set(members.map((member) => driverOf(member)));
    if (drivers.size !== 1) {
      problem("mixes members of different drivers.");
      continue;
    }
    pools.set(rawId, {
      id: id.value,
      displayName: config.value.displayName ?? rawId,
      driver: driverOf(members[0]!)!,
      members,
    });
  }
  return { pools, dropped };
}

export type MemberEligibility =
  | { readonly kind: "eligible"; readonly limitedUntil: number | null }
  | { readonly kind: "ineligible"; readonly reason: string };

export interface MemberState {
  readonly instanceId: ProviderInstanceId;
  readonly eligibility: MemberEligibility;
}

export type Placement =
  | {
      readonly kind: "placed";
      readonly poolId: ProviderPoolId;
      readonly instanceId: ProviderInstanceId;
      /** True when every eligible member was limited and this one resets first. */
      readonly limited: boolean;
    }
  | {
      readonly kind: "noEligibleMember";
      readonly poolId: ProviderPoolId;
      readonly reasons: ReadonlyArray<string>;
    };

/**
 * 32-bit FNV-1a. Same key and same eligible list give the same member, so a retried command lands
 * where its first try did.
 */
const seedIndex = (seedKey: string, size: number): number => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(seedKey)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return (hash >>> 0) % size;
};

/**
 * Picks among eligible members that are not limited, by the seed. When every eligible member is
 * limited it picks the one whose limit ends first.
 */
export function place(
  pool: ProviderPool,
  members: ReadonlyArray<MemberState>,
  seedKey: string,
  now: number,
): Placement {
  const eligible = members.flatMap((member) =>
    member.eligibility.kind === "eligible"
      ? [{ instanceId: member.instanceId, limitedUntil: member.eligibility.limitedUntil }]
      : [],
  );
  if (eligible.length === 0) {
    return {
      kind: "noEligibleMember",
      poolId: pool.id,
      reasons: members.map((member) =>
        member.eligibility.kind === "ineligible"
          ? `${member.instanceId}: ${member.eligibility.reason}`
          : `${member.instanceId}: eligible`,
      ),
    };
  }
  const free = eligible.filter(
    (member) => member.limitedUntil === null || member.limitedUntil <= now,
  );
  if (free.length > 0) {
    return {
      kind: "placed",
      poolId: pool.id,
      instanceId: free[seedIndex(seedKey, free.length)]!.instanceId,
      limited: false,
    };
  }
  const soonest = eligible.reduce((best, member) =>
    member.limitedUntil! < best.limitedUntil! ? member : best,
  );
  return { kind: "placed", poolId: pool.id, instanceId: soonest.instanceId, limited: true };
}

/** What the caller knows about one concrete instance for this request. */
export interface PoolCandidate {
  readonly instanceId: ProviderInstanceId;
  /** Why this caller cannot run on it now, or null when it can. */
  readonly unusableReason: string | null;
  readonly enabledForProject: boolean;
  /** Null when the caller does not know the models, which skips the model check. */
  readonly supportsModel: ((model: string) => boolean) | null;
  readonly limitedUntil: number | null;
}

interface PoolSelectionRequestBase {
  readonly requestedInstanceId: ProviderInstanceId;
  readonly driver?: ProviderDriverKind | undefined;
  readonly model?: string | undefined;
  readonly seedKey: string;
  readonly table: PoolTable;
  readonly candidates: ReadonlyArray<PoolCandidate>;
  readonly now: number;
}

export type PoolSelectionRequest =
  | (PoolSelectionRequestBase & { readonly kind: "launch" })
  | (PoolSelectionRequestBase & {
      readonly kind: "switch";
      readonly currentInstanceId: ProviderInstanceId | null;
    });

export type PoolSelection =
  | { readonly kind: "concrete"; readonly instanceId: ProviderInstanceId }
  | {
      readonly kind: "placed";
      readonly poolId: ProviderPoolId;
      readonly instanceId: ProviderInstanceId;
      readonly limited: boolean;
    }
  | {
      readonly kind: "kept";
      readonly poolId: ProviderPoolId;
      readonly instanceId: ProviderInstanceId;
    }
  | {
      readonly kind: "noEligibleMember";
      readonly poolId: ProviderPoolId;
      readonly reasons: ReadonlyArray<string>;
    };

const memberEligibility = (
  pool: ProviderPool,
  instanceId: ProviderInstanceId,
  request: PoolSelectionRequestBase,
): MemberEligibility => {
  if (request.driver !== undefined && request.driver !== pool.driver) {
    return { kind: "ineligible", reason: `runs ${pool.driver}, not ${request.driver}.` };
  }
  const candidate = request.candidates.find((entry) => entry.instanceId === instanceId);
  if (candidate === undefined) return { kind: "ineligible", reason: "is not registered." };
  if (candidate.unusableReason !== null) {
    return { kind: "ineligible", reason: candidate.unusableReason };
  }
  if (!candidate.enabledForProject) {
    return { kind: "ineligible", reason: "is turned off for this project." };
  }
  if (
    request.model !== undefined &&
    candidate.supportsModel !== null &&
    !candidate.supportsModel(request.model)
  ) {
    return { kind: "ineligible", reason: `does not offer model ${request.model}.` };
  }
  return { kind: "eligible", limitedUntil: candidate.limitedUntil };
};

/**
 * Turns a requested selection into a concrete instance. An instance id passes through. A pool id
 * is placed in one member, except that a switch to the pool already holding the thread's instance
 * keeps that instance while it is eligible, so nothing is handed off.
 */
export function resolvePoolSelection(request: PoolSelectionRequest): PoolSelection {
  const pool = request.table.pools.get(request.requestedInstanceId);
  if (pool === undefined) return { kind: "concrete", instanceId: request.requestedInstanceId };
  const members = pool.members.map((instanceId) => ({
    instanceId,
    eligibility: memberEligibility(pool, instanceId, request),
  }));
  if (request.kind === "switch") {
    const current = members.find((member) => member.instanceId === request.currentInstanceId);
    if (current?.eligibility.kind === "eligible") {
      return { kind: "kept", poolId: pool.id, instanceId: current.instanceId };
    }
  }
  return place(pool, members, request.seedKey, request.now);
}
