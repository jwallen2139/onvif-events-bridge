/**
 * ONVIF Events service for a daniela-hase/onvif-server virtual camera.
 *
 * onvif-server implements ONVIF Profile S (streaming) only — it advertises no
 * Event service, so UniFi Protect has nothing to put on the camera's timeline.
 * This module adds the event operations Protect actually calls, and is bolted
 * onto the upstream image at build time by patch-onvif-server.js.
 *
 * HTTP surface (served on the virtual camera's own address/port, so Protect
 * finds it at the same place it already talks to the camera):
 *
 *   POST /onvif/events_service
 *        GetEventProperties | CreatePullPointSubscription | PullMessages |
 *        Renew | Unsubscribe | GetServiceCapabilities
 *
 *   GET|POST /trigger/motion?state=on|off
 *        Internal hook the MQTT bridge calls to move the motion level.
 *        Idempotent: only queues a notification when the state actually changes.
 *
 * Responses are hand-written SOAP. That deliberately avoids adding a WSDL to the
 * soap library the upstream image uses, and keeps this module purely additive —
 * nothing in upstream's own request handling changes.
 *
 * Topic emitted is tns1:RuleEngine/CellMotionDetector/Motion carrying a single
 * boolean SimpleItem `IsMotion`. That is the most widely understood third-party
 * motion topic and the one Protect files as a motion event. Override with
 * ONVIF_MOTION_TOPIC if you have reason to.
 *
 * Environment:
 *   ONVIF_MOTION_TOPIC     default tns1:RuleEngine/CellMotionDetector/Motion
 *   ONVIF_SUB_TIMEOUT_SECS default 60 — subscription lifetime advertised to Protect
 */

const url = require('url');

const MOTION_TOPIC = process.env.ONVIF_MOTION_TOPIC ||
    'tns1:RuleEngine/CellMotionDetector/Motion';
const SUB_TIMEOUT_SECS = parseInt(process.env.ONVIF_SUB_TIMEOUT_SECS || '60', 10);
const SUB_TIMEOUT_MS = SUB_TIMEOUT_SECS * 1000;

// Subscriptions we have handed out. id -> { created, termination, queue: [] }
let subscriptions = {};
let motionState = false;
let subCounter = 0;

const NS =
    'xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:wsa="http://www.w3.org/2005/08/addressing" ' +
    'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" ' +
    'xmlns:wstop="http://docs.oasis-open.org/wsn/t-1" ' +
    'xmlns:tev="http://www.onvif.org/ver10/events/wsdl" ' +
    'xmlns:tt="http://www.onvif.org/ver10/schema" ' +
    'xmlns:tns1="http://www.onvif.org/ver10/topics" ' +
    'xmlns:xs="http://www.w3.org/2001/XMLSchema"';

function iso(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function envelope(body) {
    return '<?xml version="1.0" encoding="UTF-8"?>' +
        '<SOAP-ENV:Envelope ' + NS + '><SOAP-ENV:Body>' + body +
        '</SOAP-ENV:Body></SOAP-ENV:Envelope>';
}

function send(response, xml) {
    response.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
    response.end(xml);
}

// Split "tns1:RuleEngine/CellMotionDetector/Motion" into the nested element form
// GetEventProperties' TopicSet requires: <tns1:RuleEngine><CellMotionDetector>...
function topicSetXml() {
    const parts = MOTION_TOPIC.split('/');
    const open = parts.map((p, i) => '<' + p + (i === parts.length - 1 ? ' wstop:topic="true"' : '') + '>').join('');
    const close = parts.slice().reverse().map(p => '</' + p + '>').join('');
    const desc =
        '<tt:MessageDescription IsProperty="true">' +
        '<tt:Source>' +
        '<tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/>' +
        '<tt:SimpleItemDescription Name="RuleName" Type="xs:string"/>' +
        '</tt:Source>' +
        '<tt:Data><tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/></tt:Data>' +
        '</tt:MessageDescription>';
    return open + desc + close;
}

// One NotificationMessage describing the current motion state.
function motionMessage(state, when) {
    return '<wsnt:NotificationMessage>' +
        '<wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">' +
        MOTION_TOPIC + '</wsnt:Topic>' +
        '<wsnt:Message>' +
        '<tt:Message UtcTime="' + iso(when) + '" PropertyOperation="Changed">' +
        '<tt:Source>' +
        '<tt:SimpleItem Name="VideoSourceConfigurationToken" Value="video_source_config"/>' +
        '<tt:SimpleItem Name="RuleName" Value="MotionDetector"/>' +
        '</tt:Source>' +
        '<tt:Data><tt:SimpleItem Name="IsMotion" Value="' + (state ? 'true' : 'false') + '"/></tt:Data>' +
        '</tt:Message></wsnt:Message></wsnt:NotificationMessage>';
}

function getEventProperties() {
    return envelope(
        '<tev:GetEventPropertiesResponse>' +
        '<tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation>' +
        '<wsnt:FixedTopicSet>true</wsnt:FixedTopicSet>' +
        '<wstop:TopicSet>' + topicSetXml() + '</wstop:TopicSet>' +
        '<wsnt:TopicExpressionDialect>http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet</wsnt:TopicExpressionDialect>' +
        '<wsnt:TopicExpressionDialect>http://docs.oasis-open.org/wsn/t-1/TopicExpression/Simple</wsnt:TopicExpressionDialect>' +
        '<tev:MessageContentFilterDialect>http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter</tev:MessageContentFilterDialect>' +
        '</tev:GetEventPropertiesResponse>');
}

// Drop subscriptions Protect has clearly abandoned, so the map can't grow without
// bound over a long uptime. The grace period is deliberately generous (5x the
// advertised lifetime) because a live client refreshes termination on every
// PullMessages and Renew.
function reapSubscriptions() {
    const cutoff = Date.now() - (SUB_TIMEOUT_MS * 5);
    for (const id of Object.keys(subscriptions)) {
        if (subscriptions[id].termination < cutoff) {
            delete subscriptions[id];
            console.log('[EVENTS] reaped abandoned subscription ' + id);
        }
    }
}

function createPullPoint(config) {
    reapSubscriptions();
    const id = 'sub' + (++subCounter);
    const now = Date.now();
    subscriptions[id] = { created: now, termination: now + SUB_TIMEOUT_MS, queue: [] };
    // Seed with the current state so a fresh subscriber learns it immediately
    // instead of waiting for the next edge.
    subscriptions[id].queue.push(motionMessage(motionState, now));
    const addr = 'http://' + config.hostname + ':' + config.ports.server +
                 '/onvif/events_service?sub=' + id;
    console.log('[EVENTS] CreatePullPointSubscription -> ' + id);
    return envelope(
        '<tev:CreatePullPointSubscriptionResponse>' +
        '<tev:SubscriptionReference><wsa:Address>' + addr + '</wsa:Address></tev:SubscriptionReference>' +
        '<wsnt:CurrentTime>' + iso(now) + '</wsnt:CurrentTime>' +
        '<wsnt:TerminationTime>' + iso(now + SUB_TIMEOUT_MS) + '</wsnt:TerminationTime>' +
        '</tev:CreatePullPointSubscriptionResponse>');
}

function pullMessages(subId) {
    const now = Date.now();
    const sub = subscriptions[subId];
    const msgs = sub ? sub.queue.splice(0, 10) : [];
    if (msgs.length) console.log('[EVENTS] PullMessages ' + subId + ' -> ' + msgs.length + ' message(s)');
    if (sub) sub.termination = now + SUB_TIMEOUT_MS;
    return envelope(
        '<tev:PullMessagesResponse>' +
        '<tev:CurrentTime>' + iso(now) + '</tev:CurrentTime>' +
        '<tev:TerminationTime>' + iso(now + SUB_TIMEOUT_MS) + '</tev:TerminationTime>' +
        msgs.join('') +
        '</tev:PullMessagesResponse>');
}

function renew(subId) {
    const now = Date.now();
    if (subscriptions[subId]) subscriptions[subId].termination = now + SUB_TIMEOUT_MS;
    return envelope(
        '<wsnt:RenewResponse>' +
        '<wsnt:CurrentTime>' + iso(now) + '</wsnt:CurrentTime>' +
        '<wsnt:TerminationTime>' + iso(now + SUB_TIMEOUT_MS) + '</wsnt:TerminationTime>' +
        '</wsnt:RenewResponse>');
}

/**
 * Move the motion level. Called by the MQTT bridge via /trigger/motion.
 * Queues one NotificationMessage per live subscriber, but only on an actual
 * change — repeated calls with the same state are no-ops, so the bridge can be
 * as chatty as it likes without flooding Protect.
 */
function setMotion(state) {
    if (state === motionState) {
        return { changed: false, subscribers: Object.keys(subscriptions).length };
    }
    motionState = state;
    const now = Date.now();
    const msg = motionMessage(state, now);
    const ids = Object.keys(subscriptions);
    for (const id of ids) subscriptions[id].queue.push(msg);
    console.log('[EVENTS] motion=' + state + ' queued to ' + ids.length + ' subscriber(s)');
    return { changed: true, subscribers: ids.length };
}

/** Returns true if this module handled the request. */
function handle(request, response, config) {
    const parsed = url.parse(request.url, true);
    const path = parsed.pathname;

    if (path === '/trigger/motion') {
        const state = String(parsed.query.state || '').toLowerCase();
        const on = (state === 'on' || state === 'true' || state === '1');
        const r = setMotion(on);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
            ok: true, motion: motionState, changed: r.changed, subscribers: r.subscribers
        }));
        return true;
    }

    if (path === '/onvif/events_service') {
        let body = '';
        request.on('data', c => { body += c; });
        request.on('end', () => {
            const action = (body.match(
                /<[a-zA-Z0-9]*:?(GetEventProperties|CreatePullPointSubscription|PullMessages|Renew|Unsubscribe|GetServiceCapabilities)\b/
            ) || [])[1] || 'UNKNOWN';
            console.log('[EVENTS] <- ' + action + (parsed.query.sub ? ' (' + parsed.query.sub + ')' : ''));

            if (action === 'GetEventProperties')          return send(response, getEventProperties());
            if (action === 'CreatePullPointSubscription') return send(response, createPullPoint(config));
            if (action === 'PullMessages')                return send(response, pullMessages(parsed.query.sub));
            if (action === 'Renew')                       return send(response, renew(parsed.query.sub));
            if (action === 'Unsubscribe') {
                delete subscriptions[parsed.query.sub];
                return send(response, envelope('<wsnt:UnsubscribeResponse/>'));
            }
            if (action === 'GetServiceCapabilities') {
                return send(response, envelope(
                    '<tev:GetServiceCapabilitiesResponse><tev:Capabilities ' +
                    'WSSubscriptionPolicySupport="false" WSPullPointSupport="true" ' +
                    'WSPausableSubscriptionManagerInterfaceSupport="false" ' +
                    'MaxNotificationProducers="10" MaxPullPoints="10" ' +
                    'PersistentNotificationStorage="false"/></tev:GetServiceCapabilitiesResponse>'));
            }
            console.log('[EVENTS] unhandled request body starts: ' + body.substring(0, 300));
            send(response, envelope('<tev:UnknownResponse/>'));
        });
        return true;
    }
    return false;
}

module.exports = {
    handle,
    setMotion,
    getMotion: () => motionState,
    subscriptionCount: () => Object.keys(subscriptions).length,
    MOTION_TOPIC
};
