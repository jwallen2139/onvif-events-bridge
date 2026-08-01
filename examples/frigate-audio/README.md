# Example: Frigate audio detection → events in Protect (e.g. a baby-cry monitor)

Frigate can classify **audio** (crying, speech, barking, alarms, glass-break, …) from a camera's
microphone. This example fires a Protect timeline event when a chosen sound is heard — e.g. turning
an older camera with a mic into a baby-cry monitor even if Protect can't do audio detection on it.

Frigate publishes audio detections to `frigate/<camera>/audio/<label>` as `ON`/`OFF`. Point the
bridge straight at that topic.

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
  - name: nursery_crying
    type: onoff
    topic: "frigate/nursery/audio/crying"   # ON when crying is heard, OFF when it stops

max_motion_seconds: 60
```

## Frigate side (reference)

Audio detection needs the stream's **audio track**. Feed Frigate an RTSP/RTSPS source that carries
audio (many NVRs expose one), enable audio, and listen for your label. Object detection can be off —
this camera is audio-only duty.

```yaml
# frigate config (excerpt)
cameras:
  nursery:
    ffmpeg:
      inputs:
        - path: rtsps://YOUR_NVR:7441/STREAM_TOKEN?enableSrtp   # a stream WITH audio
          roles: [audio]        # audio-only; add 'detect' only if you also want video
    detect:
      enabled: false
    audio:
      enabled: true
      listen:
        - crying
      # min_volume gates classification. Measure your ambient RMS and set this JUST above it;
      # Frigate's default is often far too high for a quiet room, silently suppressing real events.
      min_volume: 40
```

**Notifications:** for a phone alert, don't rely on the Protect event — automate on the Frigate audio
event in Home Assistant (it carries the label and is what you actually want to notify on), with a
cooldown so a rough night is one ping, not forty. The Protect event is for *finding the moment in
recorded footage*.
