import { formatIsoDate, type Asset, type RunContext, type ServicePlugin } from "@dailyscribe/core";
import {
  Document,
  Line,
  Link,
  Page,
  Polyline,
  Rect,
  StyleSheet,
  Svg,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { BUY_ME_A_COFFEE_URL } from "@/lib/site";

const LOW_BATTERY_THRESHOLD = 20;
const FORECAST_HOURS = 12;
const DEFAULT_WEATHER_ENTITY = "weather.forecast_home";
const DEFAULT_WASTE_CALENDAR = "calendar.halifax_ns";
const FETCH_TIMEOUT_MS = 15000;

export interface HaConfig {
  weatherEntity: string;
  wasteCalendar: string;
}

export function parseHaConfig(config: unknown): HaConfig {
  const raw = (config ?? {}) as { weatherEntity?: unknown; wasteCalendar?: unknown };
  return {
    weatherEntity:
      typeof raw.weatherEntity === "string" && raw.weatherEntity.trim()
        ? raw.weatherEntity.trim()
        : DEFAULT_WEATHER_ENTITY,
    wasteCalendar:
      typeof raw.wasteCalendar === "string" && raw.wasteCalendar.trim()
        ? raw.wasteCalendar.trim()
        : DEFAULT_WASTE_CALENDAR,
  };
}

export interface HaCredentials {
  url: string;
  token: string;
}

export function parseHaCredentials(secretValue: string | undefined): HaCredentials | null {
  if (!secretValue) return null;
  try {
    const parsed = JSON.parse(secretValue) as { url?: string; token?: string };
    if (parsed.url && parsed.token) {
      return { url: parsed.url.replace(/\/+$/, ""), token: parsed.token.trim() };
    }
  } catch {
    // If not JSON, ignore
  }
  return null;
}

// HA State interface
export interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

export interface HaCalendarEvent {
  start?: { dateTime?: string; date?: string } | string;
  end?: { dateTime?: string; date?: string } | string;
  summary?: string;
}

export interface HaForecastItem {
  datetime: string;
  temperature: number;
  templow?: number;
  precipitation_probability?: number;
  condition?: string;
}

// API Callers
async function haFetch<T>(baseUrl: string, token: string, path: string, options: RequestInit = {}): Promise<T> {
  const url = `${baseUrl}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error(`Home Assistant HTTP 401 Unauthorized — check your Access Token.`);
      }
      throw new Error(`Home Assistant API ${path} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Home Assistant")) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
    let causeText = "";
    if (cause instanceof Error) {
      causeText = cause.message;
    } else if (cause && typeof cause === "object") {
      const code = (cause as { code?: string }).code;
      const sysMsg = (cause as { message?: string }).message;
      causeText = code ?? sysMsg ?? "";
    }
    const detail = causeText && causeText !== msg ? `${msg} (${causeText})` : msg;
    throw new Error(`Failed to connect to Home Assistant at ${baseUrl}: ${detail}`);
  }
}

export async function fetchHaStates(baseUrl: string, token: string): Promise<HaState[]> {
  return haFetch<HaState[]>(baseUrl, token, "/api/states");
}

export async function fetchHaCalendarEvents(
  baseUrl: string,
  token: string,
  entityId: string,
  startIso: string,
  endIso: string,
): Promise<HaCalendarEvent[]> {
  const query = new URLSearchParams({ start: startIso, end: endIso }).toString();
  return haFetch<HaCalendarEvent[]>(baseUrl, token, `/api/calendars/${entityId}?${query}`);
}

export async function fetchHaForecast(
  baseUrl: string,
  token: string,
  entityId: string,
  ftype: "daily" | "hourly" = "hourly",
): Promise<HaForecastItem[]> {
  try {
    const res = await haFetch<{ service_response?: Record<string, { forecast?: HaForecastItem[] }> }>(
      baseUrl,
      token,
      "/api/services/weather/get_forecasts?return_response=true",
      {
        method: "POST",
        body: JSON.stringify({ entity_id: entityId, type: ftype }),
      },
    );
    return res?.service_response?.[entityId]?.forecast ?? [];
  } catch (err) {
    console.warn(`HA forecast fetch failed for ${entityId}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

// Data Processing Helpers
function fmtNum(value: unknown, suffix = ""): string {
  if (value === null || value === undefined) return "—";
  const num = Number(value);
  return isNaN(num) ? `${value}${suffix}` : `${Math.round(num * 10) / 10}${suffix}`;
}

function parseIsoDate(val: unknown): Date | null {
  if (typeof val === "string") {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  if (val && typeof val === "object" && "dateTime" in val) {
    const d = new Date(String((val as { dateTime: string }).dateTime));
    return isNaN(d.getTime()) ? null : d;
  }
  if (val && typeof val === "object" && "date" in val) {
    const d = new Date(String((val as { date: string }).date));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export interface HaSummaryData {
  todayFormatted: string;
  sunInfo: string;
  weatherNow: {
    condition: string;
    tempStr: string;
    highLowStr: string;
    detailsStr: string;
  } | null;
  hourlyForecast: {
    points: { hourLabel: string; temp: number; precip: number }[];
    tMin: number;
    tMax: number;
  } | null;
  anomalies: string[];
  calendarRows: string[];
  climateRows: { room: string; temp: string; rh: string; target: string; action: string }[];
  batteryRows: { name: string; level: number; isLow: boolean }[];
}

export function extractHaSummaryData(
  states: HaState[],
  hourlyForecast: HaForecastItem[],
  dailyForecast: HaForecastItem[],
  calendarEvents: { calId: string; events: HaCalendarEvent[] }[],
  config: HaConfig,
  timeZone: string,
  nowDate: Date,
): HaSummaryData {
  // 1. Header. `nowDate` is the digest's nominal calendar date, pinned to UTC
  // midnight by the dispatcher's localParts() — NOT a true instant, so it must
  // be formatted in UTC (matching formatLongDate in every other plugin), not
  // the household's real timeZone: re-applying a negative-offset timeZone here
  // would roll the UTC-midnight instant back to the previous local day.
  const todayFormatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(nowDate);

  const sunState = states.find((s) => s.entity_id === "sun.sun");
  const sunAttrs = sunState?.attributes ?? {};
  const sunParts: string[] = [];
  if (sunAttrs.next_setting) {
    const setDt = parseIsoDate(sunAttrs.next_setting);
    if (setDt) {
      const setTime = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
        .format(setDt)
        .toLowerCase();
      sunParts.push(`Sunset ${setTime}`);
    }
  }
  if (sunAttrs.next_rising) {
    const riseDt = parseIsoDate(sunAttrs.next_rising);
    if (riseDt) {
      const riseTime = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
        .format(riseDt)
        .toLowerCase();
      sunParts.push(`Sunrise ${riseTime}`);
    }
  }
  const sunInfo = sunParts.join(" · ");

  // 2. Weather Now
  const weatherState = states.find((s) => s.entity_id === config.weatherEntity);
  let weatherNow: HaSummaryData["weatherNow"] = null;
  if (weatherState) {
    const attrs = weatherState.attributes ?? {};
    const condition = String(weatherState.state || "").replace(/[-_]/g, " ").toUpperCase();
    const tempUnit = String(attrs.temperature_unit ?? "°C");
    const currentTemp = attrs.temperature !== undefined ? fmtNum(attrs.temperature, tempUnit) : "";

    let highLowStr = "";
    if (dailyForecast.length > 0) {
      const high = dailyForecast[0].temperature;
      const low = dailyForecast[0].templow;
      if (high !== undefined && low !== undefined) {
        highLowStr = `High ${fmtNum(high, tempUnit)} / Low ${fmtNum(low, tempUnit)}`;
      }
    }

    const details: string[] = [];
    if (attrs.humidity !== undefined) details.push(`Humidity ${fmtNum(attrs.humidity, "%")}`);
    if (attrs.wind_speed !== undefined)
      details.push(`Wind ${fmtNum(attrs.wind_speed, " " + String(attrs.wind_speed_unit ?? "km/h"))}`);

    weatherNow = {
      condition,
      tempStr: currentTemp ? `Now ${currentTemp}` : "",
      highLowStr,
      detailsStr: details.join(" · "),
    };
  }

  // 3. Hourly Forecast
  let hourlyData: HaSummaryData["hourlyForecast"] = null;
  if (hourlyForecast.length > 0) {
    const points: { hourLabel: string; temp: number; precip: number }[] = [];
    for (const entry of hourlyForecast.slice(0, FORECAST_HOURS)) {
      const dt = parseIsoDate(entry.datetime);
      if (!dt) continue;
      const hourLabel = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric" })
        .format(dt)
        .toLowerCase()
        .replace(" ", "");
      points.push({
        hourLabel,
        temp: Number(entry.temperature || 0),
        precip: Number(entry.precipitation_probability || 0),
      });
    }
    if (points.length > 0) {
      const temps = points.map((p) => p.temp);
      const tMin = Math.min(...temps);
      let tMax = Math.max(...temps);
      if (tMin === tMax) tMax = tMin + 1;
      hourlyData = { points, tMin, tMax };
    }
  }

  // 4. Anomalies / Heads Up
  const anomalies: string[] = [];
  for (const s of states) {
    const eid = s.entity_id;
    const attrs = s.attributes ?? {};
    const friendlyName = String(attrs.friendly_name ?? eid);

    if (eid.startsWith("binary_sensor.") && eid.includes("leak") && s.state === "on") {
      anomalies.push(`WATER LEAK: ${friendlyName}`);
    }
  }

  const openDevices: string[] = [];
  for (const s of states) {
    if (!s.entity_id.startsWith("binary_sensor.")) continue;
    const attrs = s.attributes ?? {};
    const dclass = String(attrs.device_class ?? "");
    if (["door", "window", "opening", "garage_door"].includes(dclass) && s.state === "on") {
      openDevices.push(String(attrs.friendly_name ?? s.entity_id));
    }
  }
  if (openDevices.length > 0) anomalies.push(`Open: ${openDevices.join(", ")}`);

  const lowBatteries: { name: string; level: number }[] = [];
  for (const s of states) {
    const attrs = s.attributes ?? {};
    if (attrs.device_class === "battery") {
      const level = Number(s.state);
      if (!isNaN(level) && level <= LOW_BATTERY_THRESHOLD) {
        const name = String(attrs.friendly_name ?? s.entity_id).replace(/ Battery$/i, "");
        lowBatteries.push({ name, level });
      }
    }
  }
  if (lowBatteries.length > 0) {
    const batStr = lowBatteries.map((b) => `${b.name} (${Math.round(b.level)}%)`).join(", ");
    anomalies.push(`Low battery: ${batStr}`);
  }

  const unlockedLocks = states
    .filter((s) => s.entity_id.startsWith("lock.") && s.state === "unlocked")
    .map((s) => String(s.attributes?.friendly_name ?? s.entity_id));
  if (unlockedLocks.length > 0) anomalies.push(`Unlocked: ${unlockedLocks.join(", ")}`);

  // 5. Today's Calendar
  const calendarRows: string[] = [];
  for (const { calId, events } of calendarEvents) {
    if (calId === config.wasteCalendar && events.length > 0) {
      const summaries = events.map((e) => e.summary ?? "?").join(", ");
      calendarRows.push(`Waste pickup: ${summaries}`);
    } else {
      for (const ev of events) {
        const startDt = parseIsoDate(ev.start);
        const timeStr = startDt
          ? new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
              .format(startDt)
              .toLowerCase()
          : "All day";
        calendarRows.push(`${timeStr} ${ev.summary ?? ""}`);
      }
    }
  }

  // 6. Indoor Climate
  const climateRows: HaSummaryData["climateRows"] = [];
  for (const s of states) {
    if (!s.entity_id.startsWith("climate.")) continue;
    const attrs = s.attributes ?? {};
    climateRows.push({
      room: String(attrs.friendly_name ?? s.entity_id),
      temp: fmtNum(attrs.current_temperature, "°"),
      rh: fmtNum(attrs.current_humidity, "%"),
      target: fmtNum(attrs.temperature, "°"),
      action: String(attrs.hvac_action ?? s.state ?? "—"),
    });
  }

  // 7. Batteries
  const batteryRows: HaSummaryData["batteryRows"] = [];
  for (const s of states) {
    const attrs = s.attributes ?? {};
    if (attrs.device_class === "battery") {
      const level = Number(s.state);
      if (!isNaN(level)) {
        const name = String(attrs.friendly_name ?? s.entity_id).replace(/ Battery$/i, "");
        batteryRows.push({ name, level, isLow: level <= LOW_BATTERY_THRESHOLD });
      }
    }
  }
  batteryRows.sort((a, b) => a.level - b.level);

  return {
    todayFormatted,
    sunInfo,
    weatherNow,
    hourlyForecast: hourlyData,
    anomalies,
    calendarRows,
    climateRows,
    batteryRows,
  };
}

// React-PDF Stylesheet
const styles = StyleSheet.create({
  page: { paddingVertical: 40, paddingHorizontal: 48, fontFamily: "Helvetica", color: "#111111" },
  masthead: { fontSize: 24, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  date: { fontSize: 11, color: "#444444", marginBottom: 14 },
  section: { marginBottom: 14 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    borderBottom: "1pt solid #000000",
    paddingBottom: 2,
    marginBottom: 6,
  },
  textRow: { fontSize: 10, color: "#222222", lineHeight: 1.3, marginBottom: 3 },
  boldText: { fontFamily: "Helvetica-Bold" },
  bulletList: { marginLeft: 10, marginBottom: 4 },
  bulletItem: { fontSize: 9.5, color: "#222222", marginBottom: 2 },
  table: { width: "100%", fontSize: 9, marginTop: 4 },
  tableHeader: {
    flexDirection: "row",
    borderBottom: "1pt solid #666666",
    paddingBottom: 2,
    fontFamily: "Helvetica-Bold",
  },
  tableRow: { flexDirection: "row", borderBottom: "0.5pt solid #e0e0e0", paddingVertical: 3 },
  colRoom: { flex: 2 },
  colNum: { flex: 1, textAlign: "right" },
  colAction: { flex: 1, textAlign: "right" },
  chartContainer: { marginVertical: 6 },
  footer: { position: "absolute", bottom: 20, left: 48, right: 48, fontSize: 8, color: "#888888", textAlign: "center" },
  coffee: { fontSize: 9, color: "#888888", marginBottom: 14 },
});

// React-PDF Document Component. `digest` suppresses this document's own
// "Page X of Y" (only correct relative to its own PDF) since a digest
// bundle gets one correct page count drawn across the whole assembled
// document instead.
export function HaDocument({ data, date, digest }: { data: HaSummaryData; date: Date; digest?: boolean }) {
  const width = 500;
  const height = 110;
  const padL = 30;
  const padR = 10;
  const padT = 15;
  const padB = 25;

  let polylinePoints = "";
  let bars: { x: number; y: number; w: number; h: number }[] = [];
  let xLabels: { x: number; label: string }[] = [];

  if (data.hourlyForecast) {
    const { points, tMin, tMax } = data.hourlyForecast;
    const n = points.length;

    const xOf = (i: number) => (n === 1 ? padL + (width - padL - padR) / 2 : padL + (i * (width - padL - padR)) / (n - 1));
    const yOfTemp = (t: number) => padT + ((tMax - t) / (tMax - tMin)) * (height - padT - padB);

    polylinePoints = points.map((p, i) => `${xOf(i).toFixed(1)},${yOfTemp(p.temp).toFixed(1)}`).join(" ");

    const barW = Math.max(4, (width - padL - padR) / n - 4);
    bars = points
      .filter((p) => p.precip > 0)
      .map((p, i) => {
        const bh = (height - padT - padB) * (p.precip / 100) * 0.4;
        return {
          x: xOf(i) - barW / 2,
          y: height - padB - bh,
          w: barW,
          h: bh,
        };
      });

    const step = Math.max(1, Math.floor(n / 4));
    for (let i = 0; i < n; i += step) {
      xLabels.push({ x: xOf(i), label: points[i].hourLabel });
    }
  }

  return (
    <Document title={`Home Status — ${formatIsoDate(date)}`} author="Daily Scribe">
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.masthead}>Home Status</Text>
        <Text style={styles.date}>
          {data.todayFormatted} {data.sunInfo ? `· ${data.sunInfo}` : ""}
        </Text>
        {!digest && (
          <Link src={BUY_ME_A_COFFEE_URL} style={styles.coffee}>
            Enjoy this with your coffee? Consider buying the creator one, it helps cover the running costs.
          </Link>
        )}

        {/* Weather Now */}
        {data.weatherNow && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Weather</Text>
            <Text style={styles.textRow}>
              <Text style={styles.boldText}>{data.weatherNow.condition}</Text>
              {data.weatherNow.tempStr ? ` · ${data.weatherNow.tempStr}` : ""}
              {data.weatherNow.highLowStr ? ` · ${data.weatherNow.highLowStr}` : ""}
            </Text>
            {data.weatherNow.detailsStr ? <Text style={styles.textRow}>{data.weatherNow.detailsStr}</Text> : null}
          </View>
        )}

        {/* 12h Weather Chart */}
        {data.hourlyForecast && (
          <View style={[styles.section, styles.chartContainer]}>
            <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
              <Line x1={padL} y1={height - padB} x2={width - padR} y2={height - padB} stroke="#cccccc" strokeWidth={1} />
              {bars.map((b, i) => (
                <Rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="#bbbbbb" />
              ))}
              <Polyline points={polylinePoints} fill="none" stroke="#111111" strokeWidth={2} />
              {xLabels.map((xl, i) => (
                <Text key={i} x={xl.x} y={height - 6} style={{ fontSize: 8, fill: "#555555" }}>
                  {xl.label}
                </Text>
              ))}
            </Svg>
          </View>
        )}

        {/* Anomalies / Heads Up */}
        {data.anomalies.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Heads Up</Text>
            <View style={styles.bulletList}>
              {data.anomalies.map((item, i) => (
                <Text key={i} style={styles.bulletItem}>
                  • {item}
                </Text>
              ))}
            </View>
          </View>
        )}

        {/* Today's Schedule */}
        {data.calendarRows.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Today</Text>
            <View style={styles.bulletList}>
              {data.calendarRows.map((row, i) => (
                <Text key={i} style={styles.bulletItem}>
                  • {row}
                </Text>
              ))}
            </View>
          </View>
        )}

        {/* Indoor Climate Table */}
        {data.climateRows.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Indoor Climate</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={styles.colRoom}>Room</Text>
                <Text style={styles.colNum}>Temp</Text>
                <Text style={styles.colNum}>RH</Text>
                <Text style={styles.colNum}>Target</Text>
                <Text style={styles.colAction}>Mode</Text>
              </View>
              {data.climateRows.map((row, i) => (
                <View key={i} style={styles.tableRow}>
                  <Text style={styles.colRoom}>{row.room}</Text>
                  <Text style={styles.colNum}>{row.temp}</Text>
                  <Text style={styles.colNum}>{row.rh}</Text>
                  <Text style={styles.colNum}>{row.target}</Text>
                  <Text style={styles.colAction}>{row.action}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Batteries Table */}
        {data.batteryRows.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Batteries</Text>
            <View style={styles.table}>
              {data.batteryRows.slice(0, 10).map((row, i) => (
                <View key={i} style={styles.tableRow}>
                  <Text style={styles.colRoom}>{row.name}</Text>
                  <Text style={[styles.colNum, row.isLow ? styles.boldText : {}]}>{Math.round(row.level)}%</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            digest ? "Delivered by Daily Scribe" : `Delivered by Daily Scribe · Page ${pageNumber} of ${totalPages}`
          }
          fixed
        />
      </Page>
    </Document>
  );
}

export async function renderHaPdf(data: HaSummaryData, date: Date, digest?: boolean): Promise<Buffer> {
  return renderToBuffer(<HaDocument data={data} date={date} digest={digest} />);
}

export const haSummaryPlugin: ServicePlugin = {
  id: "ha-summary",
  label: "Home Assistant Summary",
  async run(ctx: RunContext): Promise<Asset[]> {
    const config = parseHaConfig(ctx.config);
    const creds = parseHaCredentials(ctx.secrets.ha);
    if (!creds) {
      throw new Error("Home Assistant URL and Long-Lived Access Token are not configured in your account.");
    }

    const states = await fetchHaStates(creds.url, creds.token);

    // Fetch weather forecast
    const hourlyForecast = await fetchHaForecast(creds.url, creds.token, config.weatherEntity, "hourly");
    const dailyForecast = await fetchHaForecast(creds.url, creds.token, config.weatherEntity, "daily");

    // Fetch calendar events for today
    const now = ctx.date;
    const startIso = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endIso = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const calendarEntities = states.filter((s) => s.entity_id.startsWith("calendar.")).map((s) => s.entity_id);
    const calendarEvents = await Promise.all(
      calendarEntities.map(async (calId) => {
        try {
          const events = await fetchHaCalendarEvents(creds.url, creds.token, calId, startIso, endIso);
          return { calId, events };
        } catch {
          return { calId, events: [] };
        }
      }),
    );

    const timezone = (ctx.config as { timezone?: string }).timezone || "America/Toronto";
    const summaryData = extractHaSummaryData(
      states,
      hourlyForecast,
      dailyForecast,
      calendarEvents,
      config,
      timezone,
      ctx.date,
    );

    const bytes = await renderHaPdf(summaryData, ctx.date, ctx.digest);
    return [
      {
        filename: `home-status-${formatIsoDate(ctx.date)}.pdf`,
        contentType: "application/pdf",
        bytes,
      },
    ];
  },
};
