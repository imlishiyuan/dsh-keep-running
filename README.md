# dsh-keep-running

**English** | [简体中文](README.zh.md)

![npm version](https://img.shields.io/npm/v/dsh-keep-running)
![license](https://img.shields.io/npm/l/dsh-keep-running)

A watchdog plugin for DeepSeek Harness: on a **quota / rate-limit (HTTP 429)** error, it automatically creates a fixed-interval scheduled task that keeps delivering a "continue the task" prompt until it succeeds or you take over.

> **Depends on the official scheduled-task plugin.** This plugin persists schedules via the events provided by `@deepseek-ai/dsh-schedule`, so **you must mount it first** — otherwise schedule creation is silently dropped (see [Dependency](#dependency)).

## Features

- **Auto-resume** — on quota exhaustion (429) it creates an `every` schedule that periodically re-sends a "continue" prompt;
- **Breakpoint capture** — records the most recent real user message so it can resume context;
- **Only fires when idle** — the schedule runtime delivers it while the agent is **idle**, so it never interrupts your manual work;
- **Stops on success** — when any turn closes normally (quota recovered) the schedule is deleted automatically;
- **Two commands** — `/keep-running list` and `/keep-running cancel <id>` (see [Commands](#commands)).

## Dependency

> ⚠️ **You must** mount the official scheduled-task plugin `@deepseek-ai/dsh-schedule`.

keep-running persists schedules via `agent.session.append('schedule/change', ...)`. The `schedule/change` event type and its runtime are **provided by `@deepseek-ai/dsh-schedule`**. If you mount only keep-running without it, `append` is **rejected by the Session as an unknown event type** → keep-running **fails silently** and no schedule is created (the most common "it didn't work" cause).

## Quick Start

1. Install the plugin:

```sh
# A. Official command (backs onto pnpm; install pnpm first)
npm i -g pnpm
dsh plugin --profile web add dsh-keep-running

# B. Install with npm directly into the profile directory
cd ~/.dsh/profiles/web    # Windows: C:\Users\<you>\.dsh\profiles\web
npm install dsh-keep-running --save
```

And install its dependency plugin into the same profile:

```sh
cd ~/.dsh/profiles/web
npm install @deepseek-ai/dsh-schedule --save
```

2. **Mount it in the profile `cordis.patch.yml`.** To *load* a plugin you must
   **insert** it, not target an id (a bare `- id: keep-running` warns `entry
   "keep-running" not found` and does nothing). **`dsh-schedule` must come
   before `keep-running`**:

```yaml
- insert:
    - id: dsh-schedule
      name: '@deepseek-ai/dsh-schedule'
    - id: keep-running
      name: 'dsh-keep-running'
      config:
        intervalSeconds: 1800        # task interval (seconds), min 300
        continuePrompt: '请继续完成之前未完成的任务：{{task}}'
        quotaKeywords: []            # empty = HTTP 429 only; add vendor terms as needed
```

3. Restart `dsh web` and start a new session.

## Configuration

| Key | Default | Description |
|---|---|---|
| `intervalSeconds` | `1800` | Task interval (seconds); the "continue" prompt is re-sent each tick. Minimum 300 |
| `continuePrompt` | `请继续完成之前未完成的任务：{{task}}` | Prompt delivered each tick; `{{task}}` is replaced by the breakpoint (most recent user message, truncated to 200 chars) |
| `quotaKeywords` | `[]` | Quota keywords (lowercase). `[]` means **HTTP 429 only**; add vendor terms to adapt other providers |

### quotaKeywords

Default `[]` = only HTTP 429 (covering `RATE_LIMIT` / `QUOTA` codes and quota signals in code/message). For multi-vendor setups, add each provider's error terms:

```yaml
config:
  quotaKeywords: ['quota exceeded', 'requests limit', '5-hour usage quota']
```

## Commands

The plugin registers its own namespaced `/keep-running` command (it does not collide with a future `/schedule`):

- `/keep-running list` — list all **active** keep-running tasks in the **current** session (id, interval, breakpoint, next tick).
- `/keep-running cancel <id>` — cancel the task with that id (id from the `list` output).

The command reads the session's `schedule/change` events directly, **without needing the model**, so it works even while quota is exhausted.

## How it works

1. Listen to `agent/error`: a quota 429 is rejected the moment the request is sent, so it flows through `step()`→`turn()`'s `catch`→`throwError()` and **never reaches** the `agent/request-error` waterfall (that fires only on a streaming `error` finish). The event that actually fires is the global `agent/error`, whose `payload.error.failure` is the `LlmFailure` carrying `status`.
2. `isQuotaError` detects quota: HTTP 429, stable codes (`RATE_LIMIT` / `QUOTA`), or quota signals in code/message, plus `quotaKeywords`.
3. `ensureWatchdog` appends `schedule/change` (`kind: 'every'`) to create the schedule; an `active` guard prevents duplicates, and a session scan recovers across process restarts.
4. Each tick delivers `continuePrompt`; when any turn closes normally (quota recovered) `turn-stopping` → `stopWatchdog` deletes it.

## Use cases

- A long task hits a quota ceiling mid-run (e.g. a 5-hour usage quota) and you want it to resume automatically;
- You don't want to manually restart the task after quota recovers;
- You don't want to be interrupted while working manually (delivery happens only while the agent is idle);
- You inspect or cancel tasks anytime with `/keep-running list` / `cancel`.

## Development

### Build

```sh
npm install
npm run build      # compiles src → lib/index.js
```

### Mount locally

During development you can mount the compiled output via a `file://` URL (still using the `insert:` form):

```yaml
- insert:
    - id: dsh-schedule
      name: '@deepseek-ai/dsh-schedule'
    - id: keep-running
      name: 'file:///D:/ui-workspace/dsh-keep-running/lib/index.js'
      config:
        intervalSeconds: 1800
```

Adjust the URL to your checkout path.

### Restart

```sh
dsh web
```

### Verify

Confirm both plugins are mounted:

```sh
# Windows
dsh web --dump-config | findstr /C:"keep-running" /C:"dsh-schedule"

# Linux / macOS
dsh web --dump-config | grep -E "keep-running|dsh-schedule"
```

Seeing the `keep-running` and `dsh-schedule` rows with no `not found` warning means they are mounted.

## License

[Apache-2.0](LICENSE)
