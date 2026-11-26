# Antigravity

<<<<<<< origin/main
T3 Code runs Google's official Antigravity ACP agent on your selected environment.
T3 manages its own CLI installation and sign-in, separate from your terminal or IDE, unless you
[use your own Antigravity CLI](#use-a-manual-installation). Google controls
which models and account access are available through this agent.
=======
T3 Code runs Google's official Antigravity ACP agent on your selected environment, with a T3-managed CLI installation and sign-in separate from your terminal or IDE.
>>>>>>> upstream/main

## Set up Antigravity

1. Open **Settings → Providers** (web or desktop), choose your environment, and enable **Antigravity**.
2. Install the managed runtime (requires 1.25+ GiB free disk space; supports macOS Apple Silicon/Intel, Linux x64/ARM64 glibc/musl, and Windows x64/ARM64).
3. Click **Sign in** and complete browser sign-in. Wait for T3 Code to confirm access and load models. (Once installed, you can also sign in from mobile.)

- **Remote sign-in**: Paste the temporary code (or full URL) from Google's completion page into T3 Code's code field.
- **Manual binary**: Install [Antigravity CLI](https://antigravity.google/docs/getting-started) and set **Binary path** to `agy`. Leave blank to use the managed runtime (or `PATH`).
- **Updates**: Click **Update Antigravity** in provider settings. T3 Code requires Antigravity **1.5+** (1.5.12+ recommended); running threads finish on their original runtime.

### Sign-in methods

Choose **Sign-in method** in the Antigravity instance settings:

| Method                         | Credentials                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| **Google account**             | Personal Google browser sign-in                                         |
| **Gemini Enterprise**          | Browser sign-in, GCP project, and GCP location                          |
| **Gemini API key**             | API key (no browser required)                                           |
| **Agent Platform / Vertex AI** | API key, or GCP project + location with Application Default Credentials |

API keys are stored outside `settings.json`, and ambient `GEMINI_API_KEY` / Google env vars do not override the instance's configured method.

## Models, planning, and goals

<<<<<<< origin/main
| Method                     | Credentials                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Google account             | Personal Google sign-in in the browser                                                       |
| Gemini Enterprise          | Browser sign-in, GCP project, and GCP location                                               |
| Gemini API key             | API key; choose Connect without a browser                                                    |
| Agent Platform / Vertex AI | API key, or GCP project and location with Application Default Credentials on the environment |

The environment stores the Antigravity API key outside its settings file, and
clients only see whether one is saved. The agent uses the method and credentials selected for this instance;
ambient `GEMINI_API_KEY` and Google credential variables do not override them.
Changing the method stops the instance's sessions. Sign out before replacing an
account.

## Runtime installation

Managed installation supports Apple Silicon and Intel macOS, Linux x64 or ARM64
with glibc or musl, and Windows x64 or ARM64. Allow at least 1.25 GiB of free disk
space for downloading and staging an update.

### Use a manual installation

Install [Antigravity CLI](https://antigravity.google/docs/getting-started) on the environment.
Set **Binary path** to its `agy` executable and update it yourself.
Leave the field blank to use the managed runtime, or a compatible executable on
`PATH` if no managed runtime is installed.

When **Binary path** names your own `agy` of Antigravity CLI 1.5 or later (a full
path, or `agy` to find it on `PATH`), the instance has no private profile. The agent uses the CLI's own Google login, settings, and state
folder (`~/.gemini/antigravity-cli`), so sign in with `agy` on the environment
first. Every instance that uses it shares that login, and its sessions are stored
with the CLI's own.

The CLI's tool-permission setting decides whether it asks before a tool call. When
it asks, T3 Code answers by the thread's [permission mode](./permission-modes.md).
When the CLI is set to always proceed, tools run without asking in every mode.

**Usage > Limits** reads with the sign-in the CLI saved, in its state folder or
the system keyring. T3 Code cannot renew it, so after it expires the limits wait
for the CLI's next turn.

T3 Code does not use the CLI for titles, commit messages, or other generated text
while `~/.gemini/config` holds hooks or MCP servers, because they would run in
those helper sessions too. Select another model for generated text.

## Update the managed runtime

In web or desktop provider settings, choose **Update Antigravity** when an update
is available. T3 checks Google's CLI release channel while provider update checks
are enabled. Installing or reinstalling also checks that channel. Updates keep
your profile and existing runtime available if the new release fails validation.

T3 needs Antigravity 1.5 or newer and recommends 1.5.12 or newer. Sessions do not
start on an older runtime: update the managed runtime here, or update the executable
a custom binary path or `PATH` points at. You may need to sign in again after
updating from a runtime older than 1.5. Threads already running finish with their
original runtime; new sessions use the updated release. Custom binary paths keep
using the executable you selected.

## Models and threads

The model list comes from your Antigravity account, including Claude and GPT models
when your plan has them. Pick a thinking level beside the model list in the model picker; it
shows only the levels the selected model supports. A resumed thread keeps its
selected model. If access to that model ends, select another available model
before continuing.

Antigravity creates empty `.gemini/skills` and `.agents/skills` folders in the
workspace when a session starts. Git does not track empty folders, so they never
appear in commits.

Use Antigravity's native `/plan` command for planning. Tool approvals follow [Permission modes](./permission-modes.md).
Questions with fixed choices still need one of the offered answers, even in
**Full access**.

On web and desktop, [Edit from here](./composer.md#edit-an-earlier-prompt) works with
Antigravity. Antigravity cannot rewind its own conversation, so the next turn
starts a fresh Antigravity session and T3 Code sends it the kept conversation,
without the turns you removed.

Use `/compact` to summarize a long conversation when your Antigravity runtime
offers that command. If it is unavailable, update Antigravity in provider settings
or send `/clear` when you need a fresh context.
=======
- Models (including Claude and GPT when included in your plan) and thinking levels come from your Antigravity account.
- Use `/plan` for planning, `/compact` to summarize (if supported by your runtime), or `/clear` for a fresh session.
- **Edit from here** starts a fresh Antigravity session with the kept conversation history.
- **Native goals**: Send `/goal <objective>` when supported by your runtime. Use **Stop** to interrupt, then tell Antigravity to stop pursuing it before starting new work (`pause`/`resume`/`clear` are not supported).
- **Subagents**: Batched subagent activity is inspectable read-only via **Subagent work** (**Work** on mobile).
- Antigravity creates empty `.gemini/skills` and `.agents/skills` directories in workspaces on start (untracked by Git).
>>>>>>> upstream/main

### Skills and attachments

- **Project skills**: Loaded in priority order from `.gemini/skills`, `.agents/skills`, then `.agent/skills`.
- **Global skills**: Loaded from `~/.gemini/config/skills` or `~/.gemini/antigravity-cli/skills` (list `~/.agents/skills` in `~/.gemini/config/skills.json` or `.agents/skills.json` to include it).
- **Attachments**: Images and audio go directly to the model; PDFs and text files load as documents; videos and other files pass a saved file path (supported videos go natively to Gemini models).

## Multiple accounts and removal

Add a separate Antigravity instance in **Settings → Providers** for each Google account (runtimes are shared on disk).

| Action                              | Effect                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| **Disable**                         | Stops sessions; keeps saved login and history.                          |
| **Sign out** (or `/logout` in chat) | Stops sessions and removes saved login; keeps history.                  |
| **Remove downloaded runtime**       | Deletes shared runtime after instances are disabled; keeps credentials. |

## Usage and troubleshooting

- Check 5-hour and weekly Gemini / shared Claude & GPT quotas under **Usage → Limits**.
- Use **Refresh provider status** (web/desktop) or **Refresh models** (mobile) to reload models and access.
- For `SUBSCRIPTION_REQUIRED` or account restriction errors, see [Google's account plans](https://antigravity.google/docs/plans).
