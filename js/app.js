const STORAGE_KEY = "observatorio-solar-v1";
const SOURCE_MIGRATION_KEY = "observatorio-solar-source-v2";
const SOLAR_RISE = 6.25;
const SOLAR_SET = 18.75;
const MAX_GAP_H = 1.5;
const DAY_COLORS = ["#f5c15d", "#7ec8ff", "#5ee0b5", "#ff7a59", "#c4b5fd", "#f9a8d4", "#93c5fd"];

const fmt = (n, d) => new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: d,
  maximumFractionDigits: d,
}).format(n);

const fmtTime = new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtClock = new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const fmtDate = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long" });
const fmtDay = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short" });

const powerOf = (r) => Number.isFinite(r.p) ? r.p : r.v * r.i;

let state = null;
let periodRange = "all";
let span = "period";
let metric = "power";
let analysisScope = "daylight";

function viewRange() {
  return span === "day" ? "today" : periodRange;
}
let tableExpanded = false;
let tableVisibleCount = 100;
let pollTimer = null;
let sensorState = "idle";
let toastTimer = 0;
let armClear = false;
const charts = {};
let mqttClient = null;
let mqttState = "off";
let mqttFailures = 0;
let lastMqttData = 0;
let liveT = null;
let lastCommitT = 0;
let thermalFrame = null;

// Fuentes del observatorio. El tablero abre la serie modelada completa y permite volver
// al panel real desde el selector. La clave de Supabase es la publicable: solo permite leer
// (y llamar a registrar(), que exige el token secreto del ESP32).
const DEFAULT_SOURCES = {
  mqttUrl: "wss://broker.hivemq.com:8884/mqtt",
  mqttTopic: "observatorio-solar/panel-k9m4",
  sbUrl: "https://ixwewxwsjclbgttiguwe.supabase.co",
  sbKey: "sb_publishable_JXV95QeB3gJRMn71o7q4JQ_UihDB3-K",
  sbDevice: "panel-k9m4-sim",
};

function defaultSettings() {
  return {
    name: "Módulo de prueba",
    site: "Sitio de medición",
    area: 1.7,
    endpoint: "",
    interval: 15,
    mqttUrl: "",
    mqttTopic: "",
    mqttUser: "",
    mqttPass: "",
    thermalMirror: false,
    ...DEFAULT_SOURCES,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.readings)) return null;
    const settings = { ...defaultSettings(), ...data.settings };
    // Ajustes guardados por versiones anteriores dejaban estas conexiones vacías
    Object.keys(DEFAULT_SOURCES).forEach((key) => {
      if (!settings[key]) settings[key] = DEFAULT_SOURCES[key];
    });
    // La versión publicada antes del dataset guardó panel-k9m4 en localStorage.
    // Se migra una sola vez; después, la elección del usuario vuelve a persistir.
    if (localStorage.getItem(SOURCE_MIGRATION_KEY) !== "done") {
      settings.sbDevice = DEFAULT_SOURCES.sbDevice;
      localStorage.setItem(SOURCE_MIGRATION_KEY, "done");
    }
    settings.area = Number(settings.area) > 0 ? Number(settings.area) : 1.7;
    settings.interval = Math.min(3600, Math.max(5, Number(settings.interval) || 15));
    // La simulación de 5 días de versiones anteriores no son mediciones: se descarta
    const readings = data.mode === "demo"
      ? []
      : data.readings.map(coerceReading).filter(Boolean).sort((a, b) => a.t - b.t);
    return { settings, readings, mode: "real" };
  } catch {
    return null;
  }
}

// DEFAULT_SOURCES debe existir antes de reconstruir la configuración guardada.
// De lo contrario, defaultSettings() falla durante la carga y se pierde la selección.
state = loadState();

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      settings: state.settings,
      readings: state.readings,
      mode: state.mode,
    }));
  } catch {
    toast("No pude guardar en este navegador. Exporta un CSV para no perder las lecturas.");
  }
}

function coerceReading(r) {
  if (!r) return null;
  const t = Number(r.t);
  const v = Number(r.v);
  const i = Number(r.i);
  if (!Number.isFinite(t) || !Number.isFinite(v) || !Number.isFinite(i)) return null;
  return {
    t, v, i,
    id: r.id == null ? null : Number(r.id),
    p: finiteOrNull(r.p),
    irr: finiteOrNull(r.irr),
    tp: finiteOrNull(r.tp),
    ta: finiteOrNull(r.ta),
    h: finiteOrNull(r.h),
    wind: finiteOrNull(r.wind),
    light: finiteOrNull(r.light),
    panelMin: finiteOrNull(r.panelMin),
    panelMax: finiteOrNull(r.panelMax),
    rssi: finiteOrNull(r.rssi),
    sourceType: r.sourceType || null,
    anomaly: r.anomaly || null,
    severity: r.severity || null,
    maintenanceState: r.maintenanceState || null,
    valid: r.valid == null ? null : Boolean(r.valid),
  };
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const PANEL_ACTIVE_POWER_W = 0.02;
const PANEL_MIN_LIGHT_WM2 = 25;
const PANEL_DIAGNOSTIC_LIGHT_WM2 = 120;

function panelOperatingState(reading) {
  if (!reading) return { key: "unknown", label: "Sin estado", detail: "Todavía no hay una lectura disponible." };
  const power = Math.max(0, powerOf(reading));
  const irradiance = finiteOrNull(reading.irr);
  const date = new Date(reading.t);
  const hour = date.getHours() + date.getMinutes() / 60;
  const daylightByClock = hour >= SOLAR_RISE && hour <= SOLAR_SET;
  if (power >= PANEL_ACTIVE_POWER_W) {
    return { key: "active", label: "Panel activo", detail: "El panel está entregando potencia." };
  }
  if ((irradiance != null && irradiance < PANEL_MIN_LIGHT_WM2) || (irradiance == null && !daylightByClock)) {
    return { key: "rest", label: "Reposo normal", detail: "No hay irradiancia suficiente; el panel apagado o en horario nocturno no representa una falla." };
  }
  if (irradiance == null || irradiance < PANEL_DIAGNOSTIC_LIGHT_WM2) {
    return { key: "low-light", label: "Luz insuficiente", detail: "Hay algo de luz, pero no alcanza para evaluar la producción." };
  }
  return { key: "review", label: "Revisar producción", detail: "Hay irradiancia suficiente, pero la potencia permanece anormalmente baja." };
}

function conditionLabel(value) {
  if (!value || value === "normal") return "Normal";
  return String(value).replaceAll("|", " + ").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function generateDemo(area) {
  const end = Date.now();
  const startDate = new Date(end);
  startDate.setDate(startDate.getDate() - 4);
  startDate.setHours(0, 0, 0, 0);
  const step = 10 * 60 * 1000;
  const readings = [];
  for (let t = startDate.getTime(); t <= end; t += step) {
    readings.push(sampleAt(t, area));
  }
  return readings;
}

function sampleAt(ts, area) {
  const date = new Date(ts);
  const hours = date.getHours() + date.getMinutes() / 60;
  const daySeed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  const rnd = mulberry32(daySeed);
  const roll = rnd();
  const clearness = roll < 0.22 ? 0.2 + rnd() * 0.16 : 0.6 + rnd() * 0.38;
  const phaseA = rnd() * Math.PI * 2;
  const phaseB = rnd() * Math.PI * 2;
  const dipCenter = 10 + rnd() * 6;
  const dipWidth = 0.7 + rnd() * 1.3;
  const dipDepth = 0.25 + rnd() * 0.45;
  const dayTemp = 16 + rnd() * 4;

  let light = 0;
  if (hours > SOLAR_RISE && hours < SOLAR_SET) {
    const x = (hours - SOLAR_RISE) / (SOLAR_SET - SOLAR_RISE);
    light = Math.sin(Math.PI * x);
  }

  const minute = hours * 60;
  let clouds = clearness * (0.84 + 0.16 * Math.sin(minute / 90 + phaseA));
  clouds *= 0.9 + 0.1 * Math.sin(minute / 37 + phaseB);
  const dist = Math.abs(hours - dipCenter);
  if (light > 0 && dist < dipWidth) clouds *= 1 - dipDepth * Math.cos((dist / dipWidth) * Math.PI / 2);
  clouds = clamp(clouds, 0.06, 1);

  const noise = () => (mulberry32((daySeed ^ Math.floor(ts / 60000)) >>> 0)() - 0.5);
  const irr = light <= 0 ? 0 : Math.max(0, 980 * light * clouds * (1 + noise() * 0.04));
  const ta = dayTemp + 11 * light + noise() * 0.4;
  const tp = ta + (irr / 1000) * 27 + (light > 0 ? noise() * 0.3 : 0);
  const h = clamp(76 - (ta - 18) * 1.15 - irr * 0.012 + noise() * 2, 22, 96);
  const wind = clamp(0.3 + light * 2.4 + Math.abs(noise()) * 1.2, 0, 8);

  let v = 0;
  let i = 0;
  if (irr >= 15) {
    const rise = clamp((irr - 15) / 120, 0, 1);
    v = 33.6 * (1 - 0.0031 * (tp - 25)) * (0.74 + 0.26 * rise);
    v *= 1 + noise() * 0.004;
    const p = 0.185 * area * irr * (1 - 0.004 * (tp - 25));
    i = Math.max(0, p / v) * (1 + noise() * 0.015);
  }

  return {
    t: ts,
    v: roundTo(v, 2),
    i: roundTo(i, 3),
    irr: roundTo(irr, 0),
    tp: roundTo(tp, 1),
    ta: roundTo(ta, 1),
    h: roundTo(h, 0),
    wind: roundTo(wind, 1),
  };
}

function roundTo(n, digits) {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function energyWh(readings) {
  if (readings.length < 2) return 0;
  let wh = 0;
  for (let i = 1; i < readings.length; i += 1) {
    const dt = (readings[i].t - readings[i - 1].t) / 3600000;
    if (dt <= 0 || dt > MAX_GAP_H) continue;
    wh += ((powerOf(readings[i - 1]) + powerOf(readings[i])) / 2) * dt;
  }
  return wh;
}

function inRange(readings, key, now = clockNow()) {
  if (key === "all") return readings.filter((r) => r.t <= now + 60000);
  let from = now - 7 * 86400000;
  if (key === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    from = start.getTime();
  } else if (key === "48h") {
    from = now - 48 * 3600000;
  }
  return readings.filter((r) => r.t >= from && r.t <= now + 60000);
}

function rangeTitle(key) {
  if (key === "today") return "Hoy";
  if (key === "48h") return "48 horas";
  if (key === "7d") return "7 días";
  return "Todo el registro";
}

function energyLabel(key) {
  if (key === "today") return "Energía hoy";
  if (key === "48h") return "Energía 48 h";
  if (key === "7d") return "Energía 7 días";
  return "Energía total";
}

function formatPower(w) {
  if (!Number.isFinite(w)) return { value: "—", unit: "W" };
  if (Math.abs(w) >= 1000) return { value: fmt(w / 1000, 2), unit: "kW" };
  return { value: fmt(w, w >= 100 ? 0 : 1), unit: "W" };
}

function formatEnergy(wh) {
  if (!Number.isFinite(wh)) return { value: "—", unit: "Wh" };
  if (Math.abs(wh) >= 1000) return { value: fmt(wh / 1000, 2), unit: "kWh" };
  return { value: fmt(wh, 0), unit: "Wh" };
}

function formatLatest(ts) {
  const date = new Date(ts);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const offsetHours = Math.round(-date.getTimezoneOffset() / 60);
  const sign = offsetHours >= 0 ? "+" : "";
  return `${String(date.getDate()).padStart(2, "0")}-${months[date.getMonth()]} · ${fmtTime.format(date)} / UTC${sign}${offsetHours}`;
}

function formatWhen(ts) {
  const date = new Date(ts);
  const now = new Date();
  const hm = fmtTime.format(date);
  if (date.toDateString() === now.toDateString()) return `Hoy ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return `Ayer ${hm}`;
  return `${fmtDay.format(date)} ${hm}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function average(values) {
  const list = values.filter(Number.isFinite);
  if (!list.length) return null;
  return list.reduce((sum, n) => sum + n, 0) / list.length;
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const weight = position - lower;
  return sorted[lower + 1] == null
    ? sorted[lower]
    : sorted[lower] + (sorted[lower + 1] - sorted[lower]) * weight;
}

function describe(values) {
  const list = values.filter(Number.isFinite);
  if (!list.length) return null;
  const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
  const variance = list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / list.length;
  return {
    n: list.length,
    min: Math.min(...list),
    mean,
    median: quantile(list, 0.5),
    p95: quantile(list, 0.95),
    max: Math.max(...list),
    sd: Math.sqrt(variance),
  };
}

function linearRelationship(rows) {
  const pairs = rows
    .map((reading) => ({ x: finiteOrNull(reading.irr), y: finiteOrNull(powerOf(reading)) }))
    .filter((point) => point.x != null && point.y != null);
  if (pairs.length < 2) return { pairs, r: null, slope: null, intercept: null };
  const xMean = average(pairs.map((point) => point.x));
  const yMean = average(pairs.map((point) => point.y));
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  pairs.forEach((point) => {
    const dx = point.x - xMean;
    const dy = point.y - yMean;
    covariance += dx * dy;
    xVariance += dx * dx;
    yVariance += dy * dy;
  });
  const divisor = Math.sqrt(xVariance * yVariance);
  return {
    pairs,
    r: divisor > 0 ? covariance / divisor : null,
    slope: xVariance > 0 ? covariance / xVariance : null,
    intercept: xVariance > 0 ? yMean - (covariance / xVariance) * xMean : null,
  };
}

function correlationLabel(value) {
  const magnitude = Math.abs(value || 0);
  if (!Number.isFinite(value)) return "sin suficientes datos";
  if (magnitude >= 0.9) return "relación muy fuerte";
  if (magnitude >= 0.7) return "relación fuerte";
  if (magnitude >= 0.5) return "relación moderada";
  if (magnitude >= 0.3) return "relación débil";
  return "relación muy débil";
}

function stride(list, count) {
  if (list.length <= count) return list;
  const out = [];
  const step = (list.length - 1) / (count - 1);
  for (let i = 0; i < count; i += 1) out.push(list[Math.round(i * step)]);
  return out;
}

function deltaText(current, previous, digits) {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return "última muestra";
  const delta = current - previous;
  const tol = Math.max(Math.abs(current) * 0.004, digits === 0 ? 0.5 : 0.03);
  if (Math.abs(delta) < tol) return "estable";
  const arrow = delta > 0 ? "▲" : "▼";
  return `${arrow} ${fmt(Math.abs(delta), digits)}`;
}

function dailyEnergy(readings) {
  const groups = new Map();
  readings.forEach((r) => {
    const key = dayKey(r.t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  return [...groups.entries()].map(([key, rows]) => ({
    key,
    t: rows[0].t,
    wh: energyWh(rows),
  }));
}

function energyUntilSameHour(readings, dayOffset) {
  const now = new Date(clockNow());
  const start = new Date(now);
  start.setDate(now.getDate() + dayOffset);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
  const slice = readings.filter((r) => r.t >= start.getTime() && r.t <= end.getTime());
  return energyWh(slice);
}

function buildInsights(all, viewed) {
  if (!viewed.length) return ["Todavía no hay mediciones en este periodo."];
  const notes = [];
  const area = state.settings.area;
  const todayStart = startOfDay(clockNow());
  const today = all.filter((r) => r.t >= todayStart);
  const eToday = energyWh(today);
  const eYday = energyUntilSameHour(all, -1);
  const eNow = energyUntilSameHour(all, 0);
  const peak = viewed.reduce((best, r) => (powerOf(r) > powerOf(best) ? r : best), viewed[0]);
  if (today.length > 1) {
    notes.push(`Hoy van ${formatEnergy(eToday).value} ${formatEnergy(eToday).unit}. El pico del periodo fue ${formatPower(powerOf(peak)).value} ${formatPower(powerOf(peak)).unit} a las ${formatWhen(peak.t)}.`);
  } else {
    const periodEnergy = formatEnergy(energyWh(viewed));
    notes.push(`En el periodo hay ${periodEnergy.value} ${periodEnergy.unit}. El pico fue ${formatPower(powerOf(peak)).value} ${formatPower(powerOf(peak)).unit} a las ${formatWhen(peak.t)}.`);
  }

  if (today.length > 1 && eYday > 30 && eNow >= 0) {
    const pct = ((eNow - eYday) / eYday) * 100;
    if (Math.abs(pct) < 4) notes.push("A esta hora, hoy va casi igual que ayer.");
    else {
      const side = pct > 0 ? "por encima" : "por debajo";
      notes.push(`A esta hora, hoy va ${fmt(Math.abs(pct), 0)} % ${side} de la energía de ayer.`);
    }
  }

  const daylight = viewed.filter((r) => r.irr != null && r.irr > 80);
  if (daylight.length > 8) {
    const ordered = [...daylight].sort((a, b) => a.irr - b.irr);
    const mid = Math.floor(ordered.length / 2);
    const low = average(ordered.slice(0, mid).map((r) => r.i));
    const high = average(ordered.slice(mid).map((r) => r.i));
    if (high > low * 1.15) {
      notes.push("La corriente crece cuando sube la radiación. El panel está respondiendo como se espera.");
    } else if (high < low * 0.95) {
      notes.push("La corriente no acompaña a la radiación. Conviene revisar sombras, suciedad o si la carga sigue conectada.");
    }
  }

  const withTemp = viewed.filter((r) => r.tp != null);
  if (withTemp.length) {
    const hot = withTemp.reduce((best, r) => (r.tp > best.tp ? r : best), withTemp[0]);
    if (hot.tp >= 60) {
      notes.push(`El panel llegó a ${fmt(hot.tp, 1)} °C. Por encima de 60 °C suele caer la potencia; vale la pena cuidar la ventilación.`);
    } else if (hot.tp >= 45) {
      notes.push(`La temperatura máxima del panel fue ${fmt(hot.tp, 1)} °C. Al calentarse, el voltaje baja un poco: es normal en silicio.`);
    }
  }

  const warm = viewed.filter((r) => r.irr != null && r.irr > 400 && r.tp != null);
  const cool = warm.filter((r) => r.tp < 35);
  const hotter = warm.filter((r) => r.tp > 45);
  if (cool.length > 3 && hotter.length > 3) {
    const vc = average(cool.map((r) => r.v));
    const vh = average(hotter.map((r) => r.v));
    if (vh < vc - 0.4) {
      notes.push(`Con el panel caliente el voltaje pasa de ${fmt(vc, 1)} V a ${fmt(vh, 1)} V. Ese descenso con la temperatura es habitual.`);
    }
  }

  const latest = all[all.length - 1];
  const operation = panelOperatingState(latest);
  if (operation.key === "rest" || operation.key === "low-light") {
    notes.splice(1, 0, operation.detail);
  } else if (operation.key === "review") {
    notes.splice(1, 0, "Hay irradiancia suficiente, pero casi no hay potencia. Conviene revisar la carga, el cableado o una desconexión.");
  }

  const etas = viewed.map((r) => efficiencyOf(r, area)).filter((n) => n != null);
  const avgEta = average(etas);
  if (avgEta != null && avgEta > 28) {
    notes.push(`La eficiencia media sale en ${fmt(avgEta, 1)} %. Si el módulo no es de muy alta gama, revisa el área en ajustes: un área pequeña infla este número.`);
  }

  const gaps = [];
  for (let i = 1; i < daylight.length; i += 1) gaps.push((daylight[i].t - daylight[i - 1].t) / 60000);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  if (medianGap > 70) {
    notes.push("Las lecturas de sol están muy espaciadas, así que la energía es solo una parte. Conviene anotar al menos cada hora mientras haya luz.");
  }

  return notes.slice(0, 4);
}

function efficiencyOf(reading, area) {
  if (!area || reading.irr == null || reading.irr < 50) return null;
  return (powerOf(reading) / (reading.irr * area)) * 100;
}

function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = (min || 0) - 1;
    max = (max || 0) + 1;
  }
  const span = max - min;
  const rough = span / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const err = rough / mag;
  let step = mag;
  if (err >= 7.5) step = 10 * mag;
  else if (err >= 3.5) step = 5 * mag;
  else if (err >= 1.5) step = 2 * mag;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  const guard = Math.round((niceMax - niceMin) / step);
  for (let i = 0; i <= guard && i < 12; i += 1) ticks.push(niceMin + i * step);
  return { min: niceMin, max: niceMax || niceMin + step, step, ticks };
}

function formatTick(value, step) {
  if (Math.abs(value) < step * 0.01) return "0";
  const digits = step >= 10 ? 0 : step >= 1 ? 1 : 2;
  return fmt(value, digits);
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

class SolarChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cfg = null;
    this.hoverX = null;
    this.w = 0;
    this.h = 0;
    canvas.addEventListener("mousemove", (event) => {
      const rect = canvas.getBoundingClientRect();
      this.hoverX = event.clientX - rect.left;
      this.draw();
    });
    canvas.addEventListener("mouseleave", () => {
      this.hoverX = null;
      this.draw();
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(10, rect.width);
    this.h = Math.max(10, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setConfig(cfg) {
    this.cfg = cfg;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const width = this.w;
    const height = this.h;
    if (!ctx || !width) return;
    ctx.clearRect(0, 0, width, height);
    const cfg = this.cfg;
    if (!cfg || !cfg.series.some((s) => s.data.some((p) => Number.isFinite(p.y)))) {
      ctx.fillStyle = "#93a0b8";
      ctx.font = "14px IBM Plex Sans, sans-serif";
      ctx.fillText("Sin lecturas en este periodo", 16, 28);
      return;
    }

    const isBar = cfg.kind === "bar";
    const hasValues = (series) => series.data.some((point) => Number.isFinite(point.y));
    const hasRight = cfg.series.some((series) => series.axis === "right" && hasValues(series));
    const pad = { l: 58, r: hasRight ? 56 : 36, t: 12, b: 32 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;

    const leftSeries = cfg.series.filter((series) => series.axis !== "right" && hasValues(series));
    const rightSeries = cfg.series.filter((series) => series.axis === "right" && hasValues(series));
    const yLeft = domainOf(leftSeries.length ? leftSeries : cfg.series, cfg.yMin, cfg.yMax);
    const yRight = rightSeries.length ? domainOf(rightSeries) : null;

    let xMin = cfg.xMin;
    let xMax = cfg.xMax;
    if (xMin == null || xMax == null) {
      const xs = cfg.series.flatMap((s) => s.data.map((p) => p.x)).filter(Number.isFinite);
      xMin = Math.min(...xs);
      xMax = Math.max(...xs);
      if (xMax - xMin < 1) {
        xMin -= 1;
        xMax += 1;
      }
    }

    const xOf = (x) => pad.l + ((x - xMin) / (xMax - xMin)) * plotW;
    const yOf = (y, scale) => pad.t + plotH - ((y - scale.min) / (scale.max - scale.min)) * plotH;

    ctx.font = "11px IBM Plex Sans, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    yLeft.ticks.forEach((tick) => {
      const y = yOf(tick, yLeft);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(width - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = "#93a0b8";
      ctx.fillText(formatTick(tick, yLeft.step), pad.l - 8, y);
    });

    if (yRight) {
      ctx.textAlign = "left";
      yRight.ticks.forEach((tick) => {
        const y = yOf(tick, yRight);
        ctx.fillStyle = "#93a0b8";
        ctx.fillText(formatTick(tick, yRight.step), width - pad.r + 8, y);
      });
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    if (isBar) {
      const labels = cfg.labels || [];
      const availableLabels = Math.max(2, Math.floor(plotW / 48));
      const step = Math.max(1, Math.ceil(labels.length / availableLabels));
      labels.forEach((label, index) => {
        if (index % step !== 0 && index !== labels.length - 1) return;
        ctx.fillStyle = "#93a0b8";
        ctx.fillText(label, xOf(index), height - 22);
      });
    } else {
      const explicitTicks = cfg.xTicks && cfg.xTicks.length ? cfg.xTicks : null;
      const timedTicks = !explicitTicks && cfg.timeRange ? timeTicks(xMin, xMax) : null;
      let xTicks = (explicitTicks || (timedTicks && timedTicks.length ? timedTicks : niceTicks(xMin, xMax, 5).ticks))
        .filter((tick) => tick >= xMin - (xMax - xMin) * 0.02 && tick <= xMax + (xMax - xMin) * 0.02);
      const availableTicks = Math.max(2, Math.floor(plotW / 68));
      if (xTicks.length > availableTicks) {
        const sourceTicks = xTicks;
        xTicks = Array.from({ length: availableTicks }, (_, index) => (
          sourceTicks[Math.round((index / (availableTicks - 1)) * (sourceTicks.length - 1))]
        )).filter((tick, index, list) => index === 0 || tick !== list[index - 1]);
      }
      xTicks.forEach((tick) => {
        ctx.fillStyle = "#93a0b8";
        ctx.fillText(cfg.xFormat ? cfg.xFormat(tick) : String(tick), xOf(tick), height - 22);
      });
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, plotW, plotH);
    ctx.clip();

    cfg.series.forEach((series) => {
      const scale = series.axis === "right" && yRight ? yRight : yLeft;
      if (series.type === "bar") {
        const slot = plotW / Math.max(1, series.data.length);
        series.data.forEach((point, index) => {
          if (!Number.isFinite(point.y)) return;
          const bh = ((point.y - scale.min) / (scale.max - scale.min)) * plotH;
          const bw = Math.min(34, slot * 0.58);
          const x = pad.l + slot * index + (slot - bw) / 2;
          const y = pad.t + plotH - Math.max(0, bh);
          const grad = ctx.createLinearGradient(0, y, 0, pad.t + plotH);
          grad.addColorStop(0, series.color);
          grad.addColorStop(1, hexToRgba(series.color, 0.25));
          ctx.fillStyle = grad;
          roundRect(ctx, x, y, bw, Math.max(1, bh), 5);
          ctx.fill();
        });
        return;
      }

      if (series.type === "scatter") {
        ctx.fillStyle = hexToRgba(series.color, 0.42);
        series.data.forEach((point) => {
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
          ctx.beginPath();
          ctx.arc(xOf(point.x), yOf(point.y, scale), 2.2, 0, Math.PI * 2);
          ctx.fill();
        });
        return;
      }

      const segments = splitSegments(series.data);
      segments.forEach((segment) => {
        if (!segment.length) return;
        trace(ctx, segment, (p) => xOf(p.x), (p) => yOf(p.y, scale));
        if (series.type === "area") {
          ctx.lineTo(xOf(segment[segment.length - 1].x), pad.t + plotH);
          ctx.lineTo(xOf(segment[0].x), pad.t + plotH);
          ctx.closePath();
          const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
          grad.addColorStop(0, hexToRgba(series.color, 0.32));
          grad.addColorStop(1, hexToRgba(series.color, 0));
          ctx.fillStyle = grad;
          ctx.fill();
          trace(ctx, segment, (p) => xOf(p.x), (p) => yOf(p.y, scale));
        }
        ctx.strokeStyle = series.color;
        ctx.lineWidth = series.type === "area" ? 2.2 : 1.8;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.setLineDash(series.dash || []);
        ctx.stroke();
        ctx.setLineDash([]);
        if (segment.length <= 48) {
          ctx.fillStyle = series.color;
          segment.forEach((point) => {
            ctx.beginPath();
            ctx.arc(xOf(point.x), yOf(point.y, scale), 2.2, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      });
    });
    ctx.restore();

    if (this.hoverX == null || this.hoverX < pad.l || this.hoverX > width - pad.r) return;
    const rel = (this.hoverX - pad.l) / plotW;
    const xVal = isBar
      ? clamp(Math.floor(rel * cfg.labels.length), 0, cfg.labels.length - 1)
      : xMin + rel * (xMax - xMin);
    const rows = [];
    cfg.series.forEach((series) => {
      const point = isBar
        ? series.data[xVal]
        : nearestPoint(series.data, xVal);
      if (!point || !Number.isFinite(point.y)) return;
      const scale = series.axis === "right" && yRight ? yRight : yLeft;
      rows.push({ series, point, scale });
    });
    if (!rows.length) return;

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    const guideX = isBar ? xOf(xVal) : xOf(rows[0].point.x);
    ctx.moveTo(guideX, pad.t);
    ctx.lineTo(guideX, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    rows.forEach(({ series, point, scale }) => {
      ctx.fillStyle = series.color;
      ctx.beginPath();
      ctx.arc(xOf(point.x), yOf(point.y, scale), 4, 0, Math.PI * 2);
      ctx.fill();
    });

    const title = cfg.tooltipTitle
      ? cfg.tooltipTitle(isBar ? rows[0].point : rows[0].point)
      : "";
    const lines = rows.map(({ series, point }) => `${series.name}  ${fmt(point.y, series.digits ?? 1)} ${series.unit || ""}`.trim());
    drawTooltip(ctx, width, this.hoverX, pad.t + 8, title, lines);
  }
}

function domainOf(seriesList, forcedMin, forcedMax) {
  const values = seriesList.flatMap((s) => s.data.map((p) => p.y)).filter(Number.isFinite);
  if (!values.length) return niceTicks(0, 1, 4);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const zero = seriesList.some((s) => s.zero);
  if (zero) min = Math.min(0, min);
  if (forcedMin != null) min = forcedMin;
  if (forcedMax != null) max = forcedMax;
  if (min === max) max = min + 1;
  const span = max - min;
  const padTop = span * 0.14;
  const padBot = zero && min >= 0 ? 0 : span * 0.1;
  return niceTicks(min - padBot, max + padTop, 4);
}

function splitSegments(data) {
  const segments = [];
  let current = [];
  data.forEach((point) => {
    if (!Number.isFinite(point.y)) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(point);
  });
  if (current.length) segments.push(current);
  return segments;
}

function trace(ctx, segment, xOf, yOf) {
  ctx.beginPath();
  segment.forEach((point, index) => {
    const x = xOf(point);
    const y = yOf(point);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
}

function nearestPoint(data, xVal) {
  let best = null;
  let bestDist = Infinity;
  data.forEach((point) => {
    if (!Number.isFinite(point.y)) return;
    const dist = Math.abs(point.x - xVal);
    if (dist < bestDist) {
      best = point;
      bestDist = dist;
    }
  });
  return best;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawTooltip(ctx, width, hoverX, y, title, lines) {
  ctx.font = "12px IBM Plex Sans, sans-serif";
  const content = title ? [title, ...lines] : lines;
  const boxW = Math.max(...content.map((line) => ctx.measureText(line).width)) + 20;
  const boxH = content.length * 18 + 12;
  let x = hoverX + 14;
  if (x + boxW > width - 8) x = hoverX - boxW - 14;
  ctx.fillStyle = "rgba(10, 16, 28, 0.94)";
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  roundRect(ctx, x, y, boxW, boxH, 10);
  ctx.fill();
  ctx.stroke();
  content.forEach((line, index) => {
    ctx.fillStyle = index === 0 && title ? "#f5c15d" : "#eef3fb";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(line, x + 10, y + 8 + index * 18);
  });
}

function renderLegend(id, items, withUnit) {
  const host = document.getElementById(id);
  host.replaceChildren();
  items.forEach((item) => {
    const span = document.createElement("span");
    const swatch = document.createElement("i");
    if (item.dash) {
      swatch.className = "dashed";
      swatch.style.borderTopColor = item.color;
      swatch.style.color = item.color;
    } else {
      swatch.style.background = item.color;
    }
    const label = withUnit && item.unit ? `${item.name} (${item.unit})` : item.name;
    span.append(swatch, document.createTextNode(label));
    host.appendChild(span);
  });
}

function renderSpark(id, values, color) {
  const svg = document.getElementById(id);
  const nums = values.filter(Number.isFinite);
  if (nums.length < 2) {
    svg.innerHTML = "";
    return;
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const points = nums.map((value, index) => {
    const x = (index / (nums.length - 1)) * 120;
    const y = 30 - ((value - min) / span) * 26;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" />`;
}

function render() {
  if (cloudActive() && !sim.active && cloud.range !== viewRange()) loadCloud();
  const all = readingsSource();
  const viewed = inRange(all, viewRange());
  const latest = all[all.length - 1] || null;
  const prev = all.length > 1 ? all[all.length - 2] : null;
  renderIdentity();
  renderKpis(latest, viewed);
  renderEnergyCard(latest, viewed);
  renderInsights(all, viewed);
  renderVitals(latest, all);
  renderCharts(viewed);
  renderAnalytics(viewed);
  renderTable(viewed);
  renderBanner();
  renderStatus();
  document.getElementById("foot-count").textContent = all.length
    ? `${all.length.toLocaleString("es-MX")} ${cloudActive() && !sim.active ? "puntos del historial en la nube" : "lecturas guardadas"}`
    : "Sin lecturas guardadas";
  document.getElementById("foot-note").textContent = cloudActive() && !sim.active
    ? "El historial vive en Supabase. Exportar descarga el registro completo, sin promediar."
    : "Las lecturas se guardan en este navegador. Exporta un CSV para no perderlas.";
  document.querySelectorAll(".kpi[data-metric]").forEach((card) => {
    const on = card.dataset.metric === metric;
    card.classList.toggle("is-on", on);
    card.setAttribute("aria-pressed", on ? "true" : "false");
  });
  document.querySelectorAll("[data-span]").forEach((button) => {
    button.classList.toggle("active", button.dataset.span === span);
  });
  const periodSelect = document.getElementById("period-length");
  let todayOption = periodSelect.querySelector('[value="today"]');
  if (span === "day") {
    if (!todayOption) {
      todayOption = document.createElement("option");
      todayOption.value = "today";
      todayOption.textContent = "Hoy";
      periodSelect.prepend(todayOption);
    }
    periodSelect.value = "today";
  } else if (todayOption) {
    todayOption.remove();
    periodSelect.value = periodRange;
  } else {
    periodSelect.value = periodRange;
  }
  const metricSelect = document.getElementById("metric-filter");
  if (metricSelect.value !== metric) metricSelect.value = metric;
  const deviceSelect = document.getElementById("device-filter");
  if (deviceSelect && deviceSelect.value !== state.settings.sbDevice) deviceSelect.value = state.settings.sbDevice;
}

function renderIdentity() {
  document.getElementById("system-name").textContent = state.settings.name || "Módulo de prueba";
  const area = fmt(state.settings.area, state.settings.area >= 10 ? 1 : 2);
  const site = state.settings.site || "Sin ubicación";
  document.getElementById("site-line").textContent = `${site} · ${area} m²`;
}

function renderKpis(latest, viewed) {
  const set = (id, text) => { document.getElementById(id).textContent = text; };
  document.getElementById("latest-when").textContent = latest ? formatLatest(latest.t) : "sin muestras";
  const operation = panelOperatingState(latest);
  const operationEl = document.getElementById("operation-state");
  operationEl.className = `operation-state ${operation.key}`;
  operationEl.textContent = operation.label;
  operationEl.title = operation.detail;
  if (!latest) {
    ["kpi-v", "kpi-i", "kpi-irr", "kpi-t"].forEach((id) => set(id, "—"));
    ["spark-v", "spark-i", "spark-irr", "spark-t"].forEach((id) => {
      document.getElementById(id).innerHTML = "";
    });
    return;
  }
  set("kpi-v", fmt(latest.v, 2));
  set("kpi-i", fmt(latest.i, 2));
  set("kpi-irr", latest.irr == null ? "—" : fmt(latest.irr, 0));
  set("kpi-t", latest.tp == null ? "—" : fmt(latest.tp, 1));
  const sampled = stride(viewed, 48);
  renderSpark("spark-v", sampled.map((r) => r.v), "#8eadd4");
  renderSpark("spark-i", sampled.map((r) => r.i), "#3dceb0");
  renderSpark("spark-irr", sampled.map((r) => r.irr), "#f5c518");
  renderSpark("spark-t", sampled.map((r) => r.tp), "#e07a62");
}

function renderEnergyCard(latest, viewed) {
  const energy = formatEnergy(energyWh(viewed));
  document.getElementById("kpi-e").textContent = energy.value;
  document.getElementById("unit-e").textContent = energy.unit;
  const current = latest ? formatPower(powerOf(latest)) : null;
  document.getElementById("now-power").textContent = current ? `${current.value} ${current.unit.toLowerCase()}` : "—";
  if (!viewed.length) {
    document.getElementById("sum-peak").textContent = "—";
  } else {
    const peak = formatPower(Math.max(...viewed.map(powerOf)));
    document.getElementById("sum-peak").textContent = `${peak.value} ${peak.unit.toLowerCase()}`;
  }
  document.getElementById("energy-sub").textContent = span === "day"
    ? "Energía estimada de hoy"
    : "Energía estimada del periodo";
  renderEnergyBars(viewed);
}

// Reparte la energía de cada tramo entre lecturas según la hora (o día) de su punto medio
function energyBuckets(readings, keyOf) {
  const map = new Map();
  for (let k = 1; k < readings.length; k += 1) {
    const a = readings[k - 1];
    const b = readings[k];
    const dt = (b.t - a.t) / 3600000;
    if (dt <= 0 || dt > MAX_GAP_H) continue;
    const key = keyOf((a.t + b.t) / 2);
    map.set(key, (map.get(key) || 0) + ((powerOf(a) + powerOf(b)) / 2) * dt);
  }
  return map;
}

function renderEnergyBars(viewed) {
  const box = document.getElementById("energy-bars");
  const caption = document.getElementById("energy-bars-caption");
  const days = new Set(viewed.map((r) => dayKey(r.t)));
  const bars = [];
  const hh = (n) => String(n).padStart(2, "0");
  if (span === "day" || days.size < 2) {
    const ref = viewed.length ? viewed[viewed.length - 1].t : clockNow();
    const start = startOfDay(ref);
    const sameDay = viewed.filter((r) => r.t >= start && r.t < start + 86400000);
    const byHour = energyBuckets(sameDay, (t) => new Date(t).getHours());
    const nowHour = new Date(ref).getHours();
    for (let hour = 6; hour <= 19; hour += 1) {
      bars.push({
        wh: byHour.get(hour) || 0,
        label: hour % 3 === 0 ? hh(hour) : "",
        title: `${hh(hour)}:00 a ${hh(hour + 1)}:00`,
        now: hour === nowHour,
      });
    }
    caption.textContent = "Energía por hora";
  } else {
    const byDay = energyBuckets(viewed, dayKey);
    const letters = ["D", "L", "M", "X", "J", "V", "S"];
    const last = new Date(startOfDay(viewed[viewed.length - 1].t));
    const count = periodRange === "48h" ? 3 : 7;
    for (let k = count - 1; k >= 0; k -= 1) {
      const d = new Date(last);
      d.setDate(last.getDate() - k);
      bars.push({ wh: byDay.get(dayKey(d.getTime())) || 0, label: letters[d.getDay()], title: fmtDay.format(d), now: k === 0 });
    }
    caption.textContent = "Energía por día";
  }
  const max = Math.max(...bars.map((b) => b.wh), 0.0001);
  box.replaceChildren(...bars.map((b) => {
    const el = document.createElement("div");
    el.className = b.now ? "ebar now" : "ebar";
    const energy = formatEnergy(b.wh);
    el.title = `${b.title}: ${energy.value} ${energy.unit}`;
    const bar = document.createElement("i");
    bar.style.setProperty("--h", `${(b.wh / max) * 100}%`);
    const label = document.createElement("span");
    label.textContent = b.label;
    el.append(bar, label);
    return el;
  }));
}

function renderVitals(latest, all) {
  const area = state.settings.area;
  const eff = latest ? efficiencyOf(latest, area) : null;
  const perArea = latest ? powerOf(latest) / area : null;
  const dT = latest && latest.tp != null && latest.ta != null ? latest.tp - latest.ta : null;
  const ref = latest ? latest.t : clockNow();
  const start = startOfDay(ref);
  const today = all.filter((r) => r.t >= start && r.t <= ref);
  let irrWh = 0;
  let hasIrr = false;
  for (let k = 1; k < today.length; k += 1) {
    const a = today[k - 1];
    const b = today[k];
    const dt = (b.t - a.t) / 3600000;
    if (a.irr == null || b.irr == null || dt <= 0 || dt > MAX_GAP_H) continue;
    irrWh += ((a.irr + b.irr) / 2) * dt;
    hasIrr = true;
  }
  const items = [
    ["Eficiencia", eff == null ? "—" : `${fmt(eff, 1)} %`,
      eff == null ? "Se calcula con más de 50 W/m² de luz" : "De la luz que llega, cuánta sale como electricidad"],
    ["Potencia por m²", perArea == null ? "—" : `${fmt(perArea, perArea >= 100 ? 0 : 1)} W/m²`,
      `Sobre ${fmt(area, 2)} m² de panel`],
    ["Panel contra aire", dT == null ? "—" : `${dT >= 0 ? "+" : "−"}${fmt(Math.abs(dT), 1)} °C`,
      dT != null && dT > 30 ? "Muy caliente: el voltaje cae" : "Cuánto se calienta sobre el ambiente"],
    ["Horas de sol pico", hasIrr ? `${fmt(irrWh / 1000, 1)} h` : "—",
      "Hoy, contadas como horas a 1000 W/m²"],
  ];
  document.getElementById("vitals").replaceChildren(...items.map(([label, value, note]) => {
    const el = document.createElement("div");
    el.className = "vital";
    const a = document.createElement("span");
    a.textContent = label;
    const b = document.createElement("strong");
    b.textContent = value;
    const c = document.createElement("small");
    c.textContent = note;
    el.append(a, b, c);
    return el;
  }));
}

function renderInsights(all, viewed) {
  const list = document.getElementById("insights");
  list.replaceChildren();
  buildInsights(all, viewed).forEach((note) => {
    const item = document.createElement("li");
    item.textContent = note;
    list.appendChild(item);
  });
}

function renderCharts(viewed) {
  const range = viewRange();
  const sampled = stride(viewed, 700);
  const titles = {
    power: "Una curva llena de energía",
    voltage: "Tensión de salida",
    current: "Corriente de salida",
    radiation: "Irradiancia sobre el panel",
    temperature: "Temperatura del panel",
    humidity: "Humedad ambiente",
  };
  const series = buildMetricSeries(metric, sampled);
  document.getElementById("chart-title").textContent = titles[metric] || titles.power;
  charts.main.setConfig({
    series,
    xFormat: (x) => axisTime(x, range),
    timeRange: range,
    tooltipTitle: (point) => formatWhen(point.x),
  });
  renderLegend("legend-main", series, true);
}

function renderAnalytics(viewed) {
  const validRows = viewed.filter((reading) => reading.valid !== false);
  const analyzed = analysisScope === "daylight"
    ? validRows.filter((reading) => reading.irr != null && reading.irr >= PANEL_MIN_LIGHT_WM2)
    : validRows;
  const powerValues = analyzed.map((reading) => Math.max(0, powerOf(reading))).filter(Number.isFinite);
  const powerStats = describe(powerValues);
  const relationshipRows = analyzed.filter((reading) => reading.irr != null && reading.irr >= PANEL_MIN_LIGHT_WM2);
  const relationship = linearRelationship(relationshipRows);
  const coverage = viewed.length ? (analyzed.length / viewed.length) * 100 : 0;

  document.getElementById("stat-n").textContent = analyzed.length.toLocaleString("es-MX");
  document.getElementById("stat-coverage").textContent = analysisScope === "daylight"
    ? `${fmt(coverage, 1)} % del periodo con luz suficiente`
    : `${fmt(coverage, 1)} % de registros válidos`;
  document.getElementById("stat-mean-power").textContent = powerStats ? `${fmt(powerStats.mean, 3)} W` : "—";
  document.getElementById("stat-p95-power").textContent = powerStats ? `${fmt(powerStats.p95, 3)} W` : "—";
  document.getElementById("stat-correlation").textContent = relationship.r == null ? "—" : fmt(relationship.r, 3);
  document.getElementById("stat-correlation-label").textContent = relationship.r == null
    ? "coeficiente de Pearson"
    : `${correlationLabel(relationship.r)} · Pearson r`;

  renderScatterAnalysis(relationship);
  renderPowerHistogram(powerValues);
  renderAnomalyBreakdown(analyzed);
  renderDescriptiveStatistics(analyzed);
}

function renderScatterAnalysis(relationship) {
  const sampled = stride(relationship.pairs, 850);
  const series = [{
    name: "Observaciones",
    color: "#f2bb4b",
    type: "scatter",
    axis: "left",
    zero: true,
    unit: "W",
    digits: 3,
    data: sampled,
  }];
  if (relationship.slope != null && relationship.intercept != null && relationship.pairs.length) {
    const xMin = Math.min(...relationship.pairs.map((point) => point.x));
    const xMax = Math.max(...relationship.pairs.map((point) => point.x));
    series.push({
      name: "Regresión lineal",
      color: "#7dd3b0",
      type: "line",
      axis: "left",
      zero: true,
      unit: "W",
      digits: 3,
      data: [
        { x: xMin, y: Math.max(0, relationship.intercept + relationship.slope * xMin) },
        { x: xMax, y: Math.max(0, relationship.intercept + relationship.slope * xMax) },
      ],
    });
  }
  charts.scatter.setConfig({
    series,
    xFormat: (value) => fmt(value, 0),
    tooltipTitle: (point) => `${fmt(point.x, 0)} W/m²`,
  });
  document.getElementById("scatter-note").textContent = relationship.pairs.length
    ? `${relationship.pairs.length.toLocaleString("es-MX")} pares válidos; se muestran hasta 850 para mantener la gráfica legible.`
    : "No hay pares válidos de irradiancia y potencia en este periodo.";
  document.getElementById("regression-equation").textContent = relationship.slope == null
    ? "Sin ajuste"
    : `P = ${fmt(relationship.slope, 4)}·G ${relationship.intercept >= 0 ? "+" : "−"} ${fmt(Math.abs(relationship.intercept), 3)}`;
}

function renderPowerHistogram(values) {
  if (!values.length) {
    charts.histogram.setConfig({ series: [], kind: "bar", labels: [] });
    return;
  }
  const binCount = 12;
  const max = Math.max(...values);
  const width = max > 0 ? max / binCount : 1 / binCount;
  const bins = Array(binCount).fill(0);
  values.forEach((value) => {
    const index = Math.min(binCount - 1, Math.floor(value / width));
    bins[index] += 1;
  });
  const labels = bins.map((_, index) => fmt(index * width, max >= 10 ? 1 : 2));
  charts.histogram.setConfig({
    kind: "bar",
    labels,
    series: [{
      name: "Frecuencia",
      color: "#7aa7d9",
      type: "bar",
      axis: "left",
      zero: true,
      unit: "registros",
      digits: 0,
      data: bins.map((count, index) => ({ x: index, y: count })),
    }],
    tooltipTitle: (point) => `${labels[point.x]}–${fmt((point.x + 1) * width, max >= 10 ? 1 : 2)} W`,
  });
}

function renderAnomalyBreakdown(rows) {
  const host = document.getElementById("anomaly-breakdown");
  const counts = new Map();
  rows.forEach((reading) => {
    const label = conditionLabel(reading.anomaly);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = Math.max(1, rows.length);
  const top = entries.slice(0, 6);
  const remainder = entries.slice(6).reduce((sum, entry) => sum + entry[1], 0);
  if (remainder) top.push(["Otras condiciones", remainder]);
  host.replaceChildren(...top.map(([label, count], index) => {
    const row = document.createElement("div");
    row.className = "anomaly-row";
    const head = document.createElement("div");
    const name = document.createElement("span");
    const value = document.createElement("strong");
    name.textContent = label;
    value.textContent = `${fmt((count / total) * 100, 1)} %`;
    head.append(name, value);
    const track = document.createElement("i");
    const fill = document.createElement("b");
    fill.style.setProperty("--share", `${(count / total) * 100}%`);
    fill.style.setProperty("--bar-index", String(index));
    track.appendChild(fill);
    row.append(head, track);
    return row;
  }));
  const abnormal = rows.filter((reading) => reading.anomaly && reading.anomaly !== "normal").length;
  document.getElementById("anomaly-summary").textContent = rows.length
    ? `${abnormal.toLocaleString("es-MX")} lecturas (${fmt((abnormal / rows.length) * 100, 1)} %) tienen una condición registrada.`
    : "No hay lecturas en la población seleccionada.";
}

function renderDescriptiveStatistics(rows) {
  const specs = [
    ["Voltaje", "V", 3, (reading) => reading.v],
    ["Corriente", "A", 4, (reading) => reading.i],
    ["Potencia", "W", 4, (reading) => Math.max(0, powerOf(reading))],
    ["Irradiancia", "W/m²", 1, (reading) => reading.irr],
    ["Temperatura del panel", "°C", 2, (reading) => reading.tp],
  ];
  const body = document.getElementById("stats-tbody");
  body.replaceChildren(...specs.map(([label, unit, digits, valueOf]) => {
    const stats = describe(rows.map(valueOf));
    const tr = document.createElement("tr");
    const values = stats
      ? [label, stats.n.toLocaleString("es-MX"), stats.min, stats.mean, stats.median, stats.p95, stats.max, stats.sd]
      : [label, "0", null, null, null, null, null, null];
    values.forEach((value, index) => {
      const td = document.createElement("td");
      if (index === 0) {
        td.innerHTML = `<strong>${label}</strong><small>${unit}</small>`;
      } else if (index === 1) {
        td.textContent = value;
      } else {
        td.textContent = value == null ? "—" : fmt(value, digits);
      }
      tr.appendChild(td);
    });
    return tr;
  }));
}

function buildMetricSeries(key, sampled) {
  const power = {
    name: "Potencia",
    color: "#f5c518",
    type: "area",
    axis: "left",
    zero: true,
    unit: "W",
    digits: 0,
    data: sampled.map((r) => ({ x: r.t, y: powerOf(r) })),
  };
  const irradiance = {
    name: "Irradiancia",
    color: "#d7e2f0",
    type: "line",
    dash: [5, 4],
    axis: "right",
    zero: true,
    unit: "W/m²",
    digits: 0,
    data: sampled.map((r) => ({ x: r.t, y: r.irr })),
  };
  if (key === "voltage") {
    return [{
      name: "Voltaje",
      color: "#8eadd4",
      type: "line",
      axis: "left",
      zero: false,
      unit: "V",
      digits: 2,
      data: sampled.map((r) => ({ x: r.t, y: r.v >= 1 ? r.v : null })),
    }];
  }
  if (key === "current") {
    return [{
      name: "Corriente",
      color: "#3dceb0",
      type: "area",
      axis: "left",
      zero: true,
      unit: "A",
      digits: 2,
      data: sampled.map((r) => ({ x: r.t, y: r.i })),
    }, { ...irradiance }];
  }
  if (key === "radiation") {
    return [{
      name: "Radiación",
      color: "#f5c518",
      type: "area",
      axis: "left",
      zero: true,
      unit: "W/m²",
      digits: 0,
      data: sampled.map((r) => ({ x: r.t, y: r.irr })),
    }];
  }
  if (key === "temperature") {
    return [{
      name: "Panel",
      color: "#e07a62",
      type: "area",
      axis: "left",
      zero: false,
      unit: "°C",
      digits: 1,
      data: sampled.map((r) => ({ x: r.t, y: r.tp })),
    }, {
      name: "Ambiente",
      color: "#c5d0e0",
      type: "line",
      dash: [5, 4],
      axis: "left",
      zero: false,
      unit: "°C",
      digits: 1,
      data: sampled.map((r) => ({ x: r.t, y: r.ta })),
    }];
  }
  if (key === "humidity") {
    return [{
      name: "Humedad",
      color: "#7eb6ff",
      type: "line",
      axis: "left",
      zero: false,
      unit: "%",
      digits: 0,
      data: sampled.map((r) => ({ x: r.t, y: r.h })),
    }];
  }
  return [power, irradiance];
}

function timeTicks(xMin, xMax) {
  const span = xMax - xMin;
  const ticks = [];
  if (span <= 36 * 3600000) {
    const stepH = span <= 8 * 3600000 ? 1 : span <= 18 * 3600000 ? 2 : 6;
    const cursor = new Date(xMin);
    cursor.setMinutes(0, 0, 0);
    cursor.setHours(cursor.getHours() + 1);
    while (cursor.getTime() < xMax && ticks.length < 8) {
      if (cursor.getHours() % stepH === 0) ticks.push(cursor.getTime());
      cursor.setHours(cursor.getHours() + 1);
    }
    return ticks;
  }
  const cursor = new Date(xMin);
  cursor.setHours(12, 0, 0, 0);
  if (cursor.getTime() < xMin) cursor.setDate(cursor.getDate() + 1);
  const stepDays = span > 16 * 86400000 ? 2 : 1;
  while (cursor.getTime() <= xMax && ticks.length < 8) {
    ticks.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + stepDays);
  }
  return ticks;
}

function axisTime(ts, key) {
  const date = new Date(ts);
  if (key === "today" || key === "48h") return fmtTime.format(date);
  return fmtDay.format(date);
}

function hourlyProfiles(readings) {
  const byDay = new Map();
  readings.forEach((reading) => {
    const date = new Date(reading.t);
    const hour = date.getHours() + date.getMinutes() / 60;
    if (hour < 6 || hour > 19) return;
    const key = dayKey(reading.t);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(reading);
  });
  const series = [];
  let colorIndex = 0;
  byDay.forEach((rows) => {
    const data = [];
    for (let hour = 6; hour < 19; hour += 0.5) {
      const slice = rows.filter((reading) => {
        const date = new Date(reading.t);
        const value = date.getHours() + date.getMinutes() / 60;
        return value >= hour && value < hour + 0.5;
      });
      if (!slice.length) continue;
      data.push({ x: hour + 0.25, y: average(slice.map(powerOf)) });
    }
    if (data.length < 2) return;
    series.push({
      name: fmtDay.format(new Date(rows[0].t)),
      color: DAY_COLORS[colorIndex % DAY_COLORS.length],
      type: "line",
      axis: "left",
      zero: true,
      unit: "W",
      digits: 0,
      data,
    });
    colorIndex += 1;
  });
  return series;
}

function renderTable(viewed) {
  const body = document.getElementById("tbody");
  const rows = [...viewed].reverse();
  const visible = rows.slice(0, tableExpanded ? tableVisibleCount : 14);
  const more = document.getElementById("btn-more");
  more.hidden = rows.length <= 14;
  more.textContent = !tableExpanded
    ? `Ver más de ${rows.length.toLocaleString("es-MX")}`
    : tableVisibleCount < rows.length
      ? `Cargar ${Math.min(100, rows.length - tableVisibleCount).toLocaleString("es-MX")} más`
      : "Ver menos";
  document.getElementById("table-meta").textContent = rows.length
    ? `${rows.length.toLocaleString("es-MX")} en este periodo, de la más reciente a la más antigua`
    : "Nada en este periodo";
  const hasWind = readingsSource().some((r) => r.wind != null);
  document.querySelectorAll(".wind-col").forEach((cell) => {
    cell.hidden = !hasWind;
  });
  body.replaceChildren();
  if (!visible.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 12;
    td.textContent = "Registra una medición o importa un CSV para ver la tabla.";
    td.style.fontFamily = "IBM Plex Sans, sans-serif";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  visible.forEach((reading) => {
    const tr = document.createElement("tr");
    const operation = panelOperatingState(reading);
    const thermal = cloudActive() && !sim.active ? nearestThermalFor(reading.t) : null;
    if (thermal) {
      tr.className = `has-thermal${cloud.selectedReadingAt === reading.t ? " thermal-selected" : ""}`;
      tr.tabIndex = 0;
      tr.setAttribute("aria-label", `Abrir captura térmica asociada a ${formatWhen(reading.t)}`);
    }
    const cells = [
      formatWhen(reading.t),
      operation.label,
      conditionLabel(reading.anomaly),
      `${fmt(reading.v, 2)} V`,
      `${fmt(reading.i, 2)} A`,
      `${formatPower(powerOf(reading)).value} ${formatPower(powerOf(reading)).unit}`,
      reading.irr == null ? "—" : `${fmt(reading.irr, 0)}`,
      reading.tp == null ? "—" : `${fmt(reading.tp, 1)} °C`,
      reading.ta == null ? "—" : `${fmt(reading.ta, 1)} °C`,
      reading.h == null ? "—" : `${fmt(reading.h, 0)} %`,
      reading.wind == null ? "—" : `${fmt(reading.wind, 1)}`,
    ];
    cells.forEach((text, index) => {
      const td = document.createElement("td");
      if (index === 0) td.className = "when";
      if (index === 1) td.className = `panel-state ${operation.key}`;
      if (index === 2) td.className = "condition";
      if (index === 10) {
        td.className = "wind-col";
        td.hidden = !hasWind;
      }
      td.textContent = text;
      tr.appendChild(td);
    });
    const thermalCell = document.createElement("td");
    const thermalButton = document.createElement("button");
    thermalButton.type = "button";
    thermalButton.className = "thermal-link";
    thermalButton.textContent = thermal ? "Ver imagen" : "Sin captura";
    thermalButton.disabled = !thermal;
    if (thermal) {
      const open = () => openThermalForReading(reading, thermal);
      thermalButton.addEventListener("click", (event) => { event.stopPropagation(); open(); });
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      });
    }
    thermalCell.appendChild(thermalButton);
    tr.appendChild(thermalCell);
    body.appendChild(tr);
  });
}

function renderBanner() {
  const banner = document.getElementById("banner");
  if (sim.active) {
    banner.hidden = true;
    return;
  }
  if (cloudActive()) {
    if (cloud.error) {
      banner.hidden = false;
      banner.textContent = `No pude leer el historial de Supabase: ${cloud.error}. Revisa la URL, la clave pública y el dispositivo en ajustes.`;
    } else if (cloud.range && !cloud.readings.length) {
      banner.hidden = false;
      banner.textContent = `Supabase está conectado, pero todavía no hay lecturas de «${state.settings.sbDevice}» en este periodo.`;
    } else {
      banner.hidden = true;
    }
    return;
  }
  if (state.mode === "demo") {
    banner.hidden = false;
    banner.textContent = `Estás viendo una simulación de cinco días para un módulo de ${fmt(state.settings.area, 2)} m². Sirve para recorrer el tablero. Al registrar una medición, importar un CSV o recibir datos del sensor, la simulación se reemplaza.`;
    return;
  }
  if (!state.readings.length) {
    banner.hidden = false;
    banner.textContent = "Aún no hay mediciones. Registra la primera, suelta un CSV sobre la página o conecta la dirección del sensor en ajustes.";
    return;
  }
  banner.hidden = true;
}

function renderStatus() {
  const status = document.getElementById("status");
  const text = document.getElementById("status-text");
  status.classList.remove("ok", "warn", "idle", "sim");
  if (sim.active) {
    status.classList.add("sim");
    text.textContent = sim.playing ? "Simulación en vivo" : "Simulación en pausa";
    return;
  }
  if (mqttState !== "off") {
    const operation = panelOperatingState(readingsSource().at(-1));
    const labels = {
      connecting: ["warn", "Conectando al broker"],
      waiting: ["", "Broker conectado, esperando al ESP32"],
      ok: ["ok", "ESP32 en línea (MQTT)"],
      stale: operation.key === "rest" ? ["idle", "Panel inactivo · sin datos recientes"] : ["warn", "ESP32 sin datos recientes"],
      offline: operation.key === "rest" ? ["idle", "Panel inactivo · sin telemetría"] : ["warn", "ESP32 desconectado"],
      error: ["warn", "No pude conectar al broker"],
    };
    const [cls, label] = labels[mqttState] || ["", "MQTT"];
    if (cls) status.classList.add(cls);
    text.textContent = label;
    return;
  }
  if (sensorState === "ok") {
    status.classList.add("ok");
    text.textContent = "Sensor en línea";
    return;
  }
  if (sensorState === "warn") {
    status.classList.add("warn");
    text.textContent = "Sensor sin respuesta";
    return;
  }
  text.textContent = state.mode === "demo" ? "Demostración" : "Registro real";
}

function renderChrome() {}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
}

function beginRealLog() {
  if (state.mode !== "demo") return false;
  state.readings = [];
  state.mode = "real";
  return true;
}

function upsertReading(reading) {
  const clean = coerceReading(reading);
  if (!clean) return false;
  const index = state.readings.findIndex((item) => Math.abs(item.t - clean.t) < 1000);
  if (index >= 0) state.readings[index] = clean;
  else state.readings.push(clean);
  state.readings.sort((a, b) => a.t - b.t);
  if (state.readings.length > 20000) {
    state.readings.splice(0, state.readings.length - 20000);
  }
  return true;
}

function numFrom(source) {
  if (source == null) return null;
  let text = String(source).trim().replace(/\s/g, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) text = text.replace(/\./g, "").replace(",", ".");
    else text = text.replace(/,/g, "");
  } else if (text.includes(",")) text = text.replace(",", ".");
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") {
      const n = numFrom(obj[key]);
      if (n != null) return n;
    }
  }
  return null;
}

function readingFromPayload(payload, fallbackTime) {
  const source = payload || {};
  const t = parseTime(source.t ?? source.time ?? source.timestamp ?? source.fecha ?? source.fechahora) || fallbackTime || Date.now();
  let v = pickNumber(source, ["v", "voltage", "voltaje", "volts"]);
  let i = pickNumber(source, ["i", "current", "corriente", "amps"]);
  const p = pickNumber(source, ["p", "power", "potencia", "watts"]);
  if (i == null && p != null && v) i = p / v;
  if (v == null && p != null && i) v = p / i;
  return coerceReading({
    t, v, i,
    irr: pickNumber(source, ["irr", "irradiance", "irradiancia", "radiacion", "radiation", "ghi"]),
    tp: pickNumber(source, ["tp", "temp_panel", "temppanel", "tpanel", "temperatura", "tempPanel"]),
    ta: pickNumber(source, ["ta", "temp_ambient", "tempambient", "tamb", "ambiente", "tempAmbient"]),
    h: pickNumber(source, ["h", "humidity", "humedad", "rh"]),
    wind: pickNumber(source, ["wind", "viento", "windspeed"]),
  });
}

function parseTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const text = String(value).trim();
  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text);
    return text.length <= 10 ? n * 1000 : n;
  }
  const local = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (local) {
    const date = new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1]), Number(local[4] || 0), Number(local[5] || 0), Number(local[6] || 0));
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  const normalized = /^\d{4}-\d{2}-\d{2} /.test(text) ? text.replace(" ", "T") : text;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function normKey(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitCsvLine(line, delimiter) {
  const out = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      out.push(current.trim());
      current = "";
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("El archivo no trae filas de datos.");
  const delimiter = lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";
  const headers = splitCsvLine(lines[0], delimiter).map(normKey);
  const alias = {
    t: ["t", "time", "timestamp", "fecha", "fechahora", "datetime", "date", "hora"],
    v: ["v", "voltaje", "voltage", "volts", "voltajev"],
    i: ["i", "corriente", "current", "amps", "corrientea"],
    p: ["p", "potencia", "power", "watts", "potenciaw"],
    irr: ["irr", "irradiancia", "irradiance", "radiacion", "radiation", "ghi", "irradianciawm2"],
    tp: ["tp", "temppanel", "temppanel", "tpanel", "paneltemp", "temperatura", "temppanelc"],
    ta: ["ta", "tempambiente", "tamb", "ambiente", "temperaturaambiente", "tempambientec"],
    h: ["h", "humedad", "humidity", "rh", "humedadpct"],
    wind: ["wind", "viento", "windspeed", "vientoms"],
  };
  const indexOf = (name) => headers.findIndex((header) => alias[name].includes(header));
  const col = {
    t: indexOf("t"),
    v: indexOf("v"),
    i: indexOf("i"),
    p: indexOf("p"),
    irr: indexOf("irr"),
    tp: indexOf("tp"),
    ta: indexOf("ta"),
    h: indexOf("h"),
    wind: indexOf("wind"),
  };
  if (col.t < 0) throw new Error("Falta la columna de fecha.");
  const readings = [];
  lines.slice(1).forEach((line) => {
    const cells = splitCsvLine(line, delimiter);
    const grab = (index) => (index >= 0 ? cells[index] : null);
    const reading = readingFromPayload({
      t: grab(col.t),
      v: grab(col.v),
      i: grab(col.i),
      p: grab(col.p),
      irr: grab(col.irr),
      tp: grab(col.tp),
      ta: grab(col.ta),
      h: grab(col.h),
      wind: grab(col.wind),
    });
    if (reading) readings.push(reading);
  });
  if (!readings.length) throw new Error("No encontré filas con voltaje y corriente.");
  return readings;
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCSV() {
  if (cloudActive() && !sim.active) {
    exportCloudCSV().catch((error) => toast(error.message || "No pude descargar el registro."));
    return;
  }
  if (!state.readings.length) {
    toast("No hay lecturas para exportar.");
    return;
  }
  const header = "fecha,voltaje_V,corriente_A,irradiancia_Wm2,temp_panel_C,temp_ambiente_C,humedad_pct,viento_ms";
  const lines = state.readings.map((r) => [
    new Date(r.t).toISOString(),
    r.v,
    r.i,
    r.irr ?? "",
    r.tp ?? "",
    r.ta ?? "",
    r.h ?? "",
    r.wind ?? "",
  ].join(","));
  const stamp = new Date().toISOString().slice(0, 10);
  download(`mediciones-solares-${stamp}.csv`, `\uFEFF${header}\n${lines.join("\n")}\n`);
}

function templateCSV() {
  download("plantilla-mediciones-solares.csv", "\uFEFFfecha,voltaje_V,corriente_A,irradiancia_Wm2,temp_panel_C,temp_ambiente_C,humedad_pct,viento_ms\n2026-10-07T11:40,34.2,6.1,850,46.2,27.1,44,1.2\n");
}

function importReadings(readings) {
  const replaced = beginRealLog();
  readings.forEach((reading) => upsertReading(reading));
  state.mode = "real";
  saveState();
  render();
  toast(replaced
    ? `Simulación reemplazada. Entraron ${readings.length.toLocaleString("es-MX")} lecturas.`
    : `Se agregaron ${readings.length.toLocaleString("es-MX")} lecturas.`);
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importReadings(parseCSV(String(reader.result)));
    } catch (error) {
      toast(error.message || "No pude leer ese CSV.");
    }
  };
  reader.readAsText(file);
}

function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updatePreview() {
  const form = document.getElementById("form-reading");
  const v = numFrom(form.v.value);
  const i = numFrom(form.i.value);
  const irr = numFrom(form.irr.value);
  const preview = document.getElementById("reading-preview");
  if (v == null || i == null) {
    preview.textContent = "Potencia instantánea —";
    return;
  }
  const p = formatPower(v * i);
  let extra = "";
  if (irr != null && irr > 20 && state.settings.area > 0) {
    extra = ` · eficiencia ${fmt((v * i) / (irr * state.settings.area) * 100, 1)} %`;
  }
  preview.textContent = `Potencia instantánea ${p.value} ${p.unit}${extra}`;
}

function openReading() {
  const form = document.getElementById("form-reading");
  form.reset();
  form.t.value = localInputValue(new Date());
  document.getElementById("reading-hint").textContent = state.mode === "demo"
    ? "Al guardar esta lectura se quita la simulación y empieza tu registro real."
    : "Anota lo que marcan los instrumentos. La potencia se calcula sola.";
  updatePreview();
  document.getElementById("dlg-reading").showModal();
}

function openSettings() {
  document.getElementById("set-name").value = state.settings.name;
  document.getElementById("set-site").value = state.settings.site;
  document.getElementById("set-area").value = state.settings.area;
  document.getElementById("set-endpoint").value = state.settings.endpoint;
  document.getElementById("set-interval").value = state.settings.interval;
  document.getElementById("set-mqtt-url").value = state.settings.mqttUrl;
  document.getElementById("set-mqtt-topic").value = state.settings.mqttTopic;
  document.getElementById("set-mqtt-user").value = state.settings.mqttUser;
  document.getElementById("set-mqtt-pass").value = state.settings.mqttPass;
  document.getElementById("set-sb-url").value = state.settings.sbUrl;
  document.getElementById("set-sb-key").value = state.settings.sbKey;
  document.getElementById("set-sb-device").value = state.settings.sbDevice || defaultDevice(state.settings.mqttTopic);
  document.getElementById("dlg-settings").showModal();
}

async function fetchSensor(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`El sensor respondió ${response.status}`);
  const data = await response.json();
  const list = Array.isArray(data) ? data : [data];
  const readings = list.map((item, index) => readingFromPayload(item, Date.now() + index)).filter(Boolean);
  if (!readings.length) throw new Error("El JSON no trae voltaje y corriente.");
  return readings;
}

async function pollSensor() {
  const url = state.settings.endpoint;
  if (!url) return;
  try {
    const readings = await fetchSensor(url);
    const replaced = beginRealLog();
    readings.forEach((reading) => upsertReading(reading));
    state.mode = "real";
    sensorState = "ok";
    saveState();
    render();
    if (replaced) toast("Llegó el sensor. Quité la simulación y seguí con datos reales.");
  } catch {
    sensorState = "warn";
    renderStatus();
  }
}

function applyPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!state.settings.endpoint) {
    if (sensorState !== "idle") {
      sensorState = "idle";
      renderStatus();
    }
    return;
  }
  pollSensor();
  pollTimer = setInterval(pollSensor, state.settings.interval * 1000);
}

// ---------- Simulador en vivo ----------
// Genera lecturas y cuadros térmicos con un modelo físico sencillo. Vive solo en memoria:
// nunca toca state.readings, así el historial real queda intacto.
const SIM_FIRST_MIN = 5 * 60 + 30;
const SIM_LAST_MIN = 20 * 60 + 30;
const SIM_PRESETS = {
  clear: { cloud: 5, ta: 30, dirt: 0, wind: 1.5, shade: false, hotspot: false },
  cloudy: { cloud: 78, ta: 23, dirt: 0, wind: 3.5, shade: false, hotspot: false },
  heat: { cloud: 0, ta: 42, dirt: 0, wind: 0.5, shade: false, hotspot: false },
  dirty: { cloud: 10, ta: 31, dirt: 28, wind: 1, shade: true, hotspot: true },
};
const sim = {
  active: false,
  playing: true,
  speed: 60,
  t: 0,
  readings: [],
  frame: null,
  timer: null,
  dragging: false,
  prevSpan: "period",
  params: { ...SIM_PRESETS.clear },
};

function clockNow() {
  return sim.active ? sim.t : Date.now();
}

function readingsSource() {
  if (sim.active) return sim.readings;
  return cloudActive() ? cloud.readings : state.readings;
}

function simDayAt(minutes) {
  return startOfDay(Date.now()) + minutes * 60000;
}

function minutesOfDay(t) {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function simSun(t) {
  const x = (minutesOfDay(t) / 60 - SOLAR_RISE) / (SOLAR_SET - SOLAR_RISE);
  return x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x) ** 1.2;
}

// Nubes que pasan: ruido suave que depende del tiempo simulado
function simCloudTransmission(t, cloud) {
  if (cloud <= 0) return 1;
  const m = t / 60000;
  const n = 0.5 + 0.25 * Math.sin(m / 9) + 0.25 * Math.sin(m / 23 + 1.7) * Math.sin(m / 4.3 + 0.4);
  const c = cloud / 100;
  return clamp(1 - c * (0.2 + 0.7 * n) - c * c * 0.08, 0.05, 1);
}

// Irradiancia → temperatura de celda (modelo NOCT con viento) → punto de máxima potencia
function simModel(t) {
  const p = sim.params;
  const sun = simSun(t);
  const ghi = 1040 * sun * simCloudTransmission(t, p.cloud);
  const ta = p.ta - 7 * (1 - sun) - (p.cloud / 100) * 2;
  const geff = ghi * (1 - p.dirt / 100);
  const tc = ta + 0.03125 * ghi * (9.5 / (5.7 + 3.8 * p.wind));
  const area = state.settings.area;
  const cells = area < 0.3 ? 12 : 60;
  const vmpStc = cells * 0.55;
  const impStc = (area * 1000 * 0.2) / vmpStc;
  const kTemp = 1 - 0.0037 * (tc - 25);
  const kLow = geff > 2 ? clamp(1 + 0.045 * Math.log(geff / 1000), 0.5, 1.03) : 0;
  // Con sombra, el diodo de bypass saca de juego un tercio de las celdas
  const kShade = p.shade ? 2 / 3 : 1;
  const kCell = p.hotspot ? 0.94 : 1;
  return {
    sun, ghi, geff, ta, tc, kTemp, kLow, kShade, kCell,
    v: vmpStc * kTemp * kLow * kShade,
    i: impStc * (geff / 1000) * (1 + 0.0005 * (tc - 25)) * kCell,
    pIdeal: area * ghi * 0.2,
  };
}

function simSample(t) {
  const m = simModel(t);
  const p = sim.params;
  const jitter = (amount) => 1 + (Math.random() - 0.5) * amount;
  return {
    t,
    v: Math.max(0, m.v * jitter(0.006)),
    i: Math.max(0, m.i * jitter(0.01)),
    irr: Math.round(m.ghi * jitter(0.01)),
    tp: roundTo(m.tc + (Math.random() - 0.5) * 0.3, 1),
    ta: roundTo(m.ta + (Math.random() - 0.5) * 0.2, 1),
    h: Math.round(clamp(72 - 38 * m.sun + p.cloud * 0.22, 12, 98)),
    wind: roundTo(Math.max(0, p.wind * jitter(0.5)), 1),
  };
}

// Cuadro de 32×24 como el de la MLX90640: cielo arriba, suelo abajo y el panel en medio
function simFrame(t) {
  const m = simModel(t);
  const p = sim.params;
  const w = 32;
  const h = 24;
  const x0 = 1;
  const x1 = 30;
  const y0 = 3;
  const y1 = 21;
  const cellW = (x1 - x0 + 1) / 6;
  const cellH = (y1 - y0 + 1) / 4;
  const hotX = x0 + cellW * 1.5;
  const hotY = y0 + cellH * 1.5;
  const shadeFrom = x0 + (x1 - x0 + 1) * (2 / 3);
  const temps = new Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let k;
      if (y < y0) k = m.ta - 4 - 6 * (1 - p.cloud / 100) + y * 0.6;
      else if (y > y1) k = m.ta + 2 + 9 * m.sun;
      else if (x < x0 || x > x1) k = m.ta + 1 + 3 * m.sun;
      else {
        k = m.tc;
        const edge = x === x0 || x === x1 || y === y0 || y === y1;
        const gap = (x - x0) % cellW < 0.5 || (y - y0) % cellH < 0.5;
        if (edge) k = m.ta + (m.tc - m.ta) * 0.55;
        else if (gap) k -= 0.7;
        if (p.shade && x >= shadeFrom) k = m.ta + (k - m.ta) * 0.4;
        if (p.dirt) k += (p.dirt / 100) * 4 * (0.5 + 0.5 * Math.sin(x * 1.7 + y * 0.9) * Math.cos(y * 1.3 - x * 0.4));
        if (p.hotspot) {
          const d = Math.hypot(((x - hotX) / cellW) * 2, ((y - hotY) / cellH) * 2);
          if (d < 1.6) k += (5 + 17 * (m.geff / 1000)) * Math.exp(-d * d);
        }
      }
      temps[y * w + x] = k + (Math.random() - 0.5) * 0.4;
    }
  }
  return { w, h, temps, ...thermalStats(temps), at: t };
}

// Lleva el reloj simulado a `target`; rellena huecos cada 5 min para que la curva no se corte
function simAdvanceTo(target) {
  const list = sim.readings;
  while (list.length && list[list.length - 1].t >= target) list.pop();
  const step = 5 * 60000;
  let t = list.length ? list[list.length - 1].t : simDayAt(SIM_FIRST_MIN) - step;
  while (target - t > step) {
    t += step;
    list.push(simSample(t));
  }
  list.push(simSample(target));
  if (list.length > 20000) list.splice(0, list.length - 20000);
  sim.t = target;
  sim.frame = simFrame(target);
}

function simRefresh() {
  render();
  renderThermal();
  renderSim();
}

function simTick() {
  if (!sim.active || !sim.playing || sim.dragging) return;
  const end = simDayAt(SIM_LAST_MIN);
  const next = sim.t + sim.speed * 1000;
  if (next >= end) {
    simAdvanceTo(end);
    sim.playing = false;
    simRefresh();
    toast("Terminó el día simulado. Dale play para empezar otro.");
    return;
  }
  simAdvanceTo(next);
  simRefresh();
}

function startSim() {
  if (sim.active) return;
  sim.active = true;
  sim.playing = true;
  sim.readings = [];
  sim.prevSpan = span;
  span = "day";
  tableExpanded = false;
  simAdvanceTo(simDayAt(11 * 60));
  clearInterval(sim.timer);
  sim.timer = setInterval(simTick, 1000);
  document.body.classList.add("sim-on");
  document.getElementById("sim-panel").hidden = false;
  document.getElementById("btn-sim").setAttribute("aria-pressed", "true");
  syncSimControls();
  simRefresh();
  document.getElementById("sim-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function stopSim() {
  if (!sim.active) return;
  clearInterval(sim.timer);
  sim.timer = null;
  sim.active = false;
  sim.readings = [];
  sim.frame = null;
  span = sim.prevSpan;
  tableExpanded = false;
  document.body.classList.remove("sim-on");
  document.getElementById("sim-panel").hidden = true;
  document.getElementById("btn-sim").setAttribute("aria-pressed", "false");
  render();
  renderThermal();
  toast("Saliste del simulador. Volviste a tus datos reales.");
}

function setFill(input) {
  const pct = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty("--fill", `${pct}%`);
}

const SIM_SLIDERS = [
  ["cloud", (v) => `${fmt(v, 0)} %`],
  ["ta", (v) => `${fmt(v, 0)} °C`],
  ["dirt", (v) => `${fmt(v, 0)} %`],
  ["wind", (v) => `${fmt(v, 1)} m/s`],
];

function syncSimControls() {
  SIM_SLIDERS.forEach(([key, label]) => {
    const input = document.getElementById(`sim-${key}`);
    input.value = sim.params[key];
    document.getElementById(`out-${key}`).textContent = label(sim.params[key]);
    setFill(input);
  });
  document.getElementById("sim-shade").checked = sim.params.shade;
  document.getElementById("sim-hotspot").checked = sim.params.hotspot;
  document.querySelectorAll("[data-speed]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.speed) === sim.speed);
  });
}

function skyLabel(t) {
  if (simSun(t) <= 0) return "Noche";
  const trans = simCloudTransmission(t, sim.params.cloud);
  if (trans > 0.85) return "Despejado";
  if (trans > 0.6) return "Parcialmente nublado";
  if (trans > 0.35) return "Nublado";
  return "Muy nublado";
}

function renderSim() {
  if (!sim.active) return;
  const minutes = minutesOfDay(sim.t);
  document.getElementById("sim-time").textContent = fmtTime.format(sim.t);
  document.getElementById("sim-sky").textContent = skyLabel(sim.t);
  const hour = document.getElementById("sim-hour");
  if (!sim.dragging) hour.value = Math.round(minutes);

  const x = (minutes / 60 - SOLAR_RISE) / (SOLAR_SET - SOLAR_RISE);
  const progress = clamp(x, 0, 1);
  const angle = Math.PI * (1 - progress);
  const sunDot = document.getElementById("sim-sun");
  sunDot.setAttribute("cx", (66 + 58 * Math.cos(angle)).toFixed(1));
  sunDot.setAttribute("cy", (58 - 58 * Math.sin(angle)).toFixed(1));
  document.getElementById("sim-arc-done").style.strokeDashoffset = String(183 * (1 - progress));
  document.querySelector(".sun-arc").classList.toggle("night", x <= 0 || x >= 1);

  const play = document.getElementById("sim-play");
  play.classList.toggle("paused", !sim.playing);
  play.setAttribute("aria-label", sim.playing ? "Pausar" : "Reanudar");

  const m = simModel(sim.t);
  const p = sim.params;
  const power = formatPower(m.v * m.i);
  const ideal = formatPower(m.pIdeal);
  const parts = [
    ["calor", 1 - m.kTemp],
    ["poca luz", 1 - m.kLow],
    ["suciedad", p.dirt / 100],
    ["sombra", 1 - m.kShade],
    ["celda", 1 - m.kCell],
  ].filter(([, loss]) => loss > 0.005);
  const lossTotal = m.pIdeal > 0.5 ? 1 - (m.v * m.i) / m.pIdeal : null;
  const items = [
    ["Luz en las celdas", `${fmt(m.geff, 0)} W/m²`, p.dirt ? `${fmt(m.ghi, 0)} W/m² antes de la suciedad` : "Lo que atraviesa el vidrio"],
    ["Temperatura de celda", `${fmt(m.tc, 1)} °C`, `${fmt(m.tc - m.ta, 1)} °C sobre el aire`],
    ["Potencia", `${power.value} ${power.unit}`, m.pIdeal > 0.5 ? `de ${ideal.value} ${ideal.unit} posibles` : "Sin sol"],
    ["Pérdidas", lossTotal == null ? "—" : `${fmt(Math.max(0, lossTotal) * 100, 0)} %`,
      parts.length && lossTotal != null ? parts.map(([name, loss]) => `${name} ${fmt(loss * 100, 0)} %`).join(" · ") : "Nada que perder"],
  ];
  document.getElementById("sim-readout").replaceChildren(...items.map(([label, value, note], index) => {
    const el = document.createElement("div");
    const a = document.createElement("span");
    a.textContent = label;
    const b = document.createElement("strong");
    b.textContent = value;
    if (index === 3 && lossTotal != null && lossTotal > 0.25) b.className = "loss";
    const c = document.createElement("small");
    c.textContent = note;
    el.append(a, b, c);
    return el;
  }));
}

function bindSim() {
  document.getElementById("btn-sim").addEventListener("click", () => (sim.active ? stopSim() : startSim()));
  document.getElementById("btn-thermal-sim").addEventListener("click", startSim);
  document.getElementById("sim-close").addEventListener("click", stopSim);

  document.getElementById("sim-play").addEventListener("click", () => {
    if (!sim.playing && sim.t >= simDayAt(SIM_LAST_MIN)) {
      sim.readings = [];
      simAdvanceTo(simDayAt(6 * 60));
    }
    sim.playing = !sim.playing;
    simRefresh();
  });

  const hour = document.getElementById("sim-hour");
  hour.addEventListener("input", () => {
    sim.dragging = true;
    simAdvanceTo(simDayAt(Number(hour.value)));
    simRefresh();
  });
  hour.addEventListener("change", () => {
    sim.dragging = false;
  });

  document.querySelectorAll("[data-speed]").forEach((button) => {
    button.addEventListener("click", () => {
      sim.speed = Number(button.dataset.speed);
      syncSimControls();
    });
  });

  // Cualquier cambio de condiciones se ve al instante en la lectura actual
  const applyNow = () => {
    simAdvanceTo(sim.t);
    simRefresh();
  };
  SIM_SLIDERS.forEach(([key, label]) => {
    const input = document.getElementById(`sim-${key}`);
    input.addEventListener("input", () => {
      sim.params[key] = Number(input.value);
      document.getElementById(`out-${key}`).textContent = label(sim.params[key]);
      setFill(input);
      applyNow();
    });
  });
  ["shade", "hotspot"].forEach((key) => {
    document.getElementById(`sim-${key}`).addEventListener("change", (event) => {
      sim.params[key] = event.target.checked;
      applyNow();
    });
  });
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      sim.params = { ...SIM_PRESETS[button.dataset.preset] };
      syncSimControls();
      applyNow();
    });
  });
}

// ---------- Historial en la nube (Supabase) ----------
// El ESP32 guarda cada lectura con registrar(); aquí se descargan las filas originales
// por páginas. La gráfica reduce la densidad al dibujar, pero la tabla conserva el historial.
const cloud = {
  readings: [],
  range: null,
  loading: false,
  error: null,
  frame: null,
  thermalIndex: [],
  thermalCache: new Map(),
  selectedFrameId: null,
  selectedReadingAt: null,
};

function cloudActive() {
  const s = state.settings;
  return !!(s.sbUrl && s.sbKey && s.sbDevice);
}

function defaultDevice(topic) {
  const parts = String(topic || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function resetCloud() {
  cloud.readings = [];
  cloud.range = null;
  cloud.error = null;
  cloud.frame = null;
  cloud.thermalIndex = [];
  cloud.thermalCache.clear();
  cloud.selectedFrameId = null;
  cloud.selectedReadingAt = null;
}

async function sbRequest(path, options = {}) {
  const key = state.settings.sbKey;
  const headers = { apikey: key, "Content-Type": "application/json" };
  // Las claves antiguas (JWT) van también como Bearer; las sb_publishable_ no
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(`${state.settings.sbUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body.message || body.error || "";
    } catch {
      detail = "";
    }
    throw new Error(detail || `Supabase respondió ${response.status}`);
  }
  return response.json();
}

async function sbAll(path, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const join = path.includes("?") ? "&" : "?";
    const page = await sbRequest(`${path}${join}limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function rangeStart(key, now = Date.now()) {
  if (key === "all") return null;
  if (key === "today") return startOfDay(now);
  if (key === "48h") return now - 48 * 3600000;
  return now - 7 * 86400000;
}

async function loadCloud() {
  if (!cloudActive() || cloud.loading) return;
  const range = viewRange();
  cloud.loading = true;
  try {
    const desde = rangeStart(range);
    const device = encodeURIComponent(state.settings.sbDevice);
    const since = desde == null ? "" : `&creado=gte.${encodeURIComponent(new Date(desde).toISOString())}`;
    const readingCols = "id,creado,voltaje,corriente,potencia,irradiancia,luz_pct,temp_ambiente,temp_panel,panel_min,panel_max,rssi,tipo_registro,anomalia,severidad,estado_mantenimiento,dato_valido";
    const thermalCols = "id,creado,ancho,alto,t_min,t_prom,t_max";
    const [rows, thermalRows] = await Promise.all([
      sbAll(`/rest/v1/lecturas?select=${readingCols}&dispositivo=eq.${device}${since}&order=creado.asc`),
      sbAll(`/rest/v1/termicas?select=${thermalCols}&dispositivo=eq.${device}${since}&order=creado.asc`),
    ]);
    const history = rows
      .map((r) => coerceReading({
        id: r.id,
        t: Date.parse(r.creado),
        v: r.voltaje,
        i: r.corriente,
        p: r.potencia,
        irr: r.irradiancia,
        light: r.luz_pct,
        tp: r.temp_panel,
        ta: r.temp_ambiente,
        panelMin: r.panel_min,
        panelMax: r.panel_max,
        rssi: r.rssi,
        sourceType: r.tipo_registro,
        anomaly: r.anomalia,
        severity: r.severidad,
        maintenanceState: r.estado_mantenimiento,
        valid: r.dato_valido,
      }))
      .filter(Boolean);
    const lastT = history.length ? history[history.length - 1].t : 0;
    cloud.readings = [...history, ...cloud.readings.filter((r) => r.live && r.t > lastT)];
    cloud.thermalIndex = thermalRows.map((row) => ({
      id: Number(row.id),
      t: Date.parse(row.creado),
      w: Number(row.ancho),
      h: Number(row.alto),
      lo: finiteOrNull(row.t_min),
      avg: finiteOrNull(row.t_prom),
      hi: finiteOrNull(row.t_max),
    })).filter((row) => Number.isFinite(row.id) && Number.isFinite(row.t));
    cloud.error = null;
    if (!cloud.frame && cloud.thermalIndex.length) {
      try {
        cloud.frame = await loadCloudFrame(cloud.thermalIndex[cloud.thermalIndex.length - 1]);
        if (cloud.frame) renderThermal();
      } catch {
        // Las lecturas siguen disponibles aunque falle una matriz térmica.
      }
    }
  } catch (error) {
    cloud.error = error.message || "error desconocido";
  } finally {
    // Aunque falle se marca el rango para no reintentar en cada render; el temporizador reintenta
    cloud.range = range;
    cloud.loading = false;
  }
  render();
}

async function loadCloudFrame(meta) {
  try {
    const selected = meta || cloud.thermalIndex[cloud.thermalIndex.length - 1];
    if (!selected) return null;
    if (cloud.thermalCache.has(selected.id)) return cloud.thermalCache.get(selected.id);
    const rows = await sbRequest(`/rest/v1/termicas?select=id,creado,ancho,alto,datos&id=eq.${selected.id}&limit=1`);
    if (!rows.length) return;
    const frame = parseThermal({ w: rows[0].ancho, h: rows[0].alto, scale: 10, data: rows[0].datos });
    if (!frame) return;
    frame.at = Date.parse(rows[0].creado);
    frame.saved = true;
    frame.id = Number(rows[0].id);
    cloud.thermalCache.set(frame.id, frame);
    return frame;
  } catch (error) {
    // Sin imagen guardada el tablero sigue funcionando
    throw error;
  }
}

function nearestThermalFor(timestamp) {
  const frames = cloud.thermalIndex;
  if (!frames.length || !Number.isFinite(timestamp)) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (frames[mid].t < timestamp) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [frames[lo], frames[lo - 1]].filter(Boolean);
  const nearest = candidates.reduce((best, frame) => !best || Math.abs(frame.t - timestamp) < Math.abs(best.t - timestamp) ? frame : best, null);
  // No todas las capturas quedaron exactamente a cinco minutos. Cada lectura conserva
  // acceso a la matriz real más cercana y la interfaz muestra el desfase en segundos.
  return nearest;
}

async function openThermalForReading(reading, meta = nearestThermalFor(reading.t)) {
  if (!meta) {
    toast("No hay una captura térmica cercana a esta lectura.");
    return;
  }
  try {
    toast("Cargando la matriz térmica registrada…");
    const frame = await loadCloudFrame(meta);
    if (!frame) throw new Error("La captura no está disponible");
    frame.selectedReadingAt = reading.t;
    cloud.frame = frame;
    cloud.selectedFrameId = meta.id;
    cloud.selectedReadingAt = reading.t;
    thermalFrame = null;
    renderThermal();
    renderTable(inRange(readingsSource(), viewRange()));
    const card = document.getElementById("thermal-card");
    card.classList.remove("flash");
    requestAnimationFrame(() => card.classList.add("flash"));
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    const seconds = Math.round(Math.abs(frame.at - reading.t) / 1000);
    toast(seconds <= 2 ? "Captura térmica del mismo registro." : `Captura real más cercana: diferencia de ${seconds} s.`);
  } catch (error) {
    toast(error.message || "No pude cargar la captura térmica.");
  }
}

// Las lecturas en vivo se suman al final del historial: una por cada 15 s, como las que guarda el ESP32
function pushCloudLive(reading) {
  const list = cloud.readings;
  const last = list[list.length - 1];
  if (last && last.live && reading.t - last.liveStart < 15000) {
    list[list.length - 1] = { ...reading, live: true, liveStart: last.liveStart };
  } else if (!last || reading.t > last.t) {
    list.push({ ...reading, live: true, liveStart: reading.t });
  }
}

async function exportCloudCSV() {
  const device = state.settings.sbDevice;
  const desde = rangeStart(viewRange());
  const cols = "creado,voltaje,corriente,potencia,irradiancia,luz_pct,temp_ambiente,temp_panel,panel_min,panel_max,rssi";
  const filter = `dispositivo=eq.${encodeURIComponent(device)}${desde == null ? "" : `&creado=gte.${encodeURIComponent(new Date(desde).toISOString())}`}`;
  toast("Descargando el registro completo desde Supabase…");
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbRequest(`/rest/v1/lecturas?select=${cols}&${filter}&order=creado.asc&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  if (!rows.length) {
    toast("No hay lecturas guardadas en este periodo.");
    return;
  }
  const header = "fecha,voltaje_V,corriente_A,potencia_W,irradiancia_Wm2,luz_pct,temp_ambiente_C,temp_panel_C,panel_min_C,panel_max_C,rssi_dBm";
  const lines = rows.map((row) => cols.split(",").map((col) => row[col] ?? "").join(","));
  const stamp = new Date().toISOString().slice(0, 10);
  download(`registro-${device}-${rangeTitle(viewRange()).toLowerCase().replace(/\s+/g, "-")}-${stamp}.csv`, `﻿${header}\n${lines.join("\n")}\n`);
  toast(`Exporté ${rows.length.toLocaleString("es-MX")} lecturas de Supabase.`);
}

function connectMqtt() {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }
  const { mqttUrl, mqttTopic, mqttUser, mqttPass } = state.settings;
  if (!mqttUrl || !mqttTopic) {
    mqttState = "off";
    renderStatus();
    return;
  }
  if (!window.mqtt) {
    mqttState = "error";
    renderStatus();
    toast("No cargó la librería MQTT. Revisa la conexión a internet.");
    return;
  }
  mqttState = "connecting";
  renderStatus();
  const client = window.mqtt.connect(mqttUrl, {
    clientId: `tablero-${Math.random().toString(16).slice(2, 10)}`,
    username: mqttUser || undefined,
    password: mqttPass || undefined,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clean: true,
  });
  mqttClient = client;
  client.on("connect", () => {
    if (client !== mqttClient) return;
    mqttFailures = 0;
    client.subscribe([`${mqttTopic}/datos`, `${mqttTopic}/termica`, `${mqttTopic}/estado`]);
    if (mqttState !== "ok") mqttState = "waiting";
    renderStatus();
  });
  client.on("reconnect", () => {
    if (client !== mqttClient) return;
    mqttState = "connecting";
    renderStatus();
  });
  // El broker público a veces rechaza el primer intento; mqtt.js reintenta solo a los 5 s,
  // así que solo se avisa del error si falla varias veces seguidas
  client.on("error", () => {
    if (client !== mqttClient) return;
    mqttFailures += 1;
    mqttState = mqttFailures >= 3 ? "error" : "connecting";
    renderStatus();
  });
  client.on("message", (topic, payload) => {
    if (client !== mqttClient) return;
    handleMqtt(topic.slice(mqttTopic.length + 1), new TextDecoder().decode(payload));
  });
}

function handleMqtt(kind, text) {
  if (kind === "estado") {
    if (text.trim() === "offline") mqttState = "offline";
    else if (mqttState !== "ok") mqttState = "waiting";
    renderStatus();
    return;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  lastMqttData = Date.now();
  mqttState = "ok";
  if (kind === "termica") {
    thermalFrame = parseThermal(data) || thermalFrame;
    renderThermal();
    renderStatus();
    return;
  }
  if (kind === "datos") {
    const reading = readingFromPayload(data, Date.now());
    if (reading) ingestLive(reading);
    renderStatus();
  }
}

// Un punto por intervalo: dentro de la ventana se actualiza el último,
// así los KPI van en vivo sin llenar el almacenamiento
function ingestLive(reading) {
  const replaced = beginRealLog();
  const last = state.readings[state.readings.length - 1];
  const windowMs = state.settings.interval * 1000;
  if (!replaced && last && last.t === liveT && reading.t - lastCommitT < windowMs) {
    state.readings[state.readings.length - 1] = reading;
    liveT = reading.t;
  } else {
    upsertReading(reading);
    liveT = reading.t;
    lastCommitT = reading.t;
    saveState();
  }
  state.mode = "real";
  if (cloudActive()) pushCloudLive(reading);
  render();
  if (replaced) toast("Llegó el ESP32 por MQTT. Quité la simulación y seguí con datos reales.");
}

function parseThermal(data) {
  const w = Number(data.w) || 32;
  const h = Number(data.h) || 24;
  const scale = Number(data.scale) || 1;
  const raw = Array.isArray(data.data) ? data.data : [];
  if (raw.length !== w * h) return null;
  const temps = raw.map((value) => Number(value) / scale);
  return { w, h, temps, ...thermalStats(temps), at: Date.now() };
}

// El percentil 75 representa la temperatura típica del panel aunque haya algo de fondo;
// el punto caliente se compara contra ella
function thermalStats(temps) {
  let lo = Infinity;
  let hi = -Infinity;
  let hot = 0;
  let sum = 0;
  temps.forEach((t, index) => {
    if (t < lo) lo = t;
    if (t > hi) {
      hi = t;
      hot = index;
    }
    sum += t;
  });
  const sorted = [...temps].sort((a, b) => a - b);
  return { lo, hi, hot, avg: sum / temps.length, ref: sorted[Math.floor(sorted.length * 0.75)] };
}

const THERMAL_STOPS = [[0, 0, 4], [59, 15, 112], [140, 41, 129], [222, 73, 104], [254, 159, 109], [252, 253, 191]];
const THERMAL_LUT = Array.from({ length: 256 }, (_, k) => {
  const x = (k / 255) * (THERMAL_STOPS.length - 1);
  const a = THERMAL_STOPS[Math.floor(x)];
  const b = THERMAL_STOPS[Math.min(THERMAL_STOPS.length - 1, Math.floor(x) + 1)];
  const f = x - Math.floor(x);
  return a.map((c, j) => Math.round(c + (b[j] - c) * f));
});

function renderThermal() {
  const box = document.querySelector(".thermal-box");
  box.classList.toggle("mirror", !!state.settings.thermalMirror);
  document.getElementById("btn-mirror").setAttribute("aria-pressed", state.settings.thermalMirror ? "true" : "false");
  const frame = sim.active ? sim.frame : (thermalFrame || cloud.frame);
  const set = (id, value) => { document.getElementById(id).textContent = value; };
  document.getElementById("thermal-empty").hidden = !!frame;
  const note = document.getElementById("thermal-note");
  if (!frame) {
    set("thermal-meta", state.settings.mqttUrl ? "Esperando la cámara MLX90640" : "Configura MQTT en ajustes para ver la cámara");
    set("thermal-empty-hint", state.settings.mqttUrl
      ? "El ESP32 todavía no manda imágenes. Mientras tanto puedes probar el simulador."
      : "Conecta el ESP32 por MQTT o prueba el simulador.");
    ["thermal-min", "thermal-max", "thermal-lo", "thermal-avg", "thermal-hi"].forEach((id) => set(id, "—"));
    note.textContent = "";
    return;
  }
  const canvas = document.getElementById("thermal-canvas");
  const ctx = canvas.getContext("2d");
  const small = document.createElement("canvas");
  small.width = frame.w;
  small.height = frame.h;
  const sctx = small.getContext("2d");
  const image = sctx.createImageData(frame.w, frame.h);
  const range = Math.max(0.5, frame.hi - frame.lo);
  frame.temps.forEach((t, index) => {
    const color = THERMAL_LUT[Math.round(clamp((t - frame.lo) / range, 0, 1) * 255)];
    image.data.set([color[0], color[1], color[2], 255], index * 4);
  });
  sctx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);

  const delta = frame.hi - frame.ref;
  // Solo se marca el punto más caliente cuando destaca de verdad; si no, sería ruido
  if (delta > 5) {
    const cellW = canvas.width / frame.w;
    const cellH = canvas.height / frame.h;
    const hx = ((frame.hot % frame.w) + 0.5) * cellW;
    const hy = (Math.floor(frame.hot / frame.w) + 0.5) * cellH;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hx, hy, cellW * 0.9, 0, Math.PI * 2);
    ctx.stroke();
  }

  const selectedOffset = Number.isFinite(frame.selectedReadingAt)
    ? Math.round(Math.abs(frame.at - frame.selectedReadingAt) / 1000)
    : null;
  set("thermal-meta", sim.active
    ? `Simulada · ${fmtTime.format(frame.at)} · ${frame.w}×${frame.h} px`
    : frame.saved && selectedOffset != null
      ? `Captura registrada · ${formatWhen(frame.at)} · ${frame.w}×${frame.h} px · Δ ${selectedOffset} s`
      : frame.saved
        ? `Última guardada · ${formatWhen(frame.at)} · ${frame.w}×${frame.h} px`
        : `Actualizada ${fmtClock.format(frame.at)} · ${frame.w}×${frame.h} px`);
  set("thermal-min", `${fmt(frame.lo, 1)} °C`);
  set("thermal-max", `${fmt(frame.hi, 1)} °C`);
  set("thermal-lo", `${fmt(frame.lo, 1)} °C`);
  set("thermal-avg", `${fmt(frame.avg, 1)} °C`);
  set("thermal-hi", `${fmt(frame.hi, 1)} °C`);
  note.classList.toggle("hot", delta > 10);
  note.textContent = delta > 10
    ? `El punto marcado está ${fmt(delta, 1)} °C sobre la temperatura típica. Puede ser una celda dañada, suciedad o una sombra parcial.`
    : `Temperatura pareja: el punto más caliente está ${fmt(delta, 1)} °C sobre la temperatura típica.`;
}

function bind() {
  document.getElementById("analysis-scope").addEventListener("change", (event) => {
    analysisScope = event.target.value;
    renderAnalytics(inRange(readingsSource(), viewRange()));
  });
  document.getElementById("device-filter").addEventListener("change", (event) => {
    state.settings.sbDevice = event.target.value;
    span = "period";
    periodRange = "all";
    tableExpanded = false;
    tableVisibleCount = 100;
    resetCloud();
    saveState();
    render();
    renderThermal();
    toast(event.target.value.endsWith("-sim") ? "Cargando la serie modelada desde Supabase…" : "Cargando las mediciones del panel…");
  });
  document.getElementById("metric-filter").addEventListener("change", (event) => {
    metric = event.target.value;
    render();
  });
  document.querySelectorAll(".kpi[data-metric]").forEach((card) => {
    card.addEventListener("click", () => {
      metric = card.dataset.metric;
      render();
    });
  });
  document.querySelectorAll("[data-span]").forEach((button) => {
    button.addEventListener("click", () => {
      span = button.dataset.span;
      tableExpanded = false;
      tableVisibleCount = 100;
      render();
    });
  });
  document.getElementById("period-length").addEventListener("change", (event) => {
    if (event.target.value === "today") span = "day";
    else {
      periodRange = event.target.value;
      span = "period";
    }
    tableExpanded = false;
    tableVisibleCount = 100;
    render();
  });

  document.getElementById("btn-add").addEventListener("click", openReading);
  document.getElementById("reading-cancel").addEventListener("click", () => document.getElementById("dlg-reading").close());
  document.getElementById("form-reading").addEventListener("input", updatePreview);
  document.getElementById("form-reading").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const reading = readingFromPayload({
      t: form.t.value,
      v: form.v.value,
      i: form.i.value,
      irr: form.irr.value,
      tp: form.tp.value,
      ta: form.ta.value,
      h: form.h.value,
      wind: form.wind.value,
    });
    if (!reading) {
      toast("Revisa voltaje y corriente.");
      return;
    }
    const replaced = beginRealLog();
    upsertReading(reading);
    state.mode = "real";
    saveState();
    document.getElementById("dlg-reading").close();
    render();
    toast(replaced ? "Primera lectura guardada. La simulación ya no está." : "Lectura guardada.");
  });

  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("settings-cancel").addEventListener("click", () => document.getElementById("dlg-settings").close());
  document.getElementById("form-settings").addEventListener("submit", (event) => {
    event.preventDefault();
    const endpoint = document.getElementById("set-endpoint").value.trim();
    if (endpoint && !/^https?:\/\//i.test(endpoint)) {
      toast("La dirección del sensor debe empezar por http:// o https://");
      return;
    }
    const mqttUrl = document.getElementById("set-mqtt-url").value.trim();
    const mqttTopic = document.getElementById("set-mqtt-topic").value.trim().replace(/[#+]/g, "").replace(/\/+$/, "");
    if (mqttUrl && !/^wss?:\/\//i.test(mqttUrl)) {
      toast("El broker debe empezar por ws:// o wss://");
      return;
    }
    if (mqttUrl && !mqttTopic) {
      toast("Escribe el tema base, el mismo que TOPIC_BASE en el ESP32.");
      return;
    }
    const sbUrl = document.getElementById("set-sb-url").value.trim().replace(/\/+$/, "");
    const sbKey = document.getElementById("set-sb-key").value.trim();
    const sbDevice = document.getElementById("set-sb-device").value.trim();
    if (sbUrl && !/^https:\/\/[^/]+$/i.test(sbUrl)) {
      toast("La URL de Supabase debe verse como https://abcdefgh.supabase.co");
      return;
    }
    if (sbUrl && (!sbKey || !sbDevice)) {
      toast("Para el historial faltan la clave pública y el dispositivo.");
      return;
    }
    const area = numFrom(document.getElementById("set-area").value);
    const nextArea = area && area > 0 ? area : 1.7;
    const areaChanged = Math.abs(nextArea - state.settings.area) > 0.0001;
    state.settings = {
      name: document.getElementById("set-name").value.trim() || "Módulo de prueba",
      site: document.getElementById("set-site").value.trim(),
      area: nextArea,
      endpoint,
      interval: clamp(Number(document.getElementById("set-interval").value) || 15, 5, 3600),
      mqttUrl,
      mqttTopic,
      mqttUser: document.getElementById("set-mqtt-user").value.trim(),
      mqttPass: document.getElementById("set-mqtt-pass").value,
      thermalMirror: state.settings.thermalMirror,
      sbUrl,
      sbKey,
      sbDevice,
    };
    resetCloud();
    if (state.mode === "demo" && areaChanged) state.readings = generateDemo(nextArea);
    saveState();
    document.getElementById("dlg-settings").close();
    render();
    renderThermal();
    applyPoll();
    connectMqtt();
    toast(cloudActive() ? "Ajustes guardados. Cargando el historial de Supabase…" : "Ajustes guardados.");
  });

  document.getElementById("btn-test-sensor").addEventListener("click", async () => {
    const url = document.getElementById("set-endpoint").value.trim();
    if (!url) {
      toast("Escribe primero la dirección del sensor.");
      return;
    }
    try {
      const readings = await fetchSensor(url);
      const sample = readings[readings.length - 1];
      toast(`El sensor respondió: ${fmt(sample.v, 2)} V y ${fmt(sample.i, 2)} A. Guarda los ajustes para empezar a registrar.`);
    } catch (error) {
      toast(error.message || "No pude contactar al sensor.");
    }
  });

  document.getElementById("btn-demo").addEventListener("click", () => {
    state.readings = generateDemo(state.settings.area);
    state.mode = "demo";
    sensorState = "idle";
    saveState();
    document.getElementById("dlg-settings").close();
    render();
    toast("Simulación de 5 días lista.");
  });

  document.getElementById("btn-template").addEventListener("click", templateCSV);
  document.getElementById("btn-clear").addEventListener("click", () => {
    const button = document.getElementById("btn-clear");
    if (!armClear) {
      armClear = true;
      button.textContent = "Confirmar borrado";
      setTimeout(() => {
        armClear = false;
        button.textContent = "Borrar historial";
      }, 4000);
      return;
    }
    state.readings = [];
    state.mode = "real";
    armClear = false;
    button.textContent = "Borrar historial";
    saveState();
    document.getElementById("dlg-settings").close();
    render();
    toast("Historial borrado.");
  });

  document.getElementById("btn-export").addEventListener("click", exportCSV);
  document.getElementById("btn-import").addEventListener("click", () => document.getElementById("file-csv").click());
  document.getElementById("file-csv").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) readFile(file);
    event.target.value = "";
  });
  document.getElementById("btn-more").addEventListener("click", () => {
    const total = inRange(readingsSource(), viewRange()).length;
    if (!tableExpanded) {
      tableExpanded = true;
      tableVisibleCount = Math.min(100, total);
    } else if (tableVisibleCount < total) {
      tableVisibleCount = Math.min(total, tableVisibleCount + 100);
    } else {
      tableExpanded = false;
      tableVisibleCount = 100;
    }
    render();
  });

  document.getElementById("btn-mirror").addEventListener("click", () => {
    state.settings.thermalMirror = !state.settings.thermalMirror;
    saveState();
    renderThermal();
  });
  window.addEventListener("pagehide", saveState);
  bindSim();

  ["dlg-reading", "dlg-settings"].forEach((id) => {
    const dialog = document.getElementById(id);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("drop");
  });
  window.addEventListener("dragleave", () => document.body.classList.remove("drop"));
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    document.body.classList.remove("drop");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) readFile(file);
  });
}

function init() {
  if (!state) {
    state = { settings: defaultSettings(), readings: [], mode: "real" };
    localStorage.setItem(SOURCE_MIGRATION_KEY, "done");
    saveState();
  }
  charts.main = new SolarChart(document.getElementById("chart-main"));
  charts.scatter = new SolarChart(document.getElementById("chart-scatter"));
  charts.histogram = new SolarChart(document.getElementById("chart-histogram"));
  bind();
  render();
  renderThermal();
  applyPoll();
  connectMqtt();
  // index.html#simulador abre el simulador directo, útil para presentaciones
  if (location.hash === "#simulador") startSim();
  // El historial en la nube se refresca cada minuto con lo que el ESP32 haya guardado
  setInterval(() => {
    if (!cloudActive() || sim.active) return;
    cloud.range = null;
    loadCloud();
  }, 60000);
  setInterval(() => {
    if (mqttState === "ok" && Date.now() - lastMqttData > 20000) {
      mqttState = "stale";
      renderStatus();
    }
  }, 5000);
  window.ObservatorioSolar = {
    ingest(payload) {
      const list = Array.isArray(payload) ? payload : [payload];
      const readings = list.map((item) => readingFromPayload(item)).filter(Boolean);
      if (!readings.length) return false;
      beginRealLog();
      readings.forEach((reading) => upsertReading(reading));
      state.mode = "real";
      saveState();
      render();
      return true;
    },
  };
}

init();
