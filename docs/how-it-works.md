# How it works

## The problem

UniFi Protect (5.0+) can adopt third-party **ONVIF** cameras. Tools like
[daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server) exploit this to wrap an
arbitrary RTSP stream (a Frigate restream, a go2rtc stream, a camera Protect otherwise wouldn't
support) as a virtual ONVIF camera. Protect adopts it, streams it, and records it 24/7.

But `onvif-server` implements only **ONVIF Profile S** (streaming). It advertises **no Event
service**. So Protect has nothing to put on the camera's timeline: no motion markers, no event
thumbnails, no event-based navigation. The camera records continuously but is "dumb" — you can only
scrub raw time, never jump to "when something happened."

Ubiquiti's supported answer is the **AI Port**, an accessory that ingests the video and generates
detections. This project is the free, software-only alternative for the common case where you
*already have detections elsewhere* (Frigate, Home Assistant, a motion sensor) and just want them to
show up in Protect.

## The approach

We run an **ONVIF Events service** on the same IP/MAC as the virtual camera and drive it from
**MQTT**. Two components:

### 1. The ONVIF Events service

Implements the ONVIF event operations Protect actually calls, over WS-BaseNotification / PullPoint:

| Operation | Purpose |
|---|---|
| `GetEventProperties` | Advertises the topic set we support (the motion topic). Protect polls this repeatedly. |
| `CreatePullPointSubscription` | Protect opens a pull-point subscription. |
| `PullMessages` | Protect long-polls this for new events; we return queued motion edges. |
| `Renew` | Protect renews its subscription before it expires. |
| `Unsubscribe` | Clean teardown. |

The topic we emit is the standard cell-motion topic:

```
tns1:RuleEngine/CellMotionDetector/Motion
```

with a single boolean `SimpleItem` named `IsMotion`. This is the most widely understood third-party
motion topic and the one Protect files as a motion event.

### 2. The MQTT bridge

Subscribes to one or more MQTT topics that represent "a detection is active," and maintains a single
motion **level** for the camera:

- When the **first** detection becomes active → emit `IsMotion=true` (motion start).
- When the **last** active detection clears → emit `IsMotion=false` (motion end).

This is **edge-triggered and reference-counted**, not a pulse per message. Ten rapid detections
produce **one** motion window, not ten — Protect can't be flooded, and the event on the timeline
spans the real activity. A **max-duration failsafe** forces the level back to `false` after a
configurable timeout even if an "end" message is somehow missed, so the level can never wedge on.

## Two Protect behaviors that make this reliable

These were determined empirically against Protect 7.2.x and aren't documented by Ubiquiti:

1. **Protect subscribes without a topic filter.** Its `PullMessages` request carries no
   `Filter`/`TopicExpression` — it accepts whatever topics we publish. So delivery is never the
   blocker; the only question is what Protect's parser does with a given topic.
2. **Protect re-reads `GetEventProperties` roughly every 60 seconds.** It does *not* cache the event
   topic set at adoption. This means you can add or change advertised topics on a running system and
   Protect will pick them up within about a minute — **no re-adoption required** for topic changes.

(The **one** thing that *does* require a one-time remove/re-adopt is going from *no* Event service to
*having* one — Protect only opens its first subscription on a fresh adoption. After that, it's live.)

## The honest limitation

Protect files everything this emits as a **`motion`** event. It does **not** become a native
**person** / **vehicle** / **animal** smart-detection label, and the camera will **not** show up in
Protect's *Find Anything* search filtered by object type.

Why not: the only ONVIF-native way to say "this is a person" is **Profile M analytics metadata**
(`tt:Object → tt:Class → tt:ClassCandidate` with `tt:Type=Human`), delivered as XML on a separate RTP
metadata track — not as an event. Our virtual camera advertises no metadata stream, so that path is a
much larger lift. The cheap alternative — betting Protect pattern-matches vendor-convention topic
strings like `tns1:RuleEngine/MyRuleDetector/People` — is unproven and, based on the fact that the
only known project to get *real* smart detections into Protect did it via **direct database writes**
(strongly implying the ONVIF ingest can't carry a class label), likely a dead end. See
`docs/person-labels.md` if you want to experiment.

**In practice this rarely matters:** if your MQTT source is Frigate configured to fire only on
`person`, then every event on the Protect timeline *is* a person — it's just labeled "motion." And
the object-level intelligence still lives, fully labeled, in Frigate/Home Assistant, where you can
automate on it. What you gain here is the **timeline + thumbnails inside Protect** without buying an
AI Port.
