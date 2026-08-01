# Can these become native "person" labels?

Short answer: **probably not, but it's cheap to test.** This page exists because
[how-it-works.md](how-it-works.md#the-honest-limitation) promises the detail.

Protect files everything this project emits as a **motion** event. It does not
become a native person/vehicle/animal smart-detection label, and the camera does
not appear in *Find Anything* filtered by object type.

## What ONVIF offers

| Topic | Carries | Notes |
|---|---|---|
| `tns1:RuleEngine/CellMotionDetector/Motion` | `IsMotion` (bool) | What we emit. Binary only — there is nowhere to put a class, so person labelling through this topic is structurally impossible. |
| `tns1:RuleEngine/ObjectDetector/Object` | `ObjectId` | "An object was detected." The class is usually not in the event body. |
| `tns1:RuleEngine/MyRuleDetector/PeopleDetect` | vendor `IsPeople` bool | Vendor convention (Hikvision/Dahua-ish), not core spec. The most widely deployed person-ish topic, so the most plausible string for a VMS to special-case. |
| `tns1:RuleEngine/FieldDetector/ObjectsInside` | `ObjectId`, sometimes `ClassName` | Zone intrusion; some vendors attach a class. |
| **ONVIF Profile M** | `tt:Object → tt:Class → tt:ClassCandidate` with `tt:Type=Human` | The actual standardized answer — and the problem below. |

The ONVIF-correct way to say "this is a person" is **Profile M analytics
metadata**, delivered as Scene Description XML on a **separate RTP metadata
track** — not as an event. A virtual camera built on `onvif-server` advertises no
metadata stream at all, so supporting Profile M properly means advertising a
metadata profile and multiplexing XML into RTP. That is a large lift.

The cheap alternative is to bet that Protect pattern-matches vendor-convention
topic *strings*, and emit one of rows 2–4 above.

## Why it probably won't work

The strongest evidence is that
[danielwoz/ubiquiti-protect-onvif-event-listener](https://github.com/danielwoz/ubiquiti-protect-onvif-event-listener)
exists at all. It listens to ONVIF events and then writes person/vehicle/animal/
package rows **directly into Protect's PostgreSQL**, bypassing the ONVIF ingest
entirely — and it does the same for *first-party* UniFi cameras that lack on-board
AI. Someone who understood the system well enough to reverse-engineer its schema
chose the database. That is what you do when the ingest path has no hook.

Ubiquiti's own documentation is consistent with this: smart detections on
third-party cameras are what the **AI Port / AI Key** are sold to provide.

## Why it's still cheap to try

Two behaviours of Protect's ONVIF ingest, measured against 7.2.x:

1. **Protect subscribes without a topic filter.** Its `PullMessages` request
   carries no `Filter`/`TopicExpression`, so any topic you publish *will* reach
   it. Delivery is never the blocker.
2. **Protect re-reads `GetEventProperties` about every 60 seconds.** New topics
   are discovered within a minute — **no re-adoption needed** to advertise one.

So the experiment costs a small edit to `events-service.js` and a minute of
waiting, with no risk to the working motion path if you **add** topics rather than
replacing the motion one.

## If you try it

1. Keep `CellMotionDetector/Motion` emitting exactly as-is.
2. Add a candidate topic to **both** the `GetEventProperties` `TopicSet` (with a
   `tt:MessageDescription`) and the `PullMessages` notification body.
3. Trigger it and watch how Protect files the event.
4. Only if the topic shows up in `GetEventProperties` and Protect still files it
   as motion, try a remove/re-adopt — Protect is known to cache *some* per-camera
   state at adoption, so that is the second thing to rule out, not the first.

If you get this working, please open an issue — it would be a genuinely useful
result and this page should be rewritten.
