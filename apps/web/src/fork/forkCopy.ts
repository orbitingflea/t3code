// The fork does not translate: upstream files take the fork's English text from here.

export const FORK_SETTING_TITLES = {
  worktreeReflink: "Reflink worktrees",
  newThreadDisplayMode: "Display mode",
  previewBrowserMode: "Preview browser",
  rightPanel: "Right panel",
};

export const COMPACT_WHEN_IDLE_LABEL = "Compact when idle";
export const COMPACT_IDLE_THREADS_DESCRIPTION =
  "When to compact a large idle Claude thread: after you return, just before its prompt cache expires, when idle, or never. Each Claude provider can override this.";

export const OLD_READING_LABEL = "As of";

export const RIGHT_PANEL_SETTINGS_COPY = {
  intro:
    "These choices apply to this browser and override this machine's defaults. Letters work while the + menu or an empty panel is open.",
  section: "Menu items",
  resetAll: "Reset all",
  shown: "Shown",
  hidden: "Hidden",
  noLetter: "No letter",
  none: "none",
  byDefault: (value: string) => `Default (${value})`,
  resetItem: (label: string) => `Reset ${label} to default`,
  visibilityOf: (label: string) => `${label}: shown or hidden`,
  letterOf: (label: string) => `${label}: menu letter`,
};

// Keybinding labels for commands that act only on the pull request and issue pages.
const COMMAND_LABELS: Readonly<Partial<Record<string, string>>> = {
  "rightPanel.toggle": "Right Panel: Toggle (Pull Requests and Issues)",
  "rightPanel.toggleMaximized": "Right Panel: Toggle Maximized (Pull Requests and Issues)",
};

export const WORK_AREA_COPY = {
  chat: "Chat",
  splitRight: "Split right",
  splitDown: "Split down",
  missingThread: "This thread was archived or deleted.",
  resizePanes: "Resize panes",
  agentPreviewSetting:
    "Show a browser an agent opens as a tab, and a device as a floating preview, unless the agent says otherwise.",
  agentPreviewTitle: "Auto-show agent browsers and devices",
  agentPreviewReset: "Reset auto-show agent browsers and devices to default",
  commandLabels: COMMAND_LABELS,
};
