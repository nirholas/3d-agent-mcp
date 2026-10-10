// MCP Apps (SEP-1865) UI resource wiring for the agent_hire provenance receipt.
//
// agent_hire is an MCP App: it declares a ui:// resource (via _meta.ui.resourceUri
// on the tool) that the host renders in a sandboxed iframe — the transaction /
// provenance card showing who was hired, their reputation, the USDC settled, the
// real settlement reference, and the delegated result. This module owns the
// resource URI, MIME type, the CSP the sandbox needs, and reading the prebuilt
// HTML bundle (app/build.mjs writes it here).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const UI_RESOURCE_URI = 'ui://three-ws-commerce/hire-receipt.html';

// The MCP Apps MIME type — identifies an HTML payload as an interactive app
// resource per the MCP Apps spec.
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';

// Origins the sandboxed iframe is allowed to reach. The receipt is fully
// self-contained (inlined JS, no model/asset fetches) and only ever links out
// to the Solana explorer for the settlement tx — so the only grant needed is
// the explorer the "view tx" link targets. No token/coin endpoints.
export const UI_CSP = {
	connectDomains: [],
	resourceDomains: ['https://solscan.io'],
};

// _meta.ui object placed on the UI resource (carries the CSP grant).
export const UI_RESOURCE_META = { ui: { csp: UI_CSP } };

// _meta.ui object placed on the agent_hire tool (links it to the UI resource).
export const UI_TOOL_META = { ui: { resourceUri: UI_RESOURCE_URI } };

const here = dirname(fileURLToPath(import.meta.url));
let cachedHtml = null;

// Read the prebuilt, self-contained card HTML (app/build.mjs writes it here).
export function loadReceiptHtml() {
	if (cachedHtml == null) {
		cachedHtml = readFileSync(join(here, 'ui', 'commerce-receipt.html'), 'utf8');
	}
	return cachedHtml;
}
