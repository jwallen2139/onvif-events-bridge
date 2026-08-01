#!/usr/bin/env python3
"""
MQTT -> ONVIF motion bridge.

Subscribes to one or more MQTT topics that mean "a detection is happening" and
maintains a single motion LEVEL on the virtual camera's ONVIF Events service.

The level is reference-counted, not a pulse:

    first detection becomes active  -> IsMotion=true   (motion start)
    last active detection clears    -> IsMotion=false  (motion end)

Ten rapid detections therefore produce ONE motion window on the Protect
timeline, not ten. Protect cannot be flooded, and the timeline event spans the
real activity rather than being a string of one-second blips.

A max-duration failsafe forces the level back to false after
`max_motion_seconds` even if an "end" message is missed or the detector dies
mid-event, so the level can never wedge on. A wedged-on level is the single most
common cause of "it worked once and then stopped": Protect only creates a new
event on a false->true edge, so if the level never returns to false there is no
new edge to see.

Source types:
  frigate  Frigate's events JSON (`<topic_prefix>/events`). Filters on camera
           and object label, ignores false positives, and tracks individual
           event ids so overlapping detections reference-count correctly.
  onoff    Any topic publishing ON/OFF (also on/off, true/false, 1/0, yes/no).
           Frigate's audio topics (`<prefix>/<camera>/audio/<label>`) are this
           shape, as is almost any motion sensor bridged to MQTT.

Configuration comes from config.yaml (see config.example.yaml). Secrets are
written as ${VAR} and resolved from the environment / .env.
"""

import json
import logging
import os
import re
import sys
import threading
import time
from logging.handlers import RotatingFileHandler
from urllib import request as urlrequest

import paho.mqtt.client as mqtt
import yaml

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/config/config.yaml")

log = logging.getLogger("bridge")

_ENV_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _expand(value):
    """Recursively resolve ${VAR} references from the environment."""
    if isinstance(value, str):
        def sub(m):
            name = m.group(1)
            if name not in os.environ:
                raise SystemExit(
                    "config references ${%s} but that variable is not set. "
                    "Add it to .env (see .env.example)." % name
                )
            return os.environ[name]
        return _ENV_RE.sub(sub, value)
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand(v) for v in value]
    return value


def load_config(path):
    if not os.path.exists(path):
        raise SystemExit(
            "no config at %s — copy config.example.yaml to config.yaml "
            "and mount it into the container." % path
        )
    with open(path, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    return _expand(cfg)


def setup_logging(level_name, log_path):
    level = getattr(logging, str(level_name).upper(), logging.INFO)
    log.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(sh)
    if log_path:
        try:
            fh = RotatingFileHandler(log_path, maxBytes=2_000_000, backupCount=2)
            fh.setFormatter(fmt)
            log.addHandler(fh)
        except OSError as exc:
            log.warning("file logging disabled (%s)", exc)


class MotionLevel:
    """The single reference-counted motion level for the camera."""

    TRUTHY = {"on", "true", "1", "yes", "active", "detected"}
    FALSY = {"off", "false", "0", "no", "inactive", "clear"}

    def __init__(self, trigger_url, max_motion_seconds):
        self.trigger_url = trigger_url
        self.max_motion_seconds = max_motion_seconds
        self._lock = threading.Lock()
        self._active = {}        # source name -> set of active keys
        self._motion = False
        self._since = 0.0

    # -- transport ----------------------------------------------------------
    def _push(self, state):
        url = "%s?state=%s" % (self.trigger_url, "on" if state else "off")
        try:
            with urlrequest.urlopen(url, timeout=5) as resp:
                body = resp.read().decode("utf-8", "replace").strip()
            self._motion = state
            self._since = time.time() if state else 0.0
            log.info("IsMotion=%s -> %s", str(state).lower(), body)
            return True
        except Exception as exc:
            log.error("failed to set IsMotion=%s: %s", str(state).lower(), exc)
            return False

    def _reconcile(self):
        want = any(bool(keys) for keys in self._active.values())
        if want != self._motion:
            self._push(want)

    # -- source callbacks ---------------------------------------------------
    def activate(self, source, key):
        with self._lock:
            keys = self._active.setdefault(source, set())
            if key not in keys:
                keys.add(key)
                log.info("[%s] active   %s (n=%d)", source, key, len(keys))
            self._reconcile()

    def clear(self, source, key):
        with self._lock:
            keys = self._active.setdefault(source, set())
            if key in keys:
                keys.discard(key)
                log.info("[%s] cleared  %s (n=%d)", source, key, len(keys))
            self._reconcile()

    def clear_all(self, source):
        with self._lock:
            self._active[source] = set()
            self._reconcile()

    def boot(self):
        """Publish a known-false level at startup."""
        with self._lock:
            self._push(False)

    def watchdog(self):
        """Force the level off if it has been on longer than the failsafe allows."""
        if not self.max_motion_seconds:
            return
        while True:
            time.sleep(5)
            with self._lock:
                if self._motion and self._since and \
                        (time.time() - self._since) > self.max_motion_seconds:
                    log.warning(
                        "motion level on > %ss — forcing off (missed end message?)",
                        self.max_motion_seconds,
                    )
                    self._active = {k: set() for k in self._active}
                    self._push(False)

    @staticmethod
    def parse_onoff(payload):
        p = payload.strip().lower()
        if p in MotionLevel.TRUTHY:
            return True
        if p in MotionLevel.FALSY:
            return False
        return None


class Source:
    """One MQTT topic mapped onto the motion level."""

    def __init__(self, spec, level):
        self.name = spec.get("name") or spec.get("topic")
        self.type = (spec.get("type") or "onoff").lower()
        self.topic = spec["topic"]
        self.camera = spec.get("camera")
        self.label = spec.get("label")
        self.level = level
        if self.type not in ("frigate", "onoff"):
            raise SystemExit(
                "source '%s': unknown type '%s' (expected 'frigate' or 'onoff')"
                % (self.name, self.type)
            )
        if self.type == "frigate" and not self.camera:
            raise SystemExit("source '%s': type 'frigate' requires 'camera'" % self.name)

    def handle(self, payload):
        if self.type == "onoff":
            state = MotionLevel.parse_onoff(payload)
            if state is None:
                log.debug("[%s] ignoring unparseable payload %r", self.name, payload[:40])
                return
            if state:
                self.level.activate(self.name, "level")
            else:
                self.level.clear(self.name, "level")
            return

        # type == frigate
        try:
            msg = json.loads(payload)
        except ValueError:
            log.warning("[%s] payload is not JSON — is this really a Frigate "
                        "events topic? Use type 'onoff' for plain ON/OFF topics.",
                        self.name)
            return

        after = msg.get("after") or msg.get("before") or {}
        if after.get("camera") != self.camera:
            return
        if self.label and after.get("label") != self.label:
            return
        if after.get("false_positive"):
            return
        event_id = after.get("id")
        if not event_id:
            return

        if msg.get("type") == "end":
            self.level.clear(self.name, event_id)
        else:  # new / update
            self.level.activate(self.name, event_id)


def main():
    cfg = load_config(CONFIG_PATH)

    setup_logging(cfg.get("log_level", "info"), cfg.get("log_file"))

    onvif = cfg.get("onvif") or {}
    host = onvif.get("host")
    port = onvif.get("port", 8081)
    if not host:
        raise SystemExit("config: onvif.host is required (the virtual camera's address)")
    trigger_url = "http://%s:%s/trigger/motion" % (host, port)

    level = MotionLevel(trigger_url, int(cfg.get("max_motion_seconds", 60) or 0))

    specs = cfg.get("sources") or []
    if not specs:
        raise SystemExit("config: at least one entry under 'sources' is required")
    sources = [Source(s, level) for s in specs]

    log.info("onvif events trigger: %s", trigger_url)
    for s in sources:
        log.info("source '%s' type=%s topic=%s%s", s.name, s.type, s.topic,
                 (" camera=%s label=%s" % (s.camera, s.label)) if s.type == "frigate" else "")

    level.boot()
    threading.Thread(target=level.watchdog, daemon=True).start()

    mq = cfg.get("mqtt") or {}
    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                             client_id=mq.get("client_id", "onvif-events-bridge"))
    except AttributeError:  # paho-mqtt < 2.0
        client = mqtt.Client(client_id=mq.get("client_id", "onvif-events-bridge"))

    if mq.get("username"):
        client.username_pw_set(mq["username"], mq.get("password"))

    by_topic = {}
    for s in sources:
        by_topic.setdefault(s.topic, []).append(s)

    def on_connect(c, userdata, flags, rc, properties=None):
        if rc == 0:
            log.info("connected to mqtt %s:%s", mq.get("host"), mq.get("port", 1883))
            for topic in by_topic:
                c.subscribe(topic)
                log.info("subscribed %s", topic)
        else:
            log.error("mqtt connect failed rc=%s", rc)

    def on_message(c, userdata, msg):
        payload = msg.payload.decode("utf-8", "replace")
        # Match by subscription pattern rather than exact string so wildcard
        # topics (e.g. "frigate/+/audio/crying") dispatch correctly.
        for s in sources:
            if not mqtt.topic_matches_sub(s.topic, msg.topic):
                continue
            try:
                s.handle(payload)
            except Exception as exc:
                log.exception("[%s] handler error: %s", s.name, exc)

    client.on_connect = on_connect
    client.on_message = on_message

    while True:
        try:
            client.connect(mq.get("host"), int(mq.get("port", 1883)), 60)
            client.loop_forever()
        except Exception as exc:
            log.error("mqtt loop error: %s — retrying in 10s", exc)
            time.sleep(10)


if __name__ == "__main__":
    main()
