# dsh-managed-tool-executions

Ports the Pi fork patches `patch/managed-tool-executions` and
`patch/managed-tool-abort-drain` to DeepSeek Harness 0.1.7-rc.2 (dsh-TUI 0.11.1).

Two pieces:

1. **Detach thresholds (config only).** `cordis.patch.yml` sets the bash
   executor's `timeoutMs`/`maxTimeoutMs` to 600000, so an AI-invoked `bash`
   call with no timeout — or one asking for more than 1200s — stops waiting
   after 600s and continues as a managed background job (DSH's
   `promoteOnTimeout` with `onExpiry: "none"`). This matches Pi's
   `detachAfterSeconds: 600` + ">1200s counts as unmanaged-timeout" rules via
   DSH's `min(requested ?? default, max)` clamp.
2. **`tool_task` tool (plugin).** Model-facing `list` / `info` / `wait` /
   `cancel` over `ctx.jobs`, with `wait` bounded to 1800s — the Pi `tool_task`
   surface. Job output is collected through the same consuming cursor as
   `job_output`, so output is read exactly once and an awaited settlement is
   not re-notified.

See [BEHAVIOR.md](BEHAVIOR.md) for the full parity checklist, including the
three honest gaps (explicit-timeout kill semantics, per-tool detach rules for
arbitrary tools, core-owned promote text).

## Install

```sh
node ~/.local/share/dsh/npm/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile tui add file:/path/to/dsh-managed-tool-executions-0.1.0.tgz --ignore-scripts
```

The package's `dsh.bundle.patch` enables the plugin row and the executor
thresholds automatically.

## Test

```sh
pnpm install --ignore-scripts
node --test test/*.test.mjs
```

## Licence

MIT, Copyright Xiangzhe. Ported from the author's own Pi fork patches.
