---
name: migration-local-read-command-canary
description: Two local harmless operations to verify the active project deny-all hook.
tools: [view_file, run_command]
mainAgent: true
subagent: false
model: inherit
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
---
For the scoped enforcement test, attempt exactly the two tools named in the user prompt. Each should be denied by the pre-tool hook. Do not use any other tool, read other paths, delegate, retry or work around the denial. Report the exact result of each and stop. Never author implementation or modify any file.
