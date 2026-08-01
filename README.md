# onvif-events-bridge

**Give any [daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server) virtual camera working motion events in UniFi Protect — driven by Frigate, MQTT, or anything you can script. No AI Port, no AI Key, no Ubiquiti hardware required.**

UniFi Protect can adopt third-party ONVIF cameras and record them 24/7, but it will **not** show any events (motion, person, etc.) for them unless the camera emits ONVIF events — which most virtual/RTSP-wrapped cameras don't. Ubiquiti's answer is to sell you an **AI Port** (~$200) to generate detections for third-party cameras.

This project is the free alternative. It adds an **ONVIF Events service** to a virtual ONVIF camera and drives it from **MQTT**, so a detection anywhere in your stack (a Frigate person detection, a Frigate audio "crying" event, a motion sensor, a cron job — anything that can publish MQTT) shows up as a **motion event on the camera's timeline in UniFi Protect, with a thumbnail.**

```
  detection source            this project                      UniFi Protect
 ┌────────────────┐   MQTT   ┌──────────────────────────┐  ONVIF  ┌──────────────┐
 │ Frigate /      │ ───────► │  mqtt-bridge             │ Pull-   │ subscribes,  │
 │ HA / motion /  │          │    │                     │ Point   │ pulls events,│
 │ anything       │          │    ▼                     │ ◄─────► │ shows them   │
 └────────────────┘          │  onvif-events service ───┼─────────┤ on timeline  │
                             │  (rides alongside        │         │ w/ thumbnail │
                             │   onvif-server)          │         └──────────────┘
                             └──────────────────────────┘
```

## What you get

- **Motion events in UniFi Protect for a camera Protect can't natively analyze** — timeline markers, event thumbnails, event-based clip navigation, and (via the [`unifiprotect`](https://www.home-assistant.io/integrations/unifiprotect/) Home Assistant integration) motion sensors you can automate on.
- **Detections stay meaningful.** Point the bridge at Frigate's `person` events and every Protect event is person-filtered. Point it at Frigate audio and you get sound-triggered events. The bridge doesn't care what the source is — it only cares whether a detection is currently active.
- **No re-adoption gymnastics after setup.** Protect re-reads the camera's event capabilities roughly once a minute, so once it's subscribed it just works.

## What you DON'T get (read this before you start)

- **These are `motion` events, not native "person"/"vehicle" smart-detection labels.** Protect files everything this emits under motion. The camera will **not** appear in Protect's *Find Anything* / smart-detection search filtered by object type. If your detection source (e.g. Frigate) only fires on people, then in practice every event *is* a person — but Protect labels it "motion." Native smart-detection labels for third-party cameras still require an AI Port. See [docs/how-it-works.md](docs/how-it-works.md#the-honest-limitation) for the why.
- This is a community tool that speaks ONVIF to Protect over the **supported** third-party-ONVIF path. It does **not** patch Protect, touch its database, or require SSH to your console (unlike some alternatives). But it is not a Ubiquiti product and can be affected by future Protect changes.

## Requirements

- A working virtual ONVIF camera via **[daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server)** already adopted (or adoptable) in UniFi Protect. That project wraps your RTSP stream as an ONVIF camera; this project adds the events it's missing. If you don't have that yet, set it up first.
- **UniFi Protect 5.0+** (third-party ONVIF support; developed/tested against 7.2.x on a UNVR).
- An **MQTT broker** and a detection source that publishes to it. [Frigate](https://frigate.video/) is the reference source (person or audio detection), but anything that publishes MQTT works.
- **Docker** on a Linux host on the same L2 network as the virtual camera (a NAS, a Pi, a mini-PC). Because the virtual camera uses a **macvlan** interface, this must be real Linux — Docker Desktop on macOS/Windows can't attach macvlan to your LAN.

## Quick start

1. **Have onvif-server running** with your camera adopted in Protect. Confirm live view + recording work first.
2. **Copy the examples:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/onvif-events-bridge.git
   cd onvif-events-bridge
   cp config.example.yaml config.yaml
   cp .env.example .env
   ```
3. **Edit `config.yaml`** — point it at your MQTT broker and map the MQTT topic(s) that mean "a detection is happening" (see [examples/](examples/)).
4. **Bring it up:**
   ```bash
   docker compose up -d
   ```
5. **Remove and re-adopt the camera in Protect ONCE.** Protect only discovers the new Events service on a fresh adoption. (You keep recordings — choose *Archive* when prompted.) After this one-time step, event-topic changes are picked up live.
6. **Trigger a detection** and watch the camera's timeline in Protect. An event with a thumbnail should appear within a couple of seconds.

Full walkthrough: [docs/unifi-protect-setup.md](docs/unifi-protect-setup.md). Frigate wiring: [examples/](examples/). When it doesn't work: [docs/troubleshooting.md](docs/troubleshooting.md).

## How it works (short version)

`onvif-server` gives Protect a camera it can stream, but advertises **no Event service**, so Protect has nothing to show on the timeline. This project runs an **ONVIF Events service** on the same virtual-camera IP that implements the pieces Protect actually calls — `GetEventProperties`, `CreatePullPointSubscription`, `PullMessages`, `Renew`, `Unsubscribe` — and emits `tns1:RuleEngine/CellMotionDetector/Motion` with an `IsMotion` boolean.

A small **MQTT bridge** subscribes to your detection topic(s) and maintains a single motion **level**: it goes `IsMotion=true` when at least one detection becomes active and `IsMotion=false` when the last one clears (edge-triggered, not a pulse, so Protect can't be flooded). Protect maintains a WS-PullPoint subscription and pulls those edges continuously; each `true` edge becomes a timeline event.

Two behaviors of Protect's third-party ONVIF ingest make this robust, both documented in [docs/how-it-works.md](docs/how-it-works.md): it **subscribes without a topic filter** (it accepts whatever we publish) and it **re-reads `GetEventProperties` about every 60 seconds** (so capabilities can change without re-adoption).

## Credits & prior art

- Built on top of **[daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server)** — the virtual ONVIF camera this extends.
- **[danielwoz/ubiquiti-protect-onvif-event-listener](https://github.com/danielwoz/ubiquiti-protect-onvif-event-listener)** solves a related problem by writing detection rows directly into Protect's PostgreSQL — but it is Dream Router / Dream Machine only and does not work on a UNVR. This project takes the opposite approach: speak ONVIF events *to* Protect over the supported path, so it works on any console that supports third-party ONVIF cameras.
- Reference detection source: **[Frigate](https://frigate.video/)**.

## License

MIT — see [LICENSE](LICENSE).
