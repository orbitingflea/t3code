import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional, TrimmedNonEmptyString } from "../baseSchemas.ts";

/** The argv of a command that reads a `HomeDeclarationWireV1` as JSON on stdin. */
export const HomeProvisionerCommand = Schema.Array(TrimmedNonEmptyString).check(
  Schema.isMinLength(1),
);
export type HomeProvisionerCommand = typeof HomeProvisionerCommand.Type;

export const HomeProvisionerSetting = ForwardCompatibleOptional(HomeProvisionerCommand);

export const DeclaredHome = Schema.Union([
  Schema.Struct({ agent: Schema.Literal("claude"), configDir: TrimmedNonEmptyString }),
  Schema.Struct({ agent: Schema.Literal("codex"), codexHome: TrimmedNonEmptyString }),
  Schema.Struct({ agent: Schema.Literal("agy"), geminiDir: TrimmedNonEmptyString }),
]);
export type DeclaredHome = typeof DeclaredHome.Type;

const HomeDeclarationEntry = Schema.Struct({
  home: DeclaredHome,
});

/**
 * Each declaration replaces the declarer's whole list of provider homes. The server writes this
 * form; the provisioner owns its parser.
 */
export const HomeDeclarationWireV1 = Schema.Struct({
  version: Schema.Literal(1),
  declarer: TrimmedNonEmptyString,
  homes: Schema.Array(HomeDeclarationEntry),
});
export type HomeDeclarationWireV1 = typeof HomeDeclarationWireV1.Type;
