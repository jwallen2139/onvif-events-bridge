# Events-enabled build of daniela-hase/onvif-server.
#
# Takes the upstream virtual-ONVIF-camera image unmodified and bolts the ONVIF
# Events service onto it at build time. Upstream's own source is patched by three
# surgical, anchor-asserted edits (see src/onvif-events/patch-onvif-server.js) —
# if upstream changes shape the build fails loudly instead of silently producing
# an image with no event support.
#
# Pin ONVIF_SERVER_TAG to a specific upstream tag if you want reproducible builds.

ARG ONVIF_SERVER_TAG=latest
FROM ghcr.io/daniela-hase/onvif-server:${ONVIF_SERVER_TAG}

COPY src/onvif-events/events-service.js /app/src/events-service.js
COPY src/onvif-events/patch-onvif-server.js /tmp/patch-onvif-server.js

RUN node /tmp/patch-onvif-server.js /app/src/onvif-server.js \
 && node --check /app/src/onvif-server.js \
 && node --check /app/src/events-service.js \
 && rm /tmp/patch-onvif-server.js

# Upstream's entrypoint. -d logs each ONVIF request, which is what you want while
# proving Protect is subscribing; drop it once things are stable.
ENTRYPOINT ["/bin/sh", "-c", "node main.js -d /onvif.yaml"]
