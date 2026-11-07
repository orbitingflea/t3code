import { describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { DashboardToolkit } from "./threadDashboard/DashboardTools.ts";
import { SendToUserToolkit } from "./userMessageTools/SendToUser.ts";

const parameterDescription = (tool: Tool.Any, parameter: string): unknown =>
  (Tool.getJsonSchema(tool) as { properties: Record<string, { description?: unknown }> })
    .properties[parameter]?.description;

// Agents see a parameter's rules only through its description in the tool's JSON schema.
describe("fork tool parameter descriptions", () => {
  it("send_to_user describes text", () => {
    expect(parameterDescription(SendToUserToolkit.tools.send_to_user, "text")).toMatch(/bytes/);
  });

  it("replace_send_to_user describes user_message, old_text and new_text", () => {
    const tool = SendToUserToolkit.tools.replace_send_to_user;
    expect(parameterDescription(tool, "user_message")).toMatch(/last message/);
    expect(parameterDescription(tool, "old_text")).toMatch(/current message/);
    expect(parameterDescription(tool, "new_text")).toMatch(/bytes/);
  });

  it("dashboard_set describes old_text and new_text", () => {
    const tool = DashboardToolkit.tools.dashboard_set;
    expect(parameterDescription(tool, "old_text")).toMatch(/70% alike/);
    expect(parameterDescription(tool, "new_text")).toMatch(/1000 visible units/);
  });
});
