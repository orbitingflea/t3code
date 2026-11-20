// The fork does not translate: upstream files take the fork's English text from here.

export const FORK_SETTING_TITLES = {
  worktreeReflink: "Reflink worktrees",
  newThreadDisplayMode: "Display mode",
  previewBrowserMode: "Preview browser",
  rightPanel: "Right panel",
  fileLinkPathDepth: "File link folders",
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

// Keybinding labels for commands that act only on the pages named in them.
const COMMAND_LABELS: Readonly<Partial<Record<string, string>>> = {
  "rightPanel.toggle": "Right Panel: Toggle (Pull Requests and Issues)",
  "rightPanel.toggleMaximized": "Right Panel: Toggle Maximized (Pull Requests)",
};

export const WORK_AREA_COPY = {
  chat: "Chat",
  splitRight: "Split right",
  splitDown: "Split down",
  moveLeft: "Move left",
  moveRight: "Move right",
  moveUp: "Move up",
  moveDown: "Move down",
  newTab: "New tab",
  missingThread: "This thread was archived or deleted.",
  otherProjectChat:
    "This thread is in another project or environment. Its Chat does not open in this layout.",
  openThread: "Open thread",
  notChatMode: "This thread is not in Chat mode.",
  loadingSubThread: "Loading the sub-thread…",
  subThreadNotLoaded: "This sub-thread is not in the loaded messages.",
  subThreadRemoved: "This sub-thread is no longer in the thread.",
  loadingLinkedFile: "Loading the file's thread…",
  linkedFileFailed: (error: string) => `Could not load the file's thread: ${error}`,
  boardInOtherProject: "This region is on another project's whiteboard.",
  resizePanes: "Resize panes",
  commandLabels: COMMAND_LABELS,
};
