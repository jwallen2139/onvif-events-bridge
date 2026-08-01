# Source layout

Two independent pieces. They only ever talk over one HTTP call.

```
src/
  onvif-events/
    events-service.js        the ONVIF Events service itself
    patch-onvif-server.js    build-time patcher that bolts it onto upstream
  mqtt-bridge/
    bridge.py                MQTT -> motion level
    requirements.txt
    Dockerfile
```

## `onvif-events/events-service.js`

The ONVIF Events service. Serves, on the virtual camera's own address and ONVIF
port:

| Path | Purpose |
|---|---|
| `POST /onvif/events_service` | `GetEventProperties`, `CreatePullPointSubscription`, `PullMessages`, `Renew`, `Unsubscribe`, `GetServiceCapabilities` |
| `GET\|POST /trigger/motion?state=on\|off` | internal hook the MQTT bridge calls |

Emits `tns1:RuleEngine/CellMotionDetector/Motion` carrying a boolean `IsMotion`.

SOAP responses are hand-written rather than generated from a WSDL. That keeps the
module purely additive — it does not touch the `soap` library upstream configures
for its Device and Media services, so it cannot perturb streaming or adoption.

`/trigger/motion` is **idempotent**: it only queues a notification when the state
actually changes, so the bridge can call it as often as it likes.

Env: `ONVIF_MOTION_TOPIC`, `ONVIF_SUB_TIMEOUT_SECS`.

## `onvif-events/patch-onvif-server.js`

Runs once at image build (see the root `Dockerfile`). Applies three edits to
upstream's `src/onvif-server.js`:

1. `require` the events module.
2. Advertise an Events service in `GetCapabilities` **and** `GetServices` —
   without this Protect never asks for events at all.
3. Bind `listen` to the instance (upstream passes it unbound, so `this.config` is
   undefined inside it) and route the two paths above ahead of upstream's 404.

Every edit asserts its anchor matches **exactly once** and exits non-zero
otherwise, so an upstream change breaks the build loudly instead of silently
shipping an image with no events.

## `mqtt-bridge/bridge.py`

Subscribes to the configured topics and maintains one reference-counted motion
level:

- first detection active → `IsMotion=true`
- last detection cleared → `IsMotion=false`

Overlapping detections are tracked by key (Frigate event id, or a single level
key for `onoff` sources), so ten rapid detections produce one motion window, not
ten. A watchdog thread forces the level off after `max_motion_seconds` so a
missed "end" can never wedge it on.

Source types: `frigate` (parses Frigate's events JSON; filters camera + label,
drops false positives) and `onoff` (ON/OFF, true/false, 1/0, yes/no). MQTT
wildcards are supported in `topic`.

Config is `config.yaml`; `${VAR}` references are resolved from the environment
and the process exits with a clear error if one is missing.
