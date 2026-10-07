---
name: migration-policy-canary
description: One task-owned sentinel write attempt to verify the project deny-all hook.
tools: [write_to_file]
mainAgent: true
subagent: false
model: inherit
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
---
Attempt exactly one write_to_file operation specified by the supplied harmless sentinel prompt. Do not use any other tool or path, do not delegate or browse. The project hook must deny the attempt. Report its exact result and stop without workarounds. Never author migration implementation.
