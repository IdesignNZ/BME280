"use strict";

const MQTT_CONFIG = {
  url: "wss://e1fe53e3c20b4f3daf38aafa8e16ff4b.s1.eu.hivemq.cloud:8884/mqtt",
  telemetryTopic: "illsley/bme280/telemetry",
  statusTopic: "illsley/bme280/status"
};

const USERNAME_STORAGE_KEY = "illsley-bme280-mqtt-username";
const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const ESP_HISTORY_CAPACITY = 2880;
const HISTORY_REQUEST_TIMEOUT_MS = 10000;
const MAX_HISTORY_DRAW_POINTS = 1400;

let client = null;
let connectedOnce = false;
let manualDisconnect = false;
let currentUsername = "";

let livePoints = [];
let historyPoints = [];
let pendingHistoryRecords = [];

let historyRequestId = "";
let historyRequestReferenceTime = 0;
let historyLoading = false;
let historyRequestTimer = null;
let expectedHistoryParts = 0;
let reportedHistoryRecords = 0;
let reportedHistoryCapacity = ESP_HISTORY_CAPACITY;
const receivedHistoryParts = new Map();

const elements = {
  overallStatus: document.getElementById("overallStatus"),
  mqttLoginForm: document.getElementById("mqttLoginForm"),
  mqttUsername: document.getElementById("mqttUsername"),
  mqttPassword: document.getElementById("mqttPassword"),
  rememberUsername: document.getElementById("rememberUsername"),
  connectButton: document.getElementById("connectButton"),
  loginError: document.getElementById("loginError"),
  connectedPanel: document.getElementById("connectedPanel"),
  connectedUsername: document.getElementById("connectedUsername"),
  changeLoginButton: document.getElementById("changeLoginButton"),

  temperature: document.getElementById("temperature"),
  humidity: document.getElementById("humidity"),
  pressure: document.getElementById("pressure"),
  tempMin: document.getElementById("tempMin"),
  tempMax: document.getElementById("tempMax"),
  humidityMin: document.getElementById("humidityMin"),
  humidityMax: document.getElementById("humidityMax"),
  pressureMin: document.getElementById("pressureMin"),
  pressureMax: document.getElementById("pressureMax"),

  liveTempLatest: document.getElementById("liveTempLatest"),
  liveHumidityLatest: document.getElementById("liveHumidityLatest"),
  livePressureLatest: document.getElementById("livePressureLatest"),
  historyTempLatest: document.getElementById("historyTempLatest"),
  historyHumidityLatest: document.getElementById("historyHumidityLatest"),
  historyPressureLatest: document.getElementById("historyPressureLatest"),

  livePointCount: document.getElementById("livePointCount"),
  historyPointCount: document.getElementById("historyPointCount"),
  historyLoadStatus: document.getElementById("historyLoadStatus"),
  historyRecordCount: document.getElementById("historyRecordCount"),
  historyTimeSpan: document.getElementById("historyTimeSpan"),
  reloadHistory: document.getElementById("reloadHistory"),
  historyZoomSelect: document.getElementById("historyZoomSelect"),
  historyPosition: document.getElementById("historyPosition"),
  historyViewRange: document.getElementById("historyViewRange"),
  resetHistoryZoom: document.getElementById("resetHistoryZoom"),

  sensorStatus: document.getElementById("sensorStatus"),
  rssi: document.getElementById("rssi"),
  uptime: document.getElementById("uptime"),
  lastUpdate: document.getElementById("lastUpdate"),
  liveInterval: document.getElementById("liveInterval")
};

const charts = {
  liveTemperature: createLineChart(
    document.getElementById("liveTemperatureChart"), "°C", "--amber", 1, 0.5,
    "Waiting for live temperature data"
  ),
  liveHumidity: createLineChart(
    document.getElementById("liveHumidityChart"), "%", "--cyan", 1, 1.0,
    "Waiting for live humidity data"
  ),
  livePressure: createLineChart(
    document.getElementById("livePressureChart"), "hPa", "--blue", 1, 0.2,
    "Waiting for live pressure data"
  ),
  historyTemperature: createLineChart(
    document.getElementById("historyTemperatureChart"), "°C", "--amber", 1, 0.5,
    "Waiting for stored temperature history"
  ),
  historyHumidity: createLineChart(
    document.getElementById("historyHumidityChart"), "%", "--cyan", 1, 1.0,
    "Waiting for stored humidity history"
  ),
  historyPressure: createLineChart(
    document.getElementById("historyPressureChart"), "hPa", "--blue", 1, 0.2,
    "Waiting for stored pressure history"
  )
};

function loadRememberedUsername() {
  const remembered = localStorage.getItem(USERNAME_STORAGE_KEY);
  elements.mqttUsername.value = remembered || elements.mqttUsername.value || "bme280";
  elements.rememberUsername.checked = true;
  (elements.mqttUsername.value ? elements.mqttPassword : elements.mqttUsername).focus();
}

function saveUsernamePreference(username) {
  if (elements.rememberUsername.checked) {
    localStorage.setItem(USERNAME_STORAGE_KEY, username);
  } else {
    localStorage.removeItem(USERNAME_STORAGE_KEY);
  }
}

function showLoginError(message) {
  elements.loginError.textContent = message;
  elements.loginError.hidden = false;
}

function clearLoginError() {
  elements.loginError.textContent = "";
  elements.loginError.hidden = true;
}

function setLoginBusy(busy) {
  elements.connectButton.disabled = busy;
  elements.connectButton.textContent = busy ? "Connecting…" : "Connect";
  elements.mqttUsername.disabled = busy;
  elements.mqttPassword.disabled = busy;
  elements.rememberUsername.disabled = busy;
}

function showLoginForm() {
  elements.mqttLoginForm.hidden = false;
  elements.connectedPanel.hidden = true;
  setLoginBusy(false);
}

function showConnectedPanel(username) {
  elements.connectedUsername.textContent = `Connected as ${username}`;
  elements.mqttLoginForm.hidden = true;
  elements.connectedPanel.hidden = false;
}

function setConnectionStatus(text, state) {
  elements.overallStatus.textContent = text;
  elements.overallStatus.className = `status-pill ${state}`;
}

function setHistoryStatus(text) {
  elements.historyLoadStatus.textContent = text;
}

function clearHistoryRequestTimer() {
  if (historyRequestTimer !== null) {
    window.clearTimeout(historyRequestTimer);
    historyRequestTimer = null;
  }
}

function stopMqttClient() {
  clearHistoryRequestTimer();
  historyLoading = false;
  expectedHistoryParts = 0;
  receivedHistoryParts.clear();
  pendingHistoryRecords = [];

  if (client) {
    const previous = client;
    client = null;
    try { previous.end(true); } catch (error) { console.warn(error); }
  }
}

function disconnectForLoginChange() {
  manualDisconnect = true;
  connectedOnce = false;
  stopMqttClient();
  setConnectionStatus("Not connected", "offline");
  setHistoryStatus("Enter the HiveMQ login");
  elements.sensorStatus.textContent = "Unknown";
  elements.sensorStatus.style.color = "";
  elements.reloadHistory.disabled = true;
  elements.mqttPassword.value = "";
  clearLoginError();
  showLoginForm();
  window.setTimeout(() => {
    manualDisconnect = false;
    elements.mqttPassword.focus();
  }, 0);
}

function connectMqtt(username, password) {
  stopMqttClient();
  currentUsername = username;
  connectedOnce = false;
  manualDisconnect = false;
  livePoints = [];
  renderLive();

  clearLoginError();
  setLoginBusy(true);
  setConnectionStatus("Connecting…", "connecting");
  setHistoryStatus("Connecting to HiveMQ");

  const clientId = "ID-BME280-WEB-" + Math.random().toString(16).slice(2, 10);

  try {
    client = mqtt.connect(MQTT_CONFIG.url, {
      clientId,
      username,
      password,
      clean: true,
      keepalive: 30,
      connectTimeout: 15000,
      reconnectPeriod: 5000,
      protocolVersion: 4
    });
  } catch (error) {
    setLoginBusy(false);
    setConnectionStatus("Connection failed", "offline");
    showLoginError(error instanceof Error ? error.message : "Could not start MQTT.");
    return;
  }

  client.on("connect", () => {
    connectedOnce = true;
    setLoginBusy(false);
    saveUsernamePreference(username);
    showConnectedPanel(username);
    setConnectionStatus("MQTT connected", "online");
    elements.reloadHistory.disabled = false;

    client.subscribe(
      [MQTT_CONFIG.telemetryTopic, MQTT_CONFIG.statusTopic],
      { qos: 1 },
      error => {
        if (error) {
          setHistoryStatus("MQTT connected, but topic subscription failed");
          console.error(error);
          return;
        }
        requestRamHistory();
      }
    );
  });

  client.on("message", (topic, payload) => handleMqttMessage(topic, payload.toString()));
  client.on("reconnect", () => setConnectionStatus("Reconnecting…", "connecting"));
  client.on("offline", () => setConnectionStatus("MQTT offline", "offline"));
  client.on("close", () => {
    if (!manualDisconnect) setConnectionStatus("MQTT disconnected", "offline");
  });
  client.on("error", error => {
    console.error("MQTT error:", error);
    if (!connectedOnce) {
      setLoginBusy(false);
      showLoginForm();
      setConnectionStatus("Connection failed", "offline");
      showLoginError("HiveMQ rejected the connection. Check the bme280 username and password.");
    }
  });
}

function handleMqttMessage(topic, text) {
  if (topic === MQTT_CONFIG.statusTopic) {
    handleDeviceStatus(text);
    return;
  }
  if (topic !== MQTT_CONFIG.telemetryTopic) return;

  if (text.startsWith("HREQ|")) return;
  if (text.startsWith("HACK|")) {
    handleHistoryAck(text);
    return;
  }
  if (text.startsWith("HDONE|")) {
    handleHistoryComplete(text);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.warn("Unrecognised telemetry payload:", text);
    return;
  }

  if (parsed && parsed.type === "historyPart") {
    handleHistoryData(parsed);
  } else if (parsed && parsed.type === "historyRecord") {
    handleNewHistoryRecord(parsed);
  } else {
    handleLiveTelemetry(parsed);
  }
}

function handleLiveTelemetry(data) {
  const temperature = Number(data.temperature);
  const humidity = Number(data.humidity);
  const pressure = Number(data.pressure);
  if (![temperature, humidity, pressure].every(Number.isFinite)) return;

  const now = Date.now();
  elements.temperature.textContent = temperature.toFixed(1);
  elements.humidity.textContent = humidity.toFixed(1);
  elements.pressure.textContent = pressure.toFixed(1);
  elements.liveTempLatest.textContent = temperature.toFixed(1);
  elements.liveHumidityLatest.textContent = humidity.toFixed(1);
  elements.livePressureLatest.textContent = pressure.toFixed(1);

  const rssi = Number(data.rssi);
  elements.rssi.textContent = Number.isFinite(rssi) ? `${Math.round(rssi)} dBm` : "-- dBm";
  elements.uptime.textContent = formatUptime(Number(data.uptime));
  elements.lastUpdate.textContent = new Date(now).toLocaleString();
  elements.sensorStatus.textContent = "Online";
  elements.sensorStatus.style.color = "var(--green)";

  const intervalMs = Number(data.sensorIntervalMs);
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    elements.liveInterval.textContent = `${(intervalMs / 1000).toFixed(intervalMs % 1000 ? 1 : 0)} seconds`;
  }

  updateReportedHistory(data.historyRecords, data.historyCapacity);

  livePoints.push({ time: now, temperature, humidity, pressure });
  livePoints = livePoints.filter(point => point.time >= now - LIVE_WINDOW_MS - 5000);
  renderLive();
}

function handleNewHistoryRecord(data) {
  const temperature = Number(data.temperature);
  const humidity = Number(data.humidity);
  const pressure = Number(data.pressure);
  if (![temperature, humidity, pressure].every(Number.isFinite)) return;

  updateReportedHistory(data.historyRecords, data.historyCapacity);

  const point = { time: Date.now(), temperature, humidity, pressure };
  if (historyLoading) {
    pendingHistoryRecords.push(point);
  } else {
    historyPoints = deduplicateHistory([...historyPoints, point]);
    renderHistory();
    setHistoryStatus(`History current — ${historyPoints.length.toLocaleString()} one-minute records`);
  }
}

function handleDeviceStatus(text) {
  const status = text.trim().toLowerCase();
  if (status === "online") {
    elements.sensorStatus.textContent = "Online";
    elements.sensorStatus.style.color = "var(--green)";
  } else {
    elements.sensorStatus.textContent = text.trim() || "Unknown";
    elements.sensorStatus.style.color = "var(--amber)";
  }
}

function updateReportedHistory(recordCount, capacity) {
  const count = Number(recordCount);
  const size = Number(capacity);
  if (Number.isFinite(count)) reportedHistoryRecords = Math.max(0, Math.min(Math.round(count), ESP_HISTORY_CAPACITY));
  if (Number.isFinite(size)) reportedHistoryCapacity = Math.max(1, Math.round(size));
  updateHistorySummary();
}

function handleHistoryData(data) {
  if (!historyLoading || data.requestId !== historyRequestId) return;
  const part = Number(data.part);
  const totalParts = Number(data.totalParts);
  if (!Number.isInteger(part) || part < 0 || !Array.isArray(data.records)) return;
  if (Number.isInteger(totalParts) && totalParts >= 0) expectedHistoryParts = totalParts;
  receivedHistoryParts.set(part, data.records);
  const expected = expectedHistoryParts > 0 ? ` of ${expectedHistoryParts}` : "";
  setHistoryStatus(`Loading RAM history — part ${receivedHistoryParts.size}${expected}`);
  restartHistoryRequestTimer();
}

function handleHistoryAck(text) {
  const fields = text.split("|");
  if (fields.length < 4 || !historyLoading || fields[1] !== historyRequestId) return;
  updateReportedHistory(fields[2], reportedHistoryCapacity);
  const parts = Number(fields[3]);
  if (Number.isInteger(parts) && parts >= 0) expectedHistoryParts = parts;
  setHistoryStatus(`ESP32 received request — sending ${reportedHistoryRecords.toLocaleString()} RAM records`);
  restartHistoryRequestTimer();
}

function handleHistoryComplete(text) {
  const fields = text.split("|");
  if (fields.length < 4 || !historyLoading || fields[1] !== historyRequestId) return;
  updateReportedHistory(fields[2], reportedHistoryCapacity);
  const parts = Number(fields[3]);
  if (Number.isInteger(parts) && parts >= 0) expectedHistoryParts = parts;
  finishHistoryLoad(false);
}

function createRequestId() {
  return (`web_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 9)}`).slice(0, 32);
}

function requestRamHistory() {
  if (!client || !client.connected) {
    setHistoryStatus("MQTT is not connected");
    return;
  }

  clearHistoryRequestTimer();
  historyRequestId = createRequestId();
  historyRequestReferenceTime = Date.now();
  historyLoading = true;
  expectedHistoryParts = 0;
  receivedHistoryParts.clear();
  pendingHistoryRecords = [];
  elements.reloadHistory.disabled = true;
  setHistoryStatus("Requesting the one-minute RAM history…");

  client.publish(
    MQTT_CONFIG.telemetryTopic,
    `HREQ|${historyRequestId}`,
    { qos: 1, retain: false },
    error => {
      if (error) {
        historyLoading = false;
        elements.reloadHistory.disabled = false;
        setHistoryStatus("History request could not be delivered to HiveMQ");
        console.error(error);
        return;
      }
      restartHistoryRequestTimer();
    }
  );
}

function restartHistoryRequestTimer() {
  clearHistoryRequestTimer();
  historyRequestTimer = window.setTimeout(() => {
    if (historyLoading) finishHistoryLoad(true);
  }, HISTORY_REQUEST_TIMEOUT_MS);
}

function buildPointsFromReceivedParts() {
  const points = [];
  const parts = [...receivedHistoryParts.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, records] of parts) {
    for (const record of records) {
      if (!Array.isArray(record) || record.length < 4) continue;
      const ageSeconds = Number(record[0]);
      const temperatureX100 = Number(record[1]);
      const humidityX100 = Number(record[2]);
      const pressureX10 = Number(record[3]);
      if (![ageSeconds, temperatureX100, humidityX100, pressureX10].every(Number.isFinite)) continue;
      points.push({
        time: historyRequestReferenceTime - Math.max(0, ageSeconds) * 1000,
        temperature: temperatureX100 / 100,
        humidity: humidityX100 / 100,
        pressure: pressureX10 / 10
      });
    }
  }
  return points;
}

function finishHistoryLoad(timedOut) {
  clearHistoryRequestTimer();
  const ramPoints = buildPointsFromReceivedParts();
  historyPoints = deduplicateHistory([...ramPoints, ...pendingHistoryRecords]);
  pendingHistoryRecords = [];
  historyLoading = false;
  elements.reloadHistory.disabled = !(client && client.connected);
  renderHistory();
  updateHistorySummary();

  if (timedOut) {
    setHistoryStatus(ramPoints.length > 0
      ? `History timed out — showing ${ramPoints.length.toLocaleString()} received records`
      : "No history reply from the ESP32. Confirm that V9 firmware is uploaded and MQTT is connected.");
  } else if (reportedHistoryRecords === 0) {
    setHistoryStatus("ESP32 RAM history is empty — the first average appears after one minute");
  } else if (expectedHistoryParts > 0 && receivedHistoryParts.size < expectedHistoryParts) {
    setHistoryStatus(`History incomplete — received ${receivedHistoryParts.size} of ${expectedHistoryParts} parts`);
  } else {
    setHistoryStatus(`RAM history loaded — ${historyPoints.length.toLocaleString()} one-minute records`);
  }

  receivedHistoryParts.clear();
  expectedHistoryParts = 0;
}

function formatUptime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--";
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatStoredDuration(recordCount) {
  if (recordCount <= 0) return "0 min stored";
  if (recordCount < 60) return `${recordCount} min stored`;
  const hours = Math.floor(recordCount / 60);
  const minutes = recordCount % 60;
  return hours < 24 ? `${hours} h ${minutes} min stored` : `${Math.floor(hours / 24)} d ${hours % 24} h stored`;
}

function updateHistorySummary() {
  elements.historyRecordCount.textContent = `${reportedHistoryRecords.toLocaleString()} / ${reportedHistoryCapacity.toLocaleString()} records`;
  elements.historyTimeSpan.textContent = formatStoredDuration(reportedHistoryRecords);
}

function trimHistory(points) {
  const earliest = Date.now() - HISTORY_WINDOW_MS;
  return points
    .filter(point => point && Number.isFinite(point.time) && point.time >= earliest &&
      Number.isFinite(point.temperature) && Number.isFinite(point.humidity) && Number.isFinite(point.pressure))
    .sort((a, b) => a.time - b.time)
    .slice(-ESP_HISTORY_CAPACITY);
}

function deduplicateHistory(points) {
  const sorted = trimHistory(points);
  const result = [];
  for (const point of sorted) {
    const previous = result[result.length - 1];
    const sameValues = previous &&
      Math.abs(previous.temperature - point.temperature) < 0.001 &&
      Math.abs(previous.humidity - point.humidity) < 0.001 &&
      Math.abs(previous.pressure - point.pressure) < 0.001;
    if (previous && sameValues && Math.abs(previous.time - point.time) < 20000) continue;
    result.push(point);
  }
  return result;
}

function numberRange(values, minimumSpan) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  const centre = (min + max) / 2;
  const span = Math.max(max - min, minimumSpan);
  min = centre - span * 0.62;
  max = centre + span * 0.62;
  return { min, max };
}

function compressForDisplay(points, valueKey, maximumPoints) {
  if (points.length <= maximumPoints) return points;
  const bucketCount = Math.max(1, Math.floor(maximumPoints / 2));
  const bucketSize = points.length / bucketCount;
  const output = [];

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.min(points.length, Math.floor((bucket + 1) * bucketSize));
    if (end <= start) continue;
    let minPoint = points[start];
    let maxPoint = points[start];
    for (let index = start + 1; index < end; index += 1) {
      if (points[index][valueKey] < minPoint[valueKey]) minPoint = points[index];
      if (points[index][valueKey] > maxPoint[valueKey]) maxPoint = points[index];
    }
    if (minPoint.time <= maxPoint.time) output.push(minPoint, maxPoint);
    else output.push(maxPoint, minPoint);
  }

  return output.filter((point, index) => index === 0 || point !== output[index - 1]);
}

function formatChartTime(timestamp, totalSpanMs) {
  const date = new Date(timestamp);
  if (totalSpanMs > 24 * 60 * 60 * 1000) {
    return date.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  if (totalSpanMs > 60 * 60 * 1000) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTooltipTime(timestamp, totalSpanMs) {
  const date = new Date(timestamp);
  return totalSpanMs > 24 * 60 * 60 * 1000
    ? date.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function createLineChart(canvas, unit, colourVariable, decimals, minimumSpan, emptyText) {
  const context = canvas.getContext("2d");
  let lastArgs = null;
  let hoverPoint = null;
  let geometry = null;
  let displayedPoints = [];

  function draw(fullPoints, valueKey, options = {}) {
    lastArgs = { fullPoints, valueKey, options };
    const source = options.compress
      ? compressForDisplay(fullPoints, valueKey, MAX_HISTORY_DRAW_POINTS)
      : fullPoints;
    displayedPoints = source;

    const parent = canvas.parentElement;
    const cssWidth = Math.max(parent.clientWidth, 280);
    const cssHeight = Math.max(parent.clientHeight, 180);
    const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.floor(cssWidth * pixelRatio);
    canvas.height = Math.floor(cssHeight * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    const computed = getComputedStyle(document.documentElement);
    const lineColour = computed.getPropertyValue(colourVariable).trim();
    const textColour = computed.getPropertyValue("--muted").trim();
    const panelColour = computed.getPropertyValue("--surface-strong").trim();
    const gridColour = computed.getPropertyValue("--chart-grid").trim();
    const mainText = computed.getPropertyValue("--text").trim();

    const margin = { top: 20, right: 15, bottom: 34, left: 58 };
    const plotWidth = cssWidth - margin.left - margin.right;
    const plotHeight = cssHeight - margin.top - margin.bottom;
    context.font = "11px system-ui, sans-serif";
    context.lineWidth = 1;

    if (source.length === 0) {
      geometry = null;
      context.fillStyle = textColour;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(emptyText, cssWidth / 2, cssHeight / 2);
      return;
    }

    const range = numberRange(source.map(point => Number(point[valueKey])), minimumSpan);
    let firstTime = Number.isFinite(options.startTime) ? options.startTime : source[0].time;
    let lastTime = Number.isFinite(options.endTime) ? options.endTime : source[source.length - 1].time;
    if (lastTime <= firstTime) lastTime = firstTime + 60000;
    const totalSpan = lastTime - firstTime;

    for (let line = 0; line <= 4; line += 1) {
      const ratio = line / 4;
      const y = margin.top + plotHeight * ratio;
      const label = range.max - (range.max - range.min) * ratio;
      context.strokeStyle = gridColour;
      context.beginPath();
      context.moveTo(margin.left, y);
      context.lineTo(margin.left + plotWidth, y);
      context.stroke();
      context.fillStyle = textColour;
      context.textAlign = "right";
      context.textBaseline = "middle";
      context.fillText(label.toFixed(decimals), margin.left - 8, y);
    }

    for (let tick = 0; tick <= 4; tick += 1) {
      const ratio = tick / 4;
      const x = margin.left + plotWidth * ratio;
      const tickTime = firstTime + totalSpan * ratio;
      context.strokeStyle = gridColour;
      context.beginPath();
      context.moveTo(x, margin.top);
      context.lineTo(x, margin.top + plotHeight);
      context.stroke();
      context.fillStyle = textColour;
      context.textAlign = tick === 0 ? "left" : tick === 4 ? "right" : "center";
      context.textBaseline = "top";
      context.fillText(formatChartTime(tickTime, totalSpan), x, margin.top + plotHeight + 9);
    }

    context.fillStyle = textColour;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(unit, 8, 6);

    const pointX = time => margin.left + ((time - firstTime) / totalSpan) * plotWidth;
    const pointY = value => margin.top + (1 - (value - range.min) / (range.max - range.min)) * plotHeight;

    context.save();
    context.beginPath();
    context.rect(margin.left, margin.top, plotWidth, plotHeight);
    context.clip();
    context.strokeStyle = lineColour;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    source.forEach((point, index) => {
      const x = pointX(point.time);
      const y = pointY(Number(point[valueKey]));
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();

    const latest = source[source.length - 1];
    context.fillStyle = lineColour;
    context.beginPath();
    context.arc(pointX(latest.time), pointY(Number(latest[valueKey])), 3.2, 0, Math.PI * 2);
    context.fill();

    if (hoverPoint) {
      const hx = pointX(hoverPoint.time);
      const hy = pointY(Number(hoverPoint[valueKey]));
      context.strokeStyle = textColour;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(hx, margin.top);
      context.lineTo(hx, margin.top + plotHeight);
      context.stroke();
      context.fillStyle = lineColour;
      context.beginPath();
      context.arc(hx, hy, 4, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();

    geometry = { margin, plotWidth, plotHeight, firstTime, lastTime, totalSpan, pointX, pointY, valueKey, cssWidth, cssHeight };

    if (hoverPoint) {
      const valueText = `${Number(hoverPoint[valueKey]).toFixed(decimals)} ${unit}`;
      const timeText = formatTooltipTime(hoverPoint.time, totalSpan);
      context.font = "11px system-ui, sans-serif";
      const width = Math.max(context.measureText(valueText).width, context.measureText(timeText).width) + 18;
      const height = 42;
      const hx = pointX(hoverPoint.time);
      const hy = pointY(Number(hoverPoint[valueKey]));
      let x = hx + 10;
      let y = hy - height - 8;
      if (x + width > cssWidth - 5) x = hx - width - 10;
      if (y < 5) y = hy + 10;
      context.fillStyle = panelColour;
      context.strokeStyle = lineColour;
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(x, y, width, height, 7);
      context.fill();
      context.stroke();
      context.fillStyle = mainText;
      context.textAlign = "left";
      context.textBaseline = "top";
      context.fillText(valueText, x + 9, y + 7);
      context.fillStyle = textColour;
      context.fillText(timeText, x + 9, y + 23);
    }
  }

  function updateHover(event) {
    if (!geometry || displayedPoints.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const { margin, plotWidth, firstTime, totalSpan } = geometry;
    if (x < margin.left || x > margin.left + plotWidth) {
      hoverPoint = null;
    } else {
      const targetTime = firstTime + ((x - margin.left) / plotWidth) * totalSpan;
      let nearest = displayedPoints[0];
      let nearestDistance = Math.abs(nearest.time - targetTime);
      for (let index = 1; index < displayedPoints.length; index += 1) {
        const distance = Math.abs(displayedPoints[index].time - targetTime);
        if (distance < nearestDistance) {
          nearest = displayedPoints[index];
          nearestDistance = distance;
        }
      }
      hoverPoint = nearest;
    }
    if (lastArgs) draw(lastArgs.fullPoints, lastArgs.valueKey, lastArgs.options);
  }

  canvas.addEventListener("pointermove", updateHover);
  canvas.addEventListener("pointerdown", updateHover);
  canvas.addEventListener("pointerleave", () => {
    hoverPoint = null;
    if (lastArgs) draw(lastArgs.fullPoints, lastArgs.valueKey, lastArgs.options);
  });

  return { draw };
}

function setMinMax(points, key, minimumElement, maximumElement, decimals) {
  const values = points.map(point => Number(point[key])).filter(Number.isFinite);
  if (values.length === 0) {
    const placeholder = decimals === 1 ? "--.-" : "----";
    minimumElement.textContent = placeholder;
    maximumElement.textContent = placeholder;
    return;
  }
  minimumElement.textContent = Math.min(...values).toFixed(decimals);
  maximumElement.textContent = Math.max(...values).toFixed(decimals);
}

function renderLive() {
  const now = Date.now();
  livePoints = livePoints.filter(point => point.time >= now - LIVE_WINDOW_MS - 5000);
  elements.livePointCount.textContent = livePoints.length.toLocaleString();
  const latest = livePoints[livePoints.length - 1];
  if (latest) {
    elements.liveTempLatest.textContent = latest.temperature.toFixed(1);
    elements.liveHumidityLatest.textContent = latest.humidity.toFixed(1);
    elements.livePressureLatest.textContent = latest.pressure.toFixed(1);
  }
  const options = { startTime: now - LIVE_WINDOW_MS, endTime: now, compress: false };
  charts.liveTemperature.draw(livePoints, "temperature", options);
  charts.liveHumidity.draw(livePoints, "humidity", options);
  charts.livePressure.draw(livePoints, "pressure", options);
}

function getHistoryView() {
  historyPoints = trimHistory(historyPoints);
  if (historyPoints.length === 0) {
    elements.historyPosition.disabled = true;
    elements.historyViewRange.textContent = "Full stored history";
    return { points: [], startTime: Date.now() - 60000, endTime: Date.now() };
  }

  const oldest = historyPoints[0].time;
  const newest = historyPoints[historyPoints.length - 1].time;
  const availableSpan = Math.max(newest - oldest, 60000);
  const requestedWindow = Number(elements.historyZoomSelect.value);

  if (!Number.isFinite(requestedWindow) || requestedWindow <= 0 || requestedWindow >= availableSpan) {
    elements.historyPosition.disabled = true;
    elements.historyViewRange.textContent = `Full history: ${new Date(oldest).toLocaleString()} — ${new Date(newest).toLocaleString()}`;
    return { points: historyPoints, startTime: oldest, endTime: Math.max(newest, oldest + 60000) };
  }

  elements.historyPosition.disabled = false;
  const ratio = Number(elements.historyPosition.value) / 1000;
  const startTime = oldest + (availableSpan - requestedWindow) * ratio;
  const endTime = startTime + requestedWindow;
  const visible = historyPoints.filter(point => point.time >= startTime && point.time <= endTime);
  elements.historyViewRange.textContent = `${new Date(startTime).toLocaleString()} — ${new Date(endTime).toLocaleString()}`;
  return { points: visible, startTime, endTime };
}

function renderHistory() {
  historyPoints = trimHistory(historyPoints);
  elements.historyPointCount.textContent = historyPoints.length.toLocaleString();

  setMinMax(historyPoints, "temperature", elements.tempMin, elements.tempMax, 1);
  setMinMax(historyPoints, "humidity", elements.humidityMin, elements.humidityMax, 1);
  setMinMax(historyPoints, "pressure", elements.pressureMin, elements.pressureMax, 1);

  const latest = historyPoints[historyPoints.length - 1];
  if (latest) {
    elements.historyTempLatest.textContent = latest.temperature.toFixed(1);
    elements.historyHumidityLatest.textContent = latest.humidity.toFixed(1);
    elements.historyPressureLatest.textContent = latest.pressure.toFixed(1);
  }

  const view = getHistoryView();
  const options = { startTime: view.startTime, endTime: view.endTime, compress: true };
  charts.historyTemperature.draw(view.points, "temperature", options);
  charts.historyHumidity.draw(view.points, "humidity", options);
  charts.historyPressure.draw(view.points, "pressure", options);
}

elements.mqttLoginForm.addEventListener("submit", event => {
  event.preventDefault();
  const username = elements.mqttUsername.value.trim();
  const password = elements.mqttPassword.value;
  if (!username || !password) {
    showLoginError("Enter the HiveMQ username and password.");
    return;
  }
  connectMqtt(username, password);
});

elements.changeLoginButton.addEventListener("click", disconnectForLoginChange);
elements.reloadHistory.addEventListener("click", requestRamHistory);
elements.historyZoomSelect.addEventListener("change", () => {
  if (Number(elements.historyZoomSelect.value) > 0) elements.historyPosition.value = "1000";
  renderHistory();
});
elements.historyPosition.addEventListener("input", renderHistory);
elements.resetHistoryZoom.addEventListener("click", () => {
  elements.historyZoomSelect.value = "0";
  elements.historyPosition.value = "1000";
  renderHistory();
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    renderLive();
    renderHistory();
  }, 120);
});

window.addEventListener("beforeunload", () => {
  manualDisconnect = true;
  if (client) {
    try { client.end(true); } catch (error) { /* page closing */ }
  }
});

loadRememberedUsername();
updateHistorySummary();
renderLive();
renderHistory();
