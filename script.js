const TOPIC_TELEMETRY = "illsley/bme280/telemetry";
const TOPIC_STATUS = "illsley/bme280/status";

let client = null;
let lastDataAt = 0;

const elements = {
  broker: document.getElementById("broker"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  connectButton: document.getElementById("connectButton"),
  overallStatus: document.getElementById("overallStatus"),
  sensorStatus: document.getElementById("sensorStatus"),
  temperature: document.getElementById("temperature"),
  humidity: document.getElementById("humidity"),
  pressure: document.getElementById("pressure"),
  rssi: document.getElementById("rssi"),
  uptime: document.getElementById("uptime"),
  lastUpdate: document.getElementById("lastUpdate")
};

function setConnectionStatus(text, state) {
  elements.overallStatus.textContent = text;
  elements.overallStatus.className = `status-pill ${state}`;
}

function formatUptime(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return "--";

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function updateTelemetry(payloadText) {
  let data;

  try {
    data = JSON.parse(payloadText);
  } catch (error) {
    console.error("Invalid telemetry JSON:", error, payloadText);
    return;
  }

  const temperature = Number(data.temperature);
  const humidity = Number(data.humidity);
  const pressure = Number(data.pressure);
  const rssi = Number(data.rssi);
  const uptime = Number(data.uptime);

  if (Number.isFinite(temperature)) {
    elements.temperature.textContent = temperature.toFixed(1);
  }

  if (Number.isFinite(humidity)) {
    elements.humidity.textContent = humidity.toFixed(1);
  }

  if (Number.isFinite(pressure)) {
    elements.pressure.textContent = pressure.toFixed(0);
  }

  elements.rssi.textContent = Number.isFinite(rssi) ? `${rssi} dBm` : "-- dBm";
  elements.uptime.textContent = formatUptime(uptime);

  lastDataAt = Date.now();
  elements.lastUpdate.textContent = new Date(lastDataAt).toLocaleString();
}

function handleStatus(payloadText) {
  const online = payloadText.trim().toLowerCase() === "online";
  elements.sensorStatus.textContent = online ? "Online" : "Offline";
  elements.sensorStatus.style.color = online ? "var(--green)" : "var(--red)";
}

function disconnectClient() {
  if (client) {
    client.end(true);
    client = null;
  }

  elements.connectButton.textContent = "Connect";
  elements.connectButton.disabled = false;
  setConnectionStatus("Disconnected", "offline");
}

function connectClient() {
  const broker = elements.broker.value.trim();
  const username = elements.username.value.trim();
  const password = elements.password.value;

  if (!broker || !username || !password) {
    setConnectionStatus("Enter broker login", "offline");
    return;
  }

  if (typeof mqtt === "undefined") {
    setConnectionStatus("MQTT library failed", "offline");
    return;
  }

  if (client) {
    disconnectClient();
    return;
  }

  const url = `wss://${broker}:8884/mqtt`;

  setConnectionStatus("Connecting...", "connecting");
  elements.connectButton.textContent = "Connecting";
  elements.connectButton.disabled = true;

  client = mqtt.connect(url, {
    username,
    password,
    clientId: `id_bme_web_${Math.random().toString(16).slice(2, 10)}`,
    protocolVersion: 4,
    clean: true,
    connectTimeout: 10000,
    reconnectPeriod: 3000,
    keepalive: 30
  });

  client.on("connect", () => {
    setConnectionStatus("MQTT connected", "online");
    elements.connectButton.textContent = "Disconnect";
    elements.connectButton.disabled = false;

    client.subscribe([TOPIC_TELEMETRY, TOPIC_STATUS], { qos: 0 }, (error) => {
      if (error) {
        console.error("Subscription failed:", error);
        setConnectionStatus("Subscribe failed", "offline");
      }
    });
  });

  client.on("message", (topic, payload) => {
    const text = payload.toString();

    if (topic === TOPIC_TELEMETRY) {
      updateTelemetry(text);
    } else if (topic === TOPIC_STATUS) {
      handleStatus(text);
    }
  });

  client.on("reconnect", () => {
    setConnectionStatus("Reconnecting...", "connecting");
  });

  client.on("offline", () => {
    setConnectionStatus("MQTT offline", "offline");
  });

  client.on("close", () => {
    if (client) {
      setConnectionStatus("Connection closed", "offline");
    }
  });

  client.on("error", (error) => {
    console.error("MQTT error:", error);
    setConnectionStatus("Connection error", "offline");
    elements.connectButton.disabled = false;
    elements.connectButton.textContent = "Disconnect";
  });
}

elements.connectButton.addEventListener("click", connectClient);

elements.password.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    connectClient();
  }
});

window.addEventListener("beforeunload", () => {
  if (client) {
    client.end(true);
  }
});
