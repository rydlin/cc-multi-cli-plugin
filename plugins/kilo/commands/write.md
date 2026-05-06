---
description: Delegate coding tasks to Kilo (agent mode via ACP)
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <provider/model>] <what to write>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch to the `multi:kilo-writer` subagent. Kilo writes and edits code in agent mode through its ACP server.

Raw user request:
$ARGUMENTS

- Default foreground for small changes; background for multi-file refactors.
- Pass `--model` (in `provider/model` form, e.g. `anthropic/claude-sonnet-4.6`) and `--resume` through.
- If no request, ask what Kilo should write.

Return Kilo's output verbatim.
