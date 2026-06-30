// Build the agent_hire provenance receipt MCP App into one self-contained HTML.
//
// Bundles app/commerce-receipt.js (which imports the MCP Apps SDK) with esbuild
// and inlines it into the card HTML. The result, src/ui/commerce-receipt.html,
// is committed and shipped in the npm package — the stdio server serves it as
// the ui:// resource that agent_hire links via _meta.ui.resourceUri.
//
// Run: node mcp-server/app/build.mjs

import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const result = await build({
	entryPoints: [join(here, 'commerce-receipt.js')],
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'es2020',
	minify: true,
	write: false,
	legalComments: 'none',
});
const appJs = result.outputFiles[0].text;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>three.ws agent hire receipt</title>
<style>
  :root {
    --bg: #0b0b12; --panel: #14141f; --line: #24243a; --txt: #ececf5;
    --muted: #9a9ab2; --accent: #6a5cff; --good: #2fd27a; --mid: #f2b441; --low: #ff5d5d;
  }
  :root[data-theme="light"] {
    --bg: #f5f5fa; --panel: #ffffff; --line: #e4e4ee; --txt: #1a1a26;
    --muted: #6a6a82; --accent: #5a4cf0;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--txt);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }
  #status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--muted); font-size: 14px; padding: 24px; text-align: center; }
  #card { max-width: 520px; margin: 0 auto; padding: 18px; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .receipt-tag { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: var(--accent); }
  .head h1 { font-size: 18px; margin: 0; font-weight: 700; flex: 1; }
  .badge { font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
    border: 1px solid var(--line); }
  .rep-high { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); }
  .rep-mid  { color: var(--mid);  border-color: color-mix(in srgb, var(--mid) 45%, transparent); }
  .rep-low  { color: var(--low);  border-color: color-mix(in srgb, var(--low) 45%, transparent); }
  .rep-unknown { color: var(--muted); }
  #agent-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  #rep-detail { font-size: 12px; color: var(--muted); margin: 2px 0 14px; }
  .match { margin: 0 0 16px; }
  .match-track { height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
  #match-bar { height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent), #9b6cff);
    border-radius: 999px; transition: width .5s ease; }
  #match-pct { font-size: 12px; color: var(--muted); margin-top: 5px; display: block; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line);
    border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin-bottom: 14px; }
  .cell { background: var(--panel); padding: 11px 13px; }
  .cell .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .cell .v { font-size: 16px; font-weight: 700; margin-top: 3px; }
  .cell .v small { font-size: 12px; font-weight: 600; color: var(--muted); }
  #settle-row { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 10px 13px; margin-bottom: 14px; font-size: 13px; }
  #settle-row .k { color: var(--muted); }
  #settle-ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #settle-link { margin-left: auto; color: var(--accent); text-decoration: none; font-weight: 600; }
  #settle-link:hover, #settle-link:focus-visible { text-decoration: underline; }
  .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
  #task { font-size: 13px; color: var(--txt); margin-bottom: 14px; }
  #response-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 13px; }
  #response { font-size: 13px; line-height: 1.5; white-space: pre-wrap; margin: 0; max-height: 240px; overflow: auto; }
  a:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { #match-bar { transition: none; } }
</style>
</head>
<body>
<div id="status">Loading hire receipt…</div>
<main id="card" hidden aria-live="polite">
  <div class="head">
    <span class="receipt-tag">Hired &amp; paid</span>
    <h1 id="agent-name">Agent</h1>
    <span id="rep-badge" class="badge rep-unknown">unrated</span>
  </div>
  <div id="agent-id"></div>
  <div id="rep-detail"></div>

  <div class="match">
    <div class="match-track"><div id="match-bar"></div></div>
    <span id="match-pct">task fit n/a</span>
  </div>

  <div class="grid">
    <div class="cell"><div class="k">Paid</div><div class="v"><span id="amount">—</span> <small id="asset">USDC</small></div></div>
    <div class="cell"><div class="k">Settled on</div><div class="v" style="font-size:14px"><span id="network">Solana</span></div></div>
    <div class="cell"><div class="k">Latency</div><div class="v" id="latency">—</div></div>
    <div class="cell"><div class="k">Scheme</div><div class="v" style="font-size:14px">x402 exact</div></div>
  </div>

  <div id="settle-row" hidden>
    <span class="k">Settlement</span>
    <span id="settle-ref">—</span>
    <a id="settle-link" href="#" target="_blank" rel="noopener noreferrer" hidden>view tx ↗</a>
  </div>

  <div class="label">Task</div>
  <div id="task"></div>

  <div id="response-wrap" hidden>
    <div class="label">Result</div>
    <pre id="response"></pre>
  </div>
</main>
<script>${appJs}</script>
</body>
</html>`;

const outDir = join(pkgRoot, 'src', 'ui');
await mkdir(outDir, { recursive: true });
const out = join(outDir, 'commerce-receipt.html');
await writeFile(out, html, 'utf8');
console.log(
	`commerce-receipt.html written (${(html.length / 1024).toFixed(1)} KB, app bundle ${(appJs.length / 1024).toFixed(1)} KB)`,
);
