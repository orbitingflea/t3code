import { render } from "../../test/render";
import {
  compactIdleChoicePatch,
  type CompactIdleChoice,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  updateSettings: (() => {}) as (patch: object) => void,
}));

vi.mock(import("~/components/settings/SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    targets: [{ environmentId: "env", settings: state.settings }],
  })) as never,
}));
vi.mock(import("~/components/settings/useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((select?: (settings: typeof state.settings) => unknown) =>
    select ? select(state.settings) : state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("~/components/settings/settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({ title, control }: { title: ReactNode; control: ReactNode }) => (
    <div>
      <h3>{title}</h3>
      {control}
    </div>
  )) as never,
  SettingResetButton: (() => null) as never,
}));

import { CompactIdleValueRows } from "./CompactIdleValueRows";

describe("CompactIdleValueRows", () => {
  it.each([
    { choice: "onReturn", inputs: [] },
    { choice: "beforeCacheExpires", inputs: ["Cache expiry tokens"] },
    { choice: "whenIdle", inputs: ["Cache expiry tokens", "Idle tokens", "Idle minutes"] },
    { choice: "off", inputs: [] },
  ] satisfies { choice: CompactIdleChoice; inputs: string[] }[])(
    "shows the values $choice reads",
    async ({ choice, inputs }) => {
      state.settings = { ...DEFAULT_SERVER_SETTINGS, ...compactIdleChoicePatch(choice) };
      await using screen = await render(<CompactIdleValueRows />);

      const shown = [...screen.container.querySelectorAll("input")].map((input) =>
        input.getAttribute("aria-label"),
      );
      expect(shown).toEqual(inputs);
    },
  );

  it.each([
    { title: "Idle tokens", stored: "500000", typed: "300000", shown: "300000", saved: "300000" },
    { title: "Idle tokens", stored: "500000", typed: "200,000", shown: "", saved: "" },
    { title: "Idle tokens", stored: "500000", typed: "0", shown: "", saved: "" },
    { title: "Idle tokens", stored: "500000", typed: "007", shown: "", saved: "" },
    { title: "Idle tokens", stored: "500000", typed: "10000000", shown: "", saved: "" },
    { title: "Idle tokens", stored: "", typed: "many", shown: "", saved: null },
    { title: "Idle minutes", stored: "30", typed: "9999", shown: "9999", saved: "9999" },
    { title: "Idle minutes", stored: "30", typed: "10000", shown: "", saved: "" },
    { title: "Cache expiry tokens", stored: "300000", typed: "1e5", shown: "", saved: "" },
  ] as const)(
    "$title on blur after typing $typed",
    async ({ title, stored, typed, shown, saved }) => {
      const key = {
        "Cache expiry tokens": "compactBeforeCacheExpiresTokens",
        "Idle tokens": "compactWhenIdleTokens",
        "Idle minutes": "compactWhenIdleMinutes",
      }[title];
      state.settings = {
        ...DEFAULT_SERVER_SETTINGS,
        ...compactIdleChoicePatch("whenIdle"),
        [key]: stored,
      };
      const updateSettings = vi.fn();
      state.updateSettings = updateSettings;
      await using screen = await render(<CompactIdleValueRows />);

      const input = screen.getByRole("textbox", { name: title });
      await userEvent.clear(input);
      await userEvent.type(input, typed);
      await userEvent.tab();

      await expect.element(input).toHaveValue(shown);
      expect(updateSettings.mock.calls).toEqual(saved === null ? [] : [[{ [key]: saved }]]);
    },
  );
});
