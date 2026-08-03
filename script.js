"use strict";

// ============================================================================
// ID BME280 ENVIRONMENT MONITOR
//
// The ESP32 publishes live readings and stores 2,880 one-minute averages in
// RAM. This page requests that RAM history through MQTT, rebuilds the timeline,
// and draws temperature, humidity, and pressure graphs in the browser.
// ============================================================================

const MQTT_CONFIG = {
  url:
    "wss://e1fe53e3c20b4f3daf38aafa8e16ff4b.s1.eu.hivemq.cloud:8884/mqtt",

  telemetryTopic:
    "illsley/bme280/telemetry",

  statusTopic:
    "illsley/bme280/status",

  historyRequestTopic:
    "illsley/bme280/history/request",

  historyDataTopic:
    "illsley/bme280/history/data",

  historyCompleteTopic:
    "illsley/bme280/history/complete"
};

const USERNAME_STORAGE_KEY =
  "illsley-bme280-mqtt-username";

const HISTORY_WINDOW_MS =
  48 * 60 * 60 * 1000;

const ESP_HISTORY_CAPACITY = 2880;
const MAX_DRAW_POINTS = 1400;
const HISTORY_REQUEST_TIMEOUT_MS = 30000;

let client = null;
let connectedOnce = false;
let manualDisconnect = false;
let currentUsername = "";

let history = [];
let pendingLivePoints = [];

let historyRequestId = "";
let historyRequestReferenceTime = 0;
let historyLoading = false;
let historyRequestTimer = null;
let expectedHistoryParts = 0;
let reportedHistoryRecords = 0;
let reportedHistoryCapacity = ESP_HISTORY_CAPACITY;

const receivedHistoryParts = new Map();

const elements = {
  overallStatus:
    document.getElementById("overallStatus"),

  loginPanel:
    document.getElementById("loginPanel"),

  mqttLoginForm:
    document.getElementById("mqttLoginForm"),

  mqttUsername:
    document.getElementById("mqttUsername"),

  mqttPassword:
    document.getElementById("mqttPassword"),

  rememberUsername:
    document.getElementById("rememberUsername"),

  connectButton:
    document.getElementById("connectButton"),

  loginError:
    document.getElementById("loginError"),

  connectedPanel:
    document.getElementById("connectedPanel"),

  connectedUsername:
    document.getElementById("connectedUsername"),

  changeLoginButton:
    document.getElementById("changeLoginButton"),

  sensorStatus:
    document.getElementById("sensorStatus"),

  temperature:
    document.getElementById("temperature"),

  humidity:
    document.getElementById("humidity"),

  pressure:
    document.getElementById("pressure"),

  tempMin:
    document.getElementById("tempMin"),

  tempMax:
    document.getElementById("tempMax"),

  humidityMin:
    document.getElementById("humidityMin"),

  humidityMax:
    document.getElementById("humidityMax"),

  pressureMin:
    document.getElementById("pressureMin"),

  pressureMax:
    document.getElementById("pressureMax"),

  tempChartLatest:
    document.getElementById("tempChartLatest"),

  humidityChartLatest:
    document.getElementById("humidityChartLatest"),

  pressureChartLatest:
    document.getElementById("pressureChartLatest"),

  rssi:
    document.getElementById("rssi"),

  uptime:
    document.getElementById("uptime"),

  lastUpdate:
    document.getElementById("lastUpdate"),

  pointCount:
    document.getElementById("pointCount"),

  historyLoadStatus:
    document.getElementById("historyLoadStatus"),

  historyRecordCount:
    document.getElementById("historyRecordCount"),

  historyTimeSpan:
    document.getElementById("historyTimeSpan"),

  reloadHistory:
    document.getElementById("reloadHistory")
};

const charts = {
  temperature:
    createLineChart(
      document.getElementById("temperatureChart"),
      "°C",
      "--amber",
      1
    ),

  humidity:
    createLineChart(
      document.getElementById("humidityChart"),
      "%",
      "--cyan",
      1
    ),

  pressure:
    createLineChart(
      document.getElementById("pressureChart"),
      "hPa",
      "--blue",
      0
    )
};

// ============================================================================
// LOGIN AND MQTT CONNECTION
// ============================================================================
function loadRememberedUsername() {
  const remembered =
    localStorage.getItem(USERNAME_STORAGE_KEY);

  if (remembered) {
    elements.mqttUsername.value = remembered;
  } else if (!elements.mqttUsername.value) {
    elements.mqttUsername.value = "bme280";
  }

  elements.rememberUsername.checked = true;

  if (elements.mqttUsername.value) {
    elements.mqttPassword.focus();
  } else {
    elements.mqttUsername.focus();
  }
}

function saveUsernamePreference(username) {
  if (elements.rememberUsername.checked) {
    localStorage.setItem(
      USERNAME_STORAGE_KEY,
      username
    );
  } else {
    localStorage.removeItem(
      USERNAME_STORAGE_KEY
    );
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
  elements.connectButton.textContent =
    busy ? "Connecting…" : "Connect";

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
  elements.connectedUsername.textContent =
    `Connected as ${username}`;

  elements.mqttLoginForm.hidden = true;
  elements.connectedPanel.hidden = false;
}

function stopMqttClient() {
  clearHistoryRequestTimer();
  historyLoading = false;
  expectedHistoryParts = 0;
  receivedHistoryParts.clear();

  if (client) {
    const previousClient = client;
    client = null;

    try {
      previousClient.end(true);
    } catch (error) {
      console.warn(
        "Could not close MQTT cleanly:",
        error
      );
    }
  }
}

function disconnectForLoginChange() {
  manualDisconnect = true;
  connectedOnce = false;

  stopMqttClient();

  setConnectionStatus(
    "Not connected",
    "offline"
  );

  setHistoryStatus(
    "Enter the HiveMQ login"
  );

  elements.sensorStatus.textContent =
    "Unknown";

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
  pendingLivePoints = [];
  historyLoading = true;

  clearLoginError();
  setLoginBusy(true);
  setConnectionStatus(
    "Connecting…",
    "connecting"
  );
  setHistoryStatus(
    "Connecting to HiveMQ"
  );

  const clientId =
    "ID-BME280-WEB-" +
    Math.random()
      .toString(16)
      .slice(2, 10);

  try {
    client = mqtt.connect(
      MQTT_CONFIG.url,
      {
        clientId,
        username,
        password,
        clean: true,
        keepalive: 30,
        connectTimeout: 15000,
        reconnectPeriod: 5000,
        protocolVersion: 4
      }
    );
  } catch (error) {
    setLoginBusy(false);
    setConnectionStatus(
      "Connection failed",
      "offline"
    );
    showLoginError(
      error instanceof Error
        ? error.message
        : "Could not start the MQTT connection."
    );
    return;
  }

  client.on("connect", () => {
    connectedOnce = true;
    setLoginBusy(false);
    saveUsernamePreference(username);
    showConnectedPanel(username);

    setConnectionStatus(
      "MQTT connected",
      "online"
    );

    elements.reloadHistory.disabled = false;

    const subscriptions = [
      MQTT_CONFIG.telemetryTopic,
      MQTT_CONFIG.statusTopic,
      MQTT_CONFIG.historyDataTopic,
      MQTT_CONFIG.historyCompleteTopic
    ];

    client.subscribe(
      subscriptions,
      { qos: 0 },
      error => {
        if (error) {
          setHistoryStatus(
            "MQTT connected, but topic subscription failed"
          );
          console.error(error);
          return;
        }

        requestRamHistory();
      }
    );
  });

  client.on("message", (topic, payload) => {
    handleMqttMessage(
      topic,
      payload.toString()
    );
  });

  client.on("reconnect", () => {
    setConnectionStatus(
      "Reconnecting…",
      "connecting"
    );
  });

  client.on("offline", () => {
    setConnectionStatus(
      "MQTT offline",
      "offline"
    );
  });

  client.on("close", () => {
    if (!manualDisconnect) {
      setConnectionStatus(
        "MQTT disconnected",
        "offline"
      );
    }
  });

  client.on("error", error => {
    console.error("MQTT error:", error);

    if (!connectedOnce) {
      setLoginBusy(false);
      showLoginForm();
      setConnectionStatus(
        "Connection failed",
        "offline"
      );
      showLoginError(
        "HiveMQ rejected the connection. Check the bme280 username and password."
      );
    }
  });
}

// ============================================================================
// MQTT MESSAGE HANDLING
// ============================================================================
function handleMqttMessage(topic, text) {
  if (topic === MQTT_CONFIG.telemetryTopic) {
    handleTelemetry(text);
    return;
  }

  if (topic === MQTT_CONFIG.statusTopic) {
    handleDeviceStatus(text);
    return;
  }

  if (topic === MQTT_CONFIG.historyDataTopic) {
    handleHistoryData(text);
    return;
  }

  if (topic === MQTT_CONFIG.historyCompleteTopic) {
    handleHistoryComplete(text);
  }
}

function handleTelemetry(text) {
  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    console.warn("Invalid telemetry JSON:", text);
    return;
  }

  const temperature = Number(data.temperature);
  const humidity = Number(data.humidity);
  const pressure = Number(data.pressure);

  if (
    !Number.isFinite(temperature) ||
    !Number.isFinite(humidity) ||
    !Number.isFinite(pressure)
  ) {
    return;
  }

  const now = Date.now();

  elements.temperature.textContent =
    temperature.toFixed(1);

  elements.humidity.textContent =
    humidity.toFixed(1);

  elements.pressure.textContent =
    pressure.toFixed(0);

  elements.tempChartLatest.textContent =
    temperature.toFixed(1);

  elements.humidityChartLatest.textContent =
    humidity.toFixed(1);

  elements.pressureChartLatest.textContent =
    pressure.toFixed(0);

  const rssi = Number(data.rssi);
  elements.rssi.textContent =
    Number.isFinite(rssi)
      ? `${Math.round(rssi)} dBm`
      : "-- dBm";

  elements.uptime.textContent =
    formatUptime(Number(data.uptime));

  elements.lastUpdate.textContent =
    new Date(now).toLocaleString();

  elements.sensorStatus.textContent =
    "Online";
  elements.sensorStatus.style.color =
    "var(--green)";

  const recordCount =
    Number(data.historyRecords);

  if (Number.isFinite(recordCount)) {
    reportedHistoryRecords = Math.max(
      0,
      Math.min(
        Math.round(recordCount),
        ESP_HISTORY_CAPACITY
      )
    );
  }

  const capacity =
    Number(data.historyCapacity);

  if (Number.isFinite(capacity)) {
    reportedHistoryCapacity = Math.max(
      1,
      Math.round(capacity)
    );
  }

  updateHistorySummary();

  const point = {
    time: now,
    temperature,
    humidity,
    pressure
  };

  if (historyLoading) {
    pendingLivePoints.push(point);
  } else {
    history = deduplicatePoints([
      ...history,
      point
    ]);

    renderHistory();
  }
}

function handleDeviceStatus(text) {
  const status = text.trim().toLowerCase();

  if (status === "online") {
    elements.sensorStatus.textContent =
      "Online";
    elements.sensorStatus.style.color =
      "var(--green)";
  } else {
    elements.sensorStatus.textContent =
      text.trim() || "Unknown";
    elements.sensorStatus.style.color =
      "var(--amber)";
  }
}

function handleHistoryData(text) {
  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    console.warn("Invalid history JSON:", text);
    return;
  }

  if (
    !historyLoading ||
    data.requestId !== historyRequestId
  ) {
    return;
  }

  const part = Number(data.part);
  const totalParts = Number(data.totalParts);

  if (
    !Number.isInteger(part) ||
    part < 0 ||
    !Array.isArray(data.records)
  ) {
    return;
  }

  if (
    Number.isInteger(totalParts) &&
    totalParts >= 0
  ) {
    expectedHistoryParts = totalParts;
  }

  receivedHistoryParts.set(
    part,
    data.records
  );

  const expectedText =
    expectedHistoryParts > 0
      ? ` of ${expectedHistoryParts}`
      : "";

  setHistoryStatus(
    `Loading RAM history — part ${receivedHistoryParts.size}${expectedText}`
  );

  restartHistoryRequestTimer();
}

function handleHistoryComplete(text) {
  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    console.warn(
      "Invalid history-complete JSON:",
      text
    );
    return;
  }

  if (
    !historyLoading ||
    data.requestId !== historyRequestId
  ) {
    return;
  }

  const recordCount = Number(data.records);

  if (Number.isFinite(recordCount)) {
    reportedHistoryRecords = Math.max(
      0,
      Math.min(
        Math.round(recordCount),
        ESP_HISTORY_CAPACITY
      )
    );
  }

  finishHistoryLoad(false);
}

// ============================================================================
// RAM HISTORY REQUEST AND REBUILD
// ============================================================================
function createRequestId() {
  return (
    "web_" +
    Date.now().toString(36) +
    "_" +
    Math.random()
      .toString(16)
      .slice(2, 9)
  ).slice(0, 32);
}

function requestRamHistory() {
  if (!client || !client.connected) {
    setHistoryStatus(
      "MQTT is not connected"
    );
    return;
  }

  clearHistoryRequestTimer();

  historyRequestId = createRequestId();
  historyRequestReferenceTime = Date.now();
  historyLoading = true;
  expectedHistoryParts = 0;
  receivedHistoryParts.clear();
  pendingLivePoints = [];

  elements.reloadHistory.disabled = true;

  setHistoryStatus(
    "Requesting history from ESP32 RAM…"
  );

  client.publish(
    MQTT_CONFIG.historyRequestTopic,
    historyRequestId,
    {
      qos: 0,
      retain: false
    },
    error => {
      if (error) {
        historyLoading = false;
        elements.reloadHistory.disabled = false;
        setHistoryStatus(
          "History request could not be sent"
        );
        console.error(error);
        return;
      }

      restartHistoryRequestTimer();
    }
  );
}

function restartHistoryRequestTimer() {
  clearHistoryRequestTimer();

  historyRequestTimer = window.setTimeout(
    () => {
      if (!historyLoading) {
        return;
      }

      finishHistoryLoad(true);
    },
    HISTORY_REQUEST_TIMEOUT_MS
  );
}

function clearHistoryRequestTimer() {
  if (historyRequestTimer !== null) {
    window.clearTimeout(
      historyRequestTimer
    );
    historyRequestTimer = null;
  }
}

function buildPointsFromReceivedParts() {
  const points = [];

  const orderedParts =
    [...receivedHistoryParts.entries()]
      .sort(
        (first, second) =>
          first[0] - second[0]
      );

  for (const [, records] of orderedParts) {
    for (const record of records) {
      if (
        !Array.isArray(record) ||
        record.length < 4
      ) {
        continue;
      }

      const ageSeconds = Number(record[0]);
      const temperatureX100 = Number(record[1]);
      const humidityX100 = Number(record[2]);
      const pressureX10 = Number(record[3]);

      if (
        !Number.isFinite(ageSeconds) ||
        !Number.isFinite(temperatureX100) ||
        !Number.isFinite(humidityX100) ||
        !Number.isFinite(pressureX10)
      ) {
        continue;
      }

      points.push({
        time:
          historyRequestReferenceTime -
          Math.max(0, ageSeconds) * 1000,
        temperature:
          temperatureX100 / 100,
        humidity:
          humidityX100 / 100,
        pressure:
          pressureX10 / 10
      });
    }
  }

  return points;
}

function finishHistoryLoad(timedOut) {
  clearHistoryRequestTimer();

  const ramPoints =
    buildPointsFromReceivedParts();

  history = deduplicatePoints([
    ...ramPoints,
    ...pendingLivePoints
  ]);

  pendingLivePoints = [];
  historyLoading = false;
  elements.reloadHistory.disabled =
    !(client && client.connected);

  renderHistory();
  updateHistorySummary();

  if (timedOut) {
    if (ramPoints.length > 0) {
      setHistoryStatus(
        `History timed out — showing ${ramPoints.length.toLocaleString()} received records`
      );
    } else {
      setHistoryStatus(
        "No RAM history received. The ESP32 may have just restarted."
      );
    }
  } else if (reportedHistoryRecords === 0) {
    setHistoryStatus(
      "ESP32 RAM history is empty — the first average appears after one minute"
    );
  } else {
    setHistoryStatus(
      `RAM history loaded — ${reportedHistoryRecords.toLocaleString()} one-minute records`
    );
  }

  receivedHistoryParts.clear();
  expectedHistoryParts = 0;
}

// ============================================================================
// DATA HELPERS
// ============================================================================
function setConnectionStatus(text, state) {
  elements.overallStatus.textContent = text;
  elements.overallStatus.className =
    `status-pill ${state}`;
}

function setHistoryStatus(text) {
  elements.historyLoadStatus.textContent =
    text;
}

function formatUptime(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) {
    return "--";
  }

  const seconds = Math.max(
    0,
    Math.floor(totalSeconds)
  );

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(
    (seconds % 86400) / 3600
  );
  const minutes = Math.floor(
    (seconds % 3600) / 60
  );

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function formatStoredDuration(recordCount) {
  const totalMinutes = Math.max(
    0,
    Math.round(recordCount)
  );

  const hours = Math.floor(
    totalMinutes / 60
  );
  const minutes = totalMinutes % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h stored`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m stored`;
  }

  return `${minutes} min stored`;
}

function updateHistorySummary() {
  elements.historyRecordCount.textContent =
    `${reportedHistoryRecords.toLocaleString()} / ${reportedHistoryCapacity.toLocaleString()} records`;

  elements.historyTimeSpan.textContent =
    formatStoredDuration(
      reportedHistoryRecords
    );
}

function trimTo48Hours(points) {
  const earliest =
    Date.now() - HISTORY_WINDOW_MS;

  return points
    .filter(point =>
      point &&
      Number.isFinite(point.time) &&
      point.time >= earliest &&
      Number.isFinite(point.temperature) &&
      Number.isFinite(point.humidity) &&
      Number.isFinite(point.pressure)
    )
    .sort(
      (first, second) =>
        first.time - second.time
    );
}

function deduplicatePoints(points) {
  const sorted = trimTo48Hours(points);
  const deduplicated = [];

  for (const point of sorted) {
    const previous =
      deduplicated[
        deduplicated.length - 1
      ];

    if (
      previous &&
      Math.abs(
        previous.time - point.time
      ) < 2000 &&
      Math.abs(
        previous.temperature -
        point.temperature
      ) < 0.001 &&
      Math.abs(
        previous.humidity -
        point.humidity
      ) < 0.001 &&
      Math.abs(
        previous.pressure -
        point.pressure
      ) < 0.001
    ) {
      continue;
    }

    deduplicated.push(point);
  }

  return deduplicated;
}

function downsamplePoints(
  points,
  maximumPoints
) {
  if (points.length <= maximumPoints) {
    return points;
  }

  const result = [];
  const bucketSize =
    points.length / maximumPoints;

  for (
    let bucket = 0;
    bucket < maximumPoints;
    bucket += 1
  ) {
    const start = Math.floor(
      bucket * bucketSize
    );

    const end = Math.min(
      Math.floor(
        (bucket + 1) * bucketSize
      ),
      points.length
    );

    if (end <= start) {
      continue;
    }

    const middle = Math.floor(
      (start + end - 1) / 2
    );

    result.push(points[middle]);
  }

  const newest =
    points[points.length - 1];

  if (
    result.length === 0 ||
    result[result.length - 1] !== newest
  ) {
    result.push(newest);
  }

  return result;
}

function numberRange(values) {
  const finite =
    values.filter(Number.isFinite);

  if (finite.length === 0) {
    return { min: 0, max: 1 };
  }

  let minimum = Math.min(...finite);
  let maximum = Math.max(...finite);

  if (minimum === maximum) {
    const padding = Math.max(
      Math.abs(minimum) * 0.01,
      0.5
    );
    minimum -= padding;
    maximum += padding;
  } else {
    const padding =
      (maximum - minimum) * 0.12;
    minimum -= padding;
    maximum += padding;
  }

  return {
    min: minimum,
    max: maximum
  };
}

function formatChartTime(
  timestamp,
  totalSpanMs
) {
  const date = new Date(timestamp);

  if (totalSpanMs > 24 * 60 * 60 * 1000) {
    return date.toLocaleString(
      [],
      {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit"
      }
    );
  }

  return date.toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit"
    }
  );
}

// ============================================================================
// CANVAS GRAPHS
// ============================================================================
function createLineChart(
  canvas,
  unit,
  colourVariable,
  decimals
) {
  const context =
    canvas.getContext("2d");

  function draw(fullPoints, valueKey) {
    const points = downsamplePoints(
      fullPoints,
      MAX_DRAW_POINTS
    );

    const parent = canvas.parentElement;
    const cssWidth = Math.max(
      parent.clientWidth,
      280
    );
    const cssHeight = Math.max(
      parent.clientHeight,
      180
    );
    const pixelRatio = Math.max(
      window.devicePixelRatio || 1,
      1
    );

    canvas.width = Math.floor(
      cssWidth * pixelRatio
    );
    canvas.height = Math.floor(
      cssHeight * pixelRatio
    );

    context.setTransform(
      pixelRatio,
      0,
      0,
      pixelRatio,
      0,
      0
    );

    context.clearRect(
      0,
      0,
      cssWidth,
      cssHeight
    );

    const computed = getComputedStyle(
      document.documentElement
    );

    const lineColour = computed
      .getPropertyValue(colourVariable)
      .trim();
    const textColour = computed
      .getPropertyValue("--muted")
      .trim();
    const gridColour = computed
      .getPropertyValue("--chart-grid")
      .trim();

    const margin = {
      top: 20,
      right: 15,
      bottom: 34,
      left: 56
    };

    const plotWidth =
      cssWidth - margin.left - margin.right;
    const plotHeight =
      cssHeight - margin.top - margin.bottom;

    context.font =
      "11px system-ui, sans-serif";
    context.lineWidth = 1;

    if (points.length === 0) {
      context.fillStyle = textColour;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(
        "Waiting for history data",
        cssWidth / 2,
        cssHeight / 2
      );
      return;
    }

    const values = points.map(
      point => Number(point[valueKey])
    );
    const range = numberRange(values);

    for (let line = 0; line <= 4; line += 1) {
      const ratio = line / 4;
      const y =
        margin.top + plotHeight * ratio;
      const labelValue =
        range.max -
        (range.max - range.min) * ratio;

      context.strokeStyle = gridColour;
      context.beginPath();
      context.moveTo(margin.left, y);
      context.lineTo(
        margin.left + plotWidth,
        y
      );
      context.stroke();

      context.fillStyle = textColour;
      context.textAlign = "right";
      context.textBaseline = "middle";
      context.fillText(
        labelValue.toFixed(decimals),
        margin.left - 8,
        y
      );
    }

    const firstTime = points[0].time;
    let lastTime = points[points.length - 1].time;

    if (lastTime <= firstTime) {
      lastTime = firstTime + 60000;
    }

    const totalSpan = lastTime - firstTime;

    for (let tick = 0; tick <= 4; tick += 1) {
      const ratio = tick / 4;
      const x =
        margin.left + plotWidth * ratio;
      const tickTime =
        firstTime + totalSpan * ratio;

      context.strokeStyle = gridColour;
      context.beginPath();
      context.moveTo(x, margin.top);
      context.lineTo(
        x,
        margin.top + plotHeight
      );
      context.stroke();

      context.fillStyle = textColour;
      context.textAlign =
        tick === 0
          ? "left"
          : tick === 4
            ? "right"
            : "center";
      context.textBaseline = "top";
      context.fillText(
        formatChartTime(
          tickTime,
          totalSpan
        ),
        x,
        margin.top + plotHeight + 9
      );
    }

    context.fillStyle = textColour;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(
      unit,
      8,
      6
    );

    const pointX = time =>
      margin.left +
      ((time - firstTime) / totalSpan) *
      plotWidth;

    const pointY = value =>
      margin.top +
      (1 -
        (value - range.min) /
        (range.max - range.min)) *
      plotHeight;

    context.strokeStyle = lineColour;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();

    points.forEach((point, index) => {
      const x = pointX(point.time);
      const y = pointY(
        Number(point[valueKey])
      );

      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });

    context.stroke();

    const latest = points[points.length - 1];
    const latestX = pointX(latest.time);
    const latestY = pointY(
      Number(latest[valueKey])
    );

    context.fillStyle = lineColour;
    context.beginPath();
    context.arc(
      latestX,
      latestY,
      3.2,
      0,
      Math.PI * 2
    );
    context.fill();
  }

  return { draw };
}

function setMinMax(
  points,
  key,
  minimumElement,
  maximumElement,
  decimals
) {
  const values = points
    .map(point => Number(point[key]))
    .filter(Number.isFinite);

  if (values.length === 0) {
    minimumElement.textContent =
      decimals === 0 ? "----" : "--.-";
    maximumElement.textContent =
      decimals === 0 ? "----" : "--.-";
    return;
  }

  minimumElement.textContent =
    Math.min(...values).toFixed(decimals);
  maximumElement.textContent =
    Math.max(...values).toFixed(decimals);
}

function renderHistory() {
  history = trimTo48Hours(history);

  elements.pointCount.textContent =
    history.length.toLocaleString();

  setMinMax(
    history,
    "temperature",
    elements.tempMin,
    elements.tempMax,
    1
  );

  setMinMax(
    history,
    "humidity",
    elements.humidityMin,
    elements.humidityMax,
    1
  );

  setMinMax(
    history,
    "pressure",
    elements.pressureMin,
    elements.pressureMax,
    0
  );

  if (history.length > 0) {
    const latest =
      history[history.length - 1];

    elements.tempChartLatest.textContent =
      latest.temperature.toFixed(1);
    elements.humidityChartLatest.textContent =
      latest.humidity.toFixed(1);
    elements.pressureChartLatest.textContent =
      latest.pressure.toFixed(0);
  }

  charts.temperature.draw(
    history,
    "temperature"
  );
  charts.humidity.draw(
    history,
    "humidity"
  );
  charts.pressure.draw(
    history,
    "pressure"
  );
}

// ============================================================================
// PAGE EVENTS
// ============================================================================
elements.mqttLoginForm.addEventListener(
  "submit",
  event => {
    event.preventDefault();

    const username =
      elements.mqttUsername.value.trim();
    const password =
      elements.mqttPassword.value;

    if (!username || !password) {
      showLoginError(
        "Enter the HiveMQ username and password."
      );
      return;
    }

    connectMqtt(username, password);
  }
);

elements.changeLoginButton.addEventListener(
  "click",
  disconnectForLoginChange
);

elements.reloadHistory.addEventListener(
  "click",
  requestRamHistory
);

let resizeTimer = null;

window.addEventListener("resize", () => {
  if (resizeTimer !== null) {
    window.clearTimeout(resizeTimer);
  }

  resizeTimer = window.setTimeout(
    () => {
      resizeTimer = null;
      renderHistory();
    },
    120
  );
});

window.addEventListener("beforeunload", () => {
  manualDisconnect = true;

  if (client) {
    try {
      client.end(true);
    } catch (error) {
      // The page is closing, so no further action is needed.
    }
  }
});

loadRememberedUsername();
updateHistorySummary();
renderHistory();
