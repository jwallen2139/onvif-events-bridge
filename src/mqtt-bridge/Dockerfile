FROM python:3.12-alpine

WORKDIR /app
COPY src/mqtt-bridge/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY src/mqtt-bridge/bridge.py /app/bridge.py

ENV CONFIG_PATH=/config/config.yaml
CMD ["python", "-u", "/app/bridge.py"]
