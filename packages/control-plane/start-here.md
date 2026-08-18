# Start Here

The Greenhouse control plane is a read-only MCP server for recruiting teams that want to ask Greenhouse questions from Claude Desktop, Cursor, or another MCP-compatible AI workspace.

Use it for referral SLA misses, recruiter funnel movement, stale candidates by owner, overdue feedback, unfilled openings by function, stage conversion by recruiter, offer draft hygiene, source quality, and bottleneck owners. No dashboard build, no SQL.

## What You Need

- This repository, cloned
- Node.js 18 or newer
- Claude Desktop, Cursor, or another MCP-compatible AI workspace
- Read-only Greenhouse Harvest connection details from your Greenhouse admin

If you do not have the Greenhouse connection details, send this to your Greenhouse admin:

```text
I want to run a read-only MCP server so our recruiting team can ask operational
questions from Claude, Cursor, or another AI workspace. Can you create read-only
Greenhouse Harvest connection details for my internal use?
```

## Install

From the repository root:

```bash
npm ci
npm run build
```

## Connect It

Paste this setup block into Claude Desktop, Cursor, or your MCP client of choice. Replace the path with your checkout and only the values that say `replace-with...`.

```json
{
  "mcpServers": {
    "greenhouse-control-plane": {
      "command": "node",
      "args": ["/path/to/greenhouse-mcp/packages/control-plane/dist/index.js"],
      "env": {
        "GREENHOUSE_CLIENT_ID": "replace-with-client-id",
        "GREENHOUSE_CLIENT_SECRET": "replace-with-client-secret"
      }
    }
  }
}
```

Restart your MCP client after saving the config.

## First Prompts To Try

```text
What Greenhouse tools do you have available?
```

```text
Tell me how many scorecards have been overdue for the past month, grouped by owner if possible.
```

```text
Find referral candidates from the last month who were not actioned within three days. Define actioned using stage movement, notes, interviews, or other Greenhouse activity you can inspect, and show your assumptions.
```

```text
Show funnel movement for recruiters X, Y, and Z over the last two weeks by stage, with candidate counts and obvious bottlenecks.
```

## Beyond the control plane

This package is the unscoped operator surface. The per-user, permission-enforced
deployment — the scoped recruiter server and the paired preview/apply write plane —
lives in `packages/recruiter-mcp` and `packages/action-mcp`; the repository README
covers when to reach for each.

## License

MIT — see the LICENSE file at the repository root.
