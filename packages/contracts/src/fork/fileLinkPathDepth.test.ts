import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ClientSettingsSchema } from "../settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);

describe("fileLinkPathDepth", () => {
  it("defaults to one folder and the file name", () => {
    expect(decodeClientSettings({}).fileLinkPathDepth).toBe(2);
  });

  it.each([9, 0, 2.5, "3", null, { depth: 3 }])(
    "a bad stored depth %j decodes to 2 and keeps the other settings",
    (fileLinkPathDepth) => {
      const settings = decodeClientSettings({ fileLinkPathDepth, wordWrap: false });
      expect(settings.fileLinkPathDepth).toBe(2);
      expect(settings.wordWrap).toBe(false);
    },
  );

  it.each([1, 3] as const)("round-trips a saved depth %j", (fileLinkPathDepth) => {
    const settings = decodeClientSettings({ fileLinkPathDepth });
    expect(settings.fileLinkPathDepth).toBe(fileLinkPathDepth);
    expect(decodeClientSettings(encodeClientSettings(settings)).fileLinkPathDepth).toBe(
      fileLinkPathDepth,
    );
  });
});
