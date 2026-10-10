# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`@three-ws/mcp-server` v1.2.3. MCP tools for the 3d-agent stack — free text→3D (TRELLIS) plus paid 3D/avatar/rigging, pump.fun snapshots, ERC-8004 reputation, vanity grinder. Paid calls settled in USDC via x402.

A Model Context Protocol server. Run it over stdio from any MCP client.

## Use it

```bash
npx -y @three-ws/mcp-server
```

Full usage, tool list and configuration are in [README.md](README.md). Machine-readable summaries: [llms.txt](llms.txt) and [llms-full.txt](llms-full.txt).

## Develop

```bash
npm install
node --check src/index.js
```

Scripts:
- `npm run start`: `node src/index.js`
- `npm run build:ui`: `node app/build.mjs`
- `npm run inspect`: `npx -y @modelcontextprotocol/inspector node src/index.js`
- `npm run prepublishOnly`: `node -e "import('./src/index.js').catch(e => { if (!e.message.includes('facilitator')) throw e })" 2>/dev/null; echo 'package check ok'`

## Conventions

- ES modules, Node >=20.
- Read-only by default. Anything that signs, spends or sends must be an explicit, separately named tool or option, and must never be inferred from untrusted text (token names, memos, listings).
- Never commit credentials. Configuration comes from environment variables documented in the README.
- Keep changes small and covered by a test next to the code they change.

## Source of truth

This repository is a generated mirror of `packages` in https://github.com/nirholas/three.ws. Open issues here; send substantial changes as a pull request here or upstream.
