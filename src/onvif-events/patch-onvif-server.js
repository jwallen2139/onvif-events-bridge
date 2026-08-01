#!/usr/bin/env node
/**
 * Bolts the ONVIF Events service onto an unmodified daniela-hase/onvif-server.
 *
 * Run at image build time (see the Dockerfile). It applies three surgical edits
 * to upstream's src/onvif-server.js — it never rewrites the file, so upstream can
 * be bumped and this will either still apply or fail loudly.
 *
 *   1. require() the events module.
 *   2. Advertise an Events service in GetCapabilities and GetServices, so Protect
 *      knows to look for one. Without this Protect never asks.
 *   3. Bind `listen` to the server instance (upstream passes it unbound, so
 *      `this.config` is undefined inside it) and route /onvif/events_service and
 *      /trigger/motion before upstream's 404 fallback.
 *
 * Every edit asserts its anchor is unique first. If upstream changes shape the
 * build fails with a clear message rather than silently producing an image with
 * no event support.
 *
 * Usage: node patch-onvif-server.js /app/src/onvif-server.js
 */

const fs = require('fs');

const target = process.argv[2];
if (!target) {
    console.error('usage: patch-onvif-server.js <path to onvif-server.js>');
    process.exit(1);
}

let s = fs.readFileSync(target, 'utf8');
const before = s.length;

function replaceOnce(haystack, needle, replacement, label) {
    const n = haystack.split(needle).length - 1;
    if (n !== 1) {
        console.error(`PATCH FAILED: anchor "${label}" matched ${n} times (expected exactly 1).`);
        console.error('The upstream onvif-server source has changed shape; this patch needs updating.');
        process.exit(1);
    }
    return haystack.replace(needle, replacement);
}

// --- 1. require the events module -------------------------------------------
s = replaceOnce(s,
    "const os = require('os');",
    "const os = require('os');\nconst eventsService = require('./events-service.js');",
    'require block');

// --- 2a. advertise Events in GetCapabilities ---------------------------------
const capAnchor = '                        return response;';
s = replaceOnce(s, capAnchor,
`                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Events') {
                            response.Capabilities['Events'] = {
                                XAddr: \`http://\${this.config.hostname}:\${this.config.ports.server}/onvif/events_service\`,
                                WSSubscriptionPolicySupport: false,
                                WSPullPointSupport: true,
                                WSPausableSubscriptionManagerInterfaceSupport: false
                            };
                        }

` + capAnchor,
    'GetCapabilities return');

// --- 2b. advertise Events in GetServices -------------------------------------
{
    const i = s.indexOf('GetServices:');
    if (i < 0) { console.error('PATCH FAILED: GetServices not found'); process.exit(1); }
    const m = /\n\s*\]/.exec(s.slice(i));
    if (!m) { console.error('PATCH FAILED: GetServices service array end not found'); process.exit(1); }
    const j = i + m.index;
    const entry = `,
                                {
                                    Namespace : 'http://www.onvif.org/ver10/events/wsdl',
                                    XAddr : \`http://\${this.config.hostname}:\${this.config.ports.server}/onvif/events_service\`,
                                    Version : {
                                        Major : 2,
                                        Minor : 5,
                                    }
                                }`;
    s = s.slice(0, j) + entry + s.slice(j);
}

// --- 3a. bind listen so this.config is reachable inside it -------------------
s = replaceOnce(s,
    'this.server = http.createServer(this.listen);',
    'this.server = http.createServer(this.listen.bind(this));',
    'createServer');

// --- 3b. route events + trigger before upstream's 404 ------------------------
const notFound = `        } else {
            response.writeHead(404, {'Content-Type': 'text/plain'});`;
s = replaceOnce(s, notFound,
`        } else if (eventsService.handle(request, response, this.config)) {
            // handled by the ONVIF Events service
` + notFound,
    '404 fallback');

fs.writeFileSync(target, s, 'utf8');
console.log(`patched ${target}: ${before} -> ${s.length} bytes (ONVIF Events service enabled)`);
