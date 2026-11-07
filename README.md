# About this fork

This is a fork of T3 Code that integrates a few additional features, including:

- **Whiteboard:** A tldraw whiteboard that sits side-by-side with T3 Code, allowing users to interact with agents (or other users) by editing and pointing to the whiteboard. Both the user and the agents can conveniently write links that point to a rectangular region on the whiteboard. Agents can also draw Mermaid diagrams on it, such as flowcharts and statecharts.
- **Better support for manually switching accounts mid-session:**
  - After hitting the usage limit of an account, the thread now retries after 2 minutes and 30 minutes in addition to the default retry behavior of T3 Code. This allows the thread to recover earlier if the user manually switches the account.
  - New Codex/Antigravity logins are picked up mid-session without a full restart.
- Copy buttons on pages in the preview browser now put the copied text into your own clipboard.
- **Two preview browser modes:** Settings → Browser → Preview browser picks the browser the server runs for preview tabs. **T3 native** (fast) is the default. It runs chrome-headless-shell, Chrome's small build that runs without a window. **Chrome** (slow) runs full Chrome, for pages that don't work in T3 native. On platforms where T3 has no Chrome for Testing build (Google's Chrome build for test automation), both choices run T3 native. Switching closes the open preview tabs.
- **Compact when idle for Claude threads:** a choice in Settings → Providers → Advanced → Compact idle threads. Besides compacting before the prompt cache expires, it compacts a large idle Claude thread (default 400K tokens or more) a set time (default 15 minutes) after the last message or answer from a user or a bot, so the compaction runs while no one waits for a reply. The token counts and the wait are set right under the choice.
- **Prune idle worker threads:** `t3 prune-worker-threads` deletes the messages, turn items, nodes, plans and runtime requests of idle worker threads. A worker thread is idle when it has no open run and, in the last 7 days, was not created, had no run requested or ended, and had no turn item or message updated. A worker thread is a subagent thread that an agent started. Subagent threads that a bot starts are workers too. Threads a person opens, bot threads themselves and a person's forks are never workers. An idle worker keeps its rows while recovery still needs the worker, or while a thread that keeps its own rows names the worker as parent or fork source. Pruned threads keep their thread row, runs, parent link and pull request links, so they still show up and open with no messages. The command runs only when you call it, so run it daily to keep worker transcripts from piling up. Other threads still grow the database. With `--dry-run`, the command only prints how many threads it would empty and how many rows it would delete. You can run the command while the server runs.
- Enabling math rendering by default.
- Other small fixes.

The following is the README from upstream.

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
