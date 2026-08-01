# Troubleshooting

Work top-to-bottom; each check narrows where the chain is broken:

```
MQTT source → mqtt-bridge (motion level) → onvif-events service → Protect PullMessages → timeline event
```

## Protect never subscribes (no PullMessages in the logs)

- **You didn't re-adopt after adding the events service.** Protect only opens its first subscription
  on a fresh adoption. Remove + re-adopt the camera once (archive recordings). See
  [unifi-protect-setup.md](unifi-protect-setup.md#2-one-time-remove--re-adopt).
- **The events service isn't answering on the camera's IP.** Protect calls the ONVIF service at the
  camera's address. If your events service is on a different IP/port than the virtual camera, Protect
  won't reach it. Confirm the service is bound to the macvlan address `onvif-server` uses. Test from a
  *different* machine (the Docker host can't reach its own macvlan children — that's expected).
- **`GetEventProperties` isn't being served.** Check the service logs — Protect polls
  `GetEventProperties` every ~60s. If you don't see those calls, Protect isn't talking to the service
  at all (network/IP problem, above).

## Protect subscribes and pulls, but no events appear on the timeline

- **The motion level never actually changed.** Check the bridge logs for `IsMotion=true`/`false`
  transitions during your test. If the level didn't move, the problem is upstream (MQTT), not Protect.
- **The level is stuck ON.** If a previous detection never got its "end"/`false` and there's no new
  OFF→ON edge, Protect sees no *new* event. The bridge's **max-duration failsafe** exists for exactly
  this — confirm it's enabled and the timeout is sane. A stuck-on level is the single most common
  "it worked once then stopped" cause.
- **Fire a manual edge to isolate Protect.** Publish a synthetic `true` then `false` directly (bypass
  the real detector). If Protect shows an event, the ONVIF side is perfect and the issue is your
  detection source. If it doesn't, the issue is the ONVIF topic/payload.

## It worked, then stopped after a while

- **Subscription lapsed.** Protect renews its subscription periodically (`Renew`). If your service
  doesn't handle `Renew`, the subscription expires and events silently stop. Confirm `Renew` is
  implemented and returning success. Protect does re-subscribe on its own eventually, but a proper
  `Renew` keeps it continuous.
- **Motion level wedged ON** (see above) — the failsafe is the fix.

## Events fire but are labeled "motion," not "person"

**This is expected and not a bug.** Protect files third-party ONVIF events as motion; it does not
apply smart-detection object labels to them. If your source (e.g. Frigate) only fires on people, the
events *are* person-triggered — Protect just labels them "motion," and the camera won't appear in
*Find Anything*'s person filter. Native person labels for third-party cameras require an AI Port. See
[how-it-works.md](how-it-works.md#the-honest-limitation).

## Detection source (Frigate) tuning

- **Brief events don't fire / quick walk-bys missed:** your detector may be dropping frames. On a
  loaded CPU detector this is common; an accelerated detector (Coral, or OpenVINO on an Intel iGPU)
  with low inference latency catches brief appearances that a saturated CPU detector misses.
- **Audio detection (e.g. crying) doesn't fire:** Frigate's `min_volume` gate may be too high.
  Measure your ambient RMS in Frigate and set `min_volume` just above it. Defaults are often far too
  high for a quiet room.
- **Too many false events:** raise the detector's `min_score`/threshold, add a Frigate zone so only
  the relevant area counts, or (audio) raise `min_volume` above the false-positive level.

## Flood of notifications / events

- The bridge is reference-counted, so the *Protect* side won't flood. If you're getting notification
  spam downstream (e.g. in Home Assistant), add a cooldown in **that** automation, not here — the
  bridge intentionally reflects real activity windows.
