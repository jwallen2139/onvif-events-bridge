# Example: Frigate person detection → motion events in Protect

Every time Frigate detects a **person** on a given camera, a motion event appears on that camera's
timeline in UniFi Protect.

This is the canonical use case: you have a camera Protect can't natively analyze (a Portal, an old
RTSP cam, a go2rtc restream), Frigate does the person detection, and this bridge surfaces those
detections as Protect timeline events — no AI Port.

## config.yaml

```yaml
mqtt:
  host: mqtt.example.lan
  port: 1883
  username: ${MQTT_USERNAME}
  password: ${MQTT_PASSWORD}

onvif:
  host: 192.0.2.10            # the virtual camera's LAN IP (= CAMERA_IP in .env)
  port: 8081                  # ONVIF port from your onvif.yaml

sources:
  - name: frigate_person
    type: frigate
    topic: "frigate/events"     # match your Frigate topic_prefix (default 'frigate')
    camera: driveway            # your Frigate camera name
    label: person

max_motion_seconds: 60
```

## Frigate side (reference)

Point Frigate at the same stream Protect records (e.g. via go2rtc), detect `person`, and let this
bridge do the rest. Recording/snapshots in Frigate are optional — Protect owns recording; Frigate is
here for detection.

```yaml
# frigate config (excerpt)
cameras:
  driveway:
    ffmpeg:
      inputs:
        - path: rtsp://YOUR_GO2RTC:8554/driveway
          roles: [detect]
    detect:
      enabled: true
      width: 640
      height: 480
    objects:
      track: [person]
    record:
      enabled: false      # Protect records; Frigate only detects
    snapshots:
      enabled: false
```

**Tip:** a fast detector matters for brief appearances. A saturated CPU detector drops frames and
misses quick walk-bys; an Intel iGPU via OpenVINO (or a Coral) with ~20ms inference catches them.
