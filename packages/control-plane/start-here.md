# Start Here

The Greenhouse control plane is a read-only MCP server for asking a Greenhouse tenant operational questions from Claude Desktop, Cursor, or another MCP-compatible AI workspace. It is the UNSCOPED operator surface: it reads with the credential's full Harvest permissions and does not enforce per-user scope, so run it only if your own Greenhouse account is already entitled to everything you ask it about. Users who need per-user enforcement want `packages/recruiter-mcp` instead.

Use it for referral SLA misses, recruiter funnel movement, stale candidates by owner, overdue feedback, unfilled openings by function, stage conversion by recruiter, offer draft hygiene, source quality, and bottleneck owners. No dashboard build, no SQL.

## What You Need

- This repository, cloned
- Node.js 22 or newer
- Claude Desktop, Cursor, or another MCP-compatible AI workspace
- Read-only Greenhouse Harvest connection details for your tenant, from whoever administers Greenhouse

If you do not have the Greenhouse connection details, ask your Greenhouse admin for them:

```text
I want to run the read-only Greenhouse control-plane MCP so I can ask operational
questions from Claude, Cursor, or another AI workspace. Can you create a read-only
Harvest credential scoped to my own access?
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

## Handle the credential as a secret

The credential you configure here reads real candidate data with tenant-wide reach. Treat the
config file that holds it as a secret, and never commit it.
