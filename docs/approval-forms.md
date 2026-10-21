# Approval form handling

`DISCORD_APPROVAL_POLICY=allow` accepts command, file, permission and MCP URL/empty-form approvals. Empty approval forms may include string `title`, `description`, `$schema`, `$id` and `$comment` fields. These fields must not turn an approval into an automatic cancellation.

The default `ask` policy delivers external MCP empty-form approvals to the original owner, including unknown connectors or risk metadata. A generated button answers the exact request occurrence. Existing saved app grants and low-risk local-tool access retain their behavior. Value-bearing forms are delivered as [MCP input prompts](mcp-form-input.md) under both policies and remain pending until the owner replies. Invalid input is reported without cancelling the request. The bridge never synthesizes answers.

Run the approval regression gate with:

```powershell
node tools/run-tests.mjs --profile approval-forms
npm run build
```

The gate covers annotation parsing, actual resident responses, prompt delivery and receipt reuse, original owner/generation/occurrence checks, all button choices and production worker startup. The broader `persistent-receiver-workflow.test.ts` separately contains an existing unconditional failed cleanup-qualification assertion; this approval gate does not certify that unfinished component.
