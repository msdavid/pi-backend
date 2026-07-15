---
name: cc-knockoff
title: cc-knockoff
description: "A Claude Code–style coding agent distribution built around autonomous sub-agent spawning and coordination, with web research, browser automation, live shell, model routing, and task management in support. Includes a Claude-style status line and an explore-before-acting approach."
version: 1.2.1
tags: [full-config, claude-code-style]
---

<!-- pi-distro provenance
     appliedHarness: cc-knockoff
     appliedVersion: 1.2.1
     sourceCatalogue: github:msdavid/pi-distro/harnesses/cc-knockoff
     lastUpdated: 2026-07-14T07:27:36.881Z
-->

# cc-knockoff

A complete interactive coding agent configuration that attempts to mimic as closely as
possible the functionality of today's Claude Code. The primary capability is spawning and
coordinating autonomous sub-agents; the remaining functionality is integrated in support
of that.

## Bundled files
The following bundled files are provided under `files/` and should be placed into the
target project. For any path that already exists, do NOT overwrite — show the user a diff
and ask whether to overwrite, keep theirs, or merge. Merge JSON settings field-by-field.
For `APPEND_SYSTEM.md`, if one already exists, concatenate the bundled content at the
end under a clear `# cc-knockoff methodology` delimiter rather than overwriting — pi
joins multiple `APPEND_SYSTEM.md` sources with a blank-line separator, but since the
project-local file is a single file, concatenate within it.

- `files/.pi/APPEND_SYSTEM.md` → `./.pi/APPEND_SYSTEM.md`
- `files/settings.json` → `./.pi/settings.json` (merge with existing settings)

## pi packages to install
Use `pi install -l` to install the following **project-locally** (writes to
`./.pi/settings.json` on success, leaves settings untouched on failure). Confirm with the
user before each install. Do NOT pre-add these to the bundled `settings.json` `packages`
array — `pi install -l` is the single registration mechanism.

- `npm:@tintinweb/pi-subagents` — Claude Code–style autonomous sub-agents: spawn
  specialized agents in isolated sessions, each with its own tools, system prompt, model,
  and thinking level; parallel execution, a live monitoring widget, mid-run steering, and
  session resumption (the primary capability of this distribution)
- `npm:pi-web-access` — web search, URL fetching, GitHub cloning, PDF/video extraction
- `npm:pi-agent-browser-native` — real browser automation and web interaction
- `npm:pi-bash-live-view` — live terminal rendering for shell commands
- `npm:pi-cc-status` — Claude Code–style status-line footer (model | dir | thinking level |
  context-window bar gauge + cache % | git branch status), plus optional session/cost/tokens/
  version/providers segments, an accessibility mode, and a command mode that runs existing
  Claude Code statusline scripts verbatim. Auto-enables on session start; toggle with
  `/cc-status`, re-read config with `/cc-status:reload`, edit it with `/cc-status:edit`
- `npm:@yeliu84/pi-model-router` — model routing / fallback across providers
- `npm:@robhowley/pi-openrouter` — OpenRouter provider integration
- `npm:@juicesharp/rpiv-todo` — task list management
- `npm:pi-goal` — persistent autonomous goals: `/goal` loops until complete, paused, or
  budget-limited, so long-running objectives survive across turns without manual babysitting
- `npm:@trevonistrevon/pi-loop` — cron/event-based agent re-wake loops and background
  process monitoring: schedule agents to re-wake on time or events and keep long-running
  or background work alive without manual babysitting
- `npm:@juicesharp/rpiv-ask-user-question` — structured questionnaire the model can put to
  the user when it would otherwise guess, with typed options instead of free-form replies
  (reduces ambiguous decisions and keeps the user in the loop on judgment calls)
- `npm:pi-btw` — `/btw` side conversation channel: opens a parallel pi sub-session with
  coding-tool access that runs immediately while the main agent is still busy, keeps a
  continuous thread by default (or contextless via `/btw:tangent`), and lets you inject
  the thread or a summary back into the main agent
- `npm:@mrclrchtr/supi-prompt-suggestions` — advisory ghost-text prompt suggestions:
  after each assistant response, suggests a concise next prompt as dim ghost text in the
  editor (accept with →, dismiss with Esc); ships disabled by default — the deploying
  agent configures the suggestion model during deploy (see the post-install directive
  below); no `/supi-settings` package is required

**Tool-name conflict check:** before installing, cross-check each package's purpose
against the already-active tools in the target project (run `pi list`). If a package
overlaps an existing tool — either an exact name collision or semantic redundancy
(different names, similar function) — offer **skip / replace / keep both / cancel**
instead of installing blindly. (Exact name collisions are non-fatal in pi — project-local
tools shadow global ones — but redundancy leaves a confusing duplicate tool set.)

**Post-install — configure `npm:@mrclrchtr/supi-prompt-suggestions` with the user:**
this package ships **disabled by default** — no suggestions will appear until a suggestion
model is configured. This distro intentionally does **not** install `supi-settings` (the
`/supi-settings` UI); instead, the deploying agent configures the model directly by writing
the SuPi config file. Do this as a collaborative step with the user right after the install
succeeds — do not silently move on.

How the config works (from the package source):
  - The setting lives in a plain JSON file, keyed by section `promptSuggestions` with a
    single `model` field whose value is a canonical `provider/model-id` string, or
    `"disabled"` (the default).
  - **Project scope** file: `.pi/supi/config.json` (relative to the project root).
  - **Global scope** file: `~/.pi/agent/supi/config.json`.
  - Resolution is defaults ← global ← project, so a project value overrides a global one.
  - The chosen `model` **must** be one of PI's scoped enabled models. PI merges
    `enabledModels` from **two** settings files — global (`~/.pi/agent/settings.json`)
    and project (`.pi/settings.json`), with project overriding global — and the picker
    is empty if `enabledModels` is unset in **both** scopes. The chosen model must also
    have an API key configured.

Collaborate with the user through these steps:
  1. Check `enabledModels` in **both** `~/.pi/agent/settings.json` (global) and
     `.pi/settings.json` (project). If neither scope has any enabled models configured,
     **help the user configure them now** — do not just ask and move on:
       a. Ask which providers the user has API keys for (Anthropic, OpenAI, Google, etc.).
       b. Recommend a cheap, fast model for suggestions (suggestions fire after every
          assistant turn, so latency/cost dominate): `anthropic/claude-haiku` or
          `openai/gpt-4o-mini` are the de-facto standard picks for this pattern. Match
          the user's existing provider if they already have one configured.
       c. Write the `enabledModels` array (glob patterns, e.g. `["claude-haiku"]` or
          `["gpt-4o-mini"]`) into the scope the user prefers — default to project-local
          (`.pi/settings.json`) unless they want it global. Merge into the existing JSON;
          do NOT overwrite unrelated keys. Ensure the corresponding API key is set (via
          the provider's env var or PI's auth store) before continuing.
  2. List the currently enabled models (`provider/model-id` form) and ask the user which
     one to use for suggestions. Offer a recommendation if a cheap/fast model is present.
  3. Ask whether to set it **project-locally** (`.pi/supi/config.json`) or **globally**
     (`~/.pi/agent/supi/config.json`). Default to project-local unless the user says
     otherwise.
  4. Write the chosen scope's config file. Merge into any existing object — do NOT
     overwrite unrelated keys. The result should look like:
     ```json
     {
       "promptSuggestions": { "model": "provider/model-id" }
     }
     ```
     Create the parent directory if it does not exist. If the user declines to choose a
     model now, leave the setting at `"disabled"` and tell them they can set it later by
     editing the same file (or installing `npm:@mrclrchtr/supi-settings` for a UI).
  5. Confirm the outcome in the same message that confirms the install, e.g. "Installed.
  Configured prompt suggestions to use anthropic/claude-haiku in `.pi/supi/config.json`."
  Once configured, suggestions appear after each assistant response as dim ghost text
  (accept with →, dismiss with Esc). To change the model later, edit the config file or
  run `/reload` after updating it.

## Optional add-ons (Claude Code feature parity)
The packages above form the core of this distro. The packages below are **optional** —
they mimic additional Claude Code features the core does not cover. Offer them to the user
after the core deploy completes, **one category at a time, asking whether to install each**.
Do not install any of these without explicit per-package confirmation. Apply the same
`pi install -l` + tool-name conflict check (`pi list`) flow as the core packages. If the
user declines a category, skip it and move on; they can install any of these later with
`pi install -l <name>`.

- `npm:pi-mcp-adapter` — **MCP (Model Context Protocol)**: connect pi to hundreds of
  external tools and data sources via MCP servers (Claude Code's primary extensibility
  surface; pi has no built-in MCP). On-demand server discovery so only a single proxy tool
  is advertised until a server is actually used.
- `npm:pi-pledit` — **permission modes**: plan mode and accept-edits mode, inspired by
  Claude Code's Shift+Tab cycle (default → acceptEdits → plan). Controls how aggressively
  the agent modifies code before prompting.
- `npm:pi-memory` — **auto memory**: Claude Code writes notes to itself across sessions
  (build commands, debugging insights, preferences); this brings that to pi with semantic
  search across daily logs, long-term memory, and a scratchpad. Complements the manual
  `AGENTS.md` the distro bundles.
- `npm:pi-rewind` — **checkpoint / undo**: per-tool snapshots with a `/rewind` command and
  Esc+Esc shortcut, plus a redo stack — mirrors Claude Code's automatic edit tracking and
  rewind-to-previous-state.
- `npm:pi-agent-budget` — **cost tracking / budget limits**: real-time spend widget with
  configurable budget caps. The bundled status line shows context % and cache % but not $;
  this fills that gap. (Alternative: `npm:pi-usage-dashboard` for a fuller tokens/cost/
  latency footer.)
- `npm:pi-code-review` — **automated code review**: language-aware review after the agent
  writes or modifies files, mirroring Claude Code's `/code-review` bundled skill.
- `npm:pi-chaos-relay` — **remote control / channels**: drive and answer the agent over
  Telegram and email via a CHAOS relay — Claude Code's "push events into a session"
  pattern. (Telegram-only alternative: `npm:pi-telegram-plus`; Discord alternative:
  `npm:pi-discord-remote`, which auto-creates a channel per session.)
- `npm:@hsingjui/pi-hooks` — **Claude Code hook compatibility**: adapts Claude Code's hook
  configuration format to pi's extension event system, so existing command-hook workflows
  (PreToolUse / PostToolUse / session-start) can be reused with minimal changes. Early
  release; mention the version if the user asks about stability.

**Not covered by any known package** (surface as limitations, not installs):
- *Output styles* (Proactive / Explanatory / Learning system-prompt presets) — no
  dedicated package; `AGENTS.md` and `--append-system-prompt` partially cover this.
- *`/run` + `/verify`* (launch and verify the running app) — no npm package; could be
  authored as a custom project skill if the user wants it.
- *IDE integration* (VS Code inline diffs, @-mentions, JetBrains plugin) — this is a
  separate surface (a VS Code extension, e.g. `pi-vscode-sr`), not a pi package; out of
  scope for this distro to install, but worth mentioning if the user asks.

## Settings (bundled)
`files/settings.json` provides the agent's defaults: high thinking level, one-at-a-time
steering, hidden thinking blocks, and hardware cursor. Merge with any existing `.pi/settings.json`
field-by-field. Auth and model/provider configuration are not part of this distribution —
configure those independently.

## Context
The bundled `.pi/APPEND_SYSTEM.md` is an explore-before-acting working methodology:
investigate before implementing, surface interpretations and tradeoffs, make surgical
changes, keep solutions simple, execute against verifiable goals, and treat documentation
as part of the implementation. Deploy it to `./.pi/APPEND_SYSTEM.md`; pi appends its
content to the **system prompt** at startup (after pi's base identity, tools, and
guidelines, before project context files and skills), giving it stronger adherence than
an `AGENTS.md` context file would. This leaves `./AGENTS.md` free for the user's own
project-specific context. The content is purely additive to pi's default system prompt —
verified against `dist/core/system-prompt.js`: it never redefines the agent's identity,
tool semantics, or built-in guidelines, so there are no conflicts. Note this means
`--no-context-files` (`-nc`) does **not** toggle the methodology off (that flag only
disables `AGENTS.md`/`CLAUDE.md` context files); remove or edit the file to disable it.
