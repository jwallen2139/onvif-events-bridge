# UniFi Protect setup

This assumes you already have a virtual ONVIF camera via
[daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server) and that it **streams and
records** in Protect. If not, do that first — this project only adds events to a camera Protect
already has.

## 1. Bring up the events bridge

From the repo:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
# edit config.yaml (MQTT broker + your detection topic mapping)
# edit .env (secrets: MQTT password, etc.)
docker compose up -d
docker compose logs -f
```

You want the logs to show the ONVIF Events service listening and the MQTT bridge connected to your
broker and subscribed to your topic(s).

### Networking note (important)

The Events service must be reachable by Protect at the **same IP** Protect uses for the camera —
i.e. the virtual camera's **macvlan** address that `onvif-server` created. Run the events service so
it binds/attaches to that address (see `docker-compose.yml` comments). If the events service answers
on a *different* IP than the camera, Protect won't associate the events with the camera.

Remember the macvlan quirk: the Docker **host itself cannot reach** its own macvlan child IPs. That's
normal and does not affect Protect (a separate host) reaching them. Test reachability from another
machine, not from the Docker host.

## 2. One-time remove + re-adopt

Protect discovers a camera's Event service only on a **fresh adoption**. If your camera was adopted
*before* the events service existed, you must remove and re-adopt it once:

1. Protect → **Devices** → your camera → gear/settings → **Manage** → **Remove**.
2. When asked about recordings, choose **Archive them** (keeps your footage).
3. Wait ~60s; the camera reappears as **Click to Adopt**.
4. Adopt it. Enter any non-empty ONVIF username/password if prompted (onvif-server doesn't verify
   them unless you configured it to).
5. Set **Recording mode → Always** (third-party cameras have no reason to sit in "Detections" mode,
   and you now get event markers on top of continuous recording).

> After this one-time re-adopt, you never need to do it again for topic/config changes — Protect
> re-reads capabilities every ~60 seconds.

## 3. Verify

Trigger a detection at the source (walk in front of the camera for a Frigate person setup; make the
relevant sound for an audio setup; publish a test MQTT message; etc.).

- **In the bridge logs:** you should see the motion level go `true` then `false`, and Protect's
  `PullMessages` pulling the edges.
- **In Protect:** open the camera, and within a second or two an **event with a thumbnail** should
  appear in its event strip / on the timeline.

If the subscription is live but no event appears, or nothing happens at all, see
[troubleshooting.md](troubleshooting.md).

## 4. (Optional) Use the events in Home Assistant

If you run the [`unifiprotect`](https://www.home-assistant.io/integrations/unifiprotect/) integration,
the camera's motion now surfaces as a `binary_sensor` you can automate on — though if your source is
Frigate you probably already have the richer, object-labeled Frigate event in HA and would automate
on that instead. The Protect events are primarily for **navigating footage inside Protect**.
