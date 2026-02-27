#!/usr/bin/env node

/**
 * Tessie MCP Server v1.1.0
 *
 * An MCP server that exposes the Tessie API for controlling and
 * monitoring Tesla vehicles via Claude or any MCP-compatible client.
 *
 * Authentication: Set the TESSIE_API_TOKEN environment variable
 * with your token from https://dash.tessie.com/settings/api
 *
 * Optional unit preference env vars:
 *   TESSIE_DISTANCE_FORMAT  = "mi" | "km"    (default: API default)
 *   TESSIE_TEMP_FORMAT      = "f"  | "c"     (default: API default)
 *   TESSIE_PRESSURE_FORMAT  = "psi"| "bar" | "kpa" (default: API default)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch, { RequestInit } from "node-fetch";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.tessie.com";

function getToken(): string {
  const token = process.env.TESSIE_API_TOKEN;
  if (!token) {
    throw new Error(
      "TESSIE_API_TOKEN environment variable is required. " +
      "Get your token at https://dash.tessie.com/settings/api"
    );
  }
  return token;
}

function getDefaultVin(): string | undefined {
  return process.env.TESSIE_DEFAULT_VIN;
}

// Unit preference defaults from environment
function getDefaultDistanceFormat(): "mi" | "km" | undefined {
  const v = process.env.TESSIE_DISTANCE_FORMAT;
  if (v === "mi" || v === "km") return v;
  return undefined;
}

function getDefaultTempFormat(): "f" | "c" | undefined {
  const v = process.env.TESSIE_TEMP_FORMAT;
  if (v === "f" || v === "c") return v;
  return undefined;
}

function getDefaultPressureFormat(): "psi" | "bar" | "kpa" | undefined {
  const v = process.env.TESSIE_PRESSURE_FORMAT;
  if (v === "psi" || v === "bar" || v === "kpa") return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface TessieRequestOptions {
  method?: "GET" | "POST";
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
}

async function tessieRequest({ method = "GET", path, params, body }: TessieRequestOptions): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  const token = getToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const fetchOptions: RequestInit = { method, headers };

  if (body && method === "POST") {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tessie API error ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return { raw: await response.text() };
}

async function get(path: string, params?: Record<string, string | number | boolean | undefined>) {
  return tessieRequest({ method: "GET", path, params });
}

async function post(path: string, params?: Record<string, string | number | boolean | undefined>, body?: Record<string, unknown>) {
  return tessieRequest({ method: "POST", path, params, body });
}

// ---------------------------------------------------------------------------
// Auto-wake helpers
// ---------------------------------------------------------------------------

const WAKE_POLL_INTERVAL_MS = 3000;
const WAKE_TIMEOUT_MS = 90_000;

/**
 * Checks whether the vehicle is currently awake.
 */
async function isVehicleAwake(vin: string): Promise<boolean> {
  const data = await get(`/${vin}/status`) as { status?: string };
  return data?.status === "awake";
}

/**
 * Wakes a sleeping vehicle and waits until it is awake (up to 90 seconds).
 * Returns immediately if the vehicle is already awake.
 * Throws if the vehicle does not wake within the timeout.
 */
async function ensureAwake(vin: string): Promise<void> {
  // Fast path — already awake
  if (await isVehicleAwake(vin)) return;

  // Send wake command
  await post(`/${vin}/wake`);

  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_INTERVAL_MS));
    if (await isVehicleAwake(vin)) return;
  }

  throw new Error(
    `Vehicle ${vin} did not wake within ${WAKE_TIMEOUT_MS / 1000}s. ` +
    "Try calling wake_vehicle manually and retrying."
  );
}

/**
 * Sends a command to the vehicle, auto-waking it first if needed.
 */
async function command(
  vin: string,
  commandPath: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  await ensureAwake(vin);
  return post(commandPath, params);
}

// ---------------------------------------------------------------------------
// Reusable Zod schemas
// ---------------------------------------------------------------------------

const VinSchema = z.string().optional().describe("Vehicle Identification Number (VIN). Defaults to TESSIE_DEFAULT_VIN env var if set.").transform((val) => {
  const vin = val || getDefaultVin();
  if (!vin) {
    throw new Error("VIN is required. Provide it as a parameter or set TESSIE_DEFAULT_VIN environment variable.");
  }
  return vin;
});

const CommandOptionsSchema = {
  wait_for_completion: z.boolean().optional().describe("Wait for the command to complete before returning"),
  max_attempts: z.number().optional().describe("Maximum retry attempts"),
};

const TimeRangeSchema = {
  from: z.number().optional().describe("Start timestamp (Unix epoch seconds)"),
  to: z.number().optional().describe("End timestamp (Unix epoch seconds)"),
};

const DistanceFormatSchema = z.enum(["mi", "km"]).optional().describe("Distance format (overrides TESSIE_DISTANCE_FORMAT env var)");
const TemperatureFormatSchema = z.enum(["f", "c"]).optional().describe("Temperature format (overrides TESSIE_TEMP_FORMAT env var)");
const TimezoneSchema = z.string().optional().describe("Timezone (e.g. America/Los_Angeles)");

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "tessie",
  version: "1.1.0",
});

// ===================== RESOURCES =====================

server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const defaultVin = getDefaultVin();
  const resources = [
    {
      uri: "tessie://vehicles",
      name: "All Vehicles",
      description: "Fleet overview — all vehicles on the Tessie account",
      mimeType: "application/json",
    },
  ];

  if (defaultVin) {
    resources.push(
      {
        uri: `tessie://${defaultVin}/state`,
        name: "Vehicle State",
        description: `Full live state for ${defaultVin} — charge, climate, drive, config`,
        mimeType: "application/json",
      },
      {
        uri: `tessie://${defaultVin}/status`,
        name: "Vehicle Status",
        description: `Awake/asleep status for ${defaultVin}`,
        mimeType: "application/json",
      }
    );
  }

  return { resources };
});

server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  // tessie://vehicles
  if (uri === "tessie://vehicles") {
    const data = await get("/vehicles");
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  // tessie://{vin}/state
  const stateMatch = uri.match(/^tessie:\/\/(.+)\/state$/);
  if (stateMatch) {
    const vin = stateMatch[1];
    const data = await get(`/${vin}/state`, { use_cache: true });
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  // tessie://{vin}/status
  const statusMatch = uri.match(/^tessie:\/\/(.+)\/status$/);
  if (statusMatch) {
    const vin = statusMatch[1];
    const data = await get(`/${vin}/status`);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
});

// ===================== VEHICLE STATE & DATA =====================

server.tool(
  "get_vehicles",
  "Returns the latest state of all vehicles on the account",
  {
    only_active: z.boolean().optional().describe("Only return active vehicles"),
  },
  async ({ only_active }) => {
    const data = await get("/vehicles", { only_active });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_vehicle_state",
  "Returns the latest state of a specific vehicle including drive state, charge state, climate state, and vehicle config",
  {
    vin: VinSchema,
    use_cache: z.boolean().optional().describe("Use cached data (default true). Set false to wake the vehicle for fresh data."),
  },
  async ({ vin, use_cache }) => {
    const data = await get(`/${vin}/state`, { use_cache });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_vehicle_status",
  "Returns whether a vehicle is awake, asleep, or waiting_for_sleep",
  { vin: VinSchema },
  async ({ vin }) => {
    const data = await get(`/${vin}/status`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_battery",
  "Returns battery level, range, voltage, temperature, and energy stats",
  { vin: VinSchema },
  async ({ vin }) => {
    const data = await get(`/${vin}/battery`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_battery_health",
  "Returns battery health measurements for a vehicle over time (degradation, capacity, max range)",
  {
    vin: VinSchema,
    ...TimeRangeSchema,
    distance_format: DistanceFormatSchema,
  },
  async ({ vin, from, to, distance_format }) => {
    const data = await get(`/${vin}/battery_health`, {
      from,
      to,
      distance_format: distance_format ?? getDefaultDistanceFormat(),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_location",
  "Returns the vehicle's coordinates, street address, and saved location name",
  { vin: VinSchema },
  async ({ vin }) => {
    const data = await get(`/${vin}/location`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_weather",
  "Returns the weather forecast around the vehicle's current location",
  { vin: VinSchema },
  async ({ vin }) => {
    const data = await get(`/${vin}/weather`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_tire_pressure",
  "Returns tire pressure for all four tires",
  {
    vin: VinSchema,
    pressure_format: z.enum(["bar", "kpa", "psi"]).optional().describe("Pressure unit (overrides TESSIE_PRESSURE_FORMAT env var)"),
    ...TimeRangeSchema,
  },
  async ({ vin, pressure_format, from, to }) => {
    const data = await get(`/${vin}/tire_pressure`, {
      pressure_format: pressure_format ?? getDefaultPressureFormat(),
      from,
      to,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_consumption_since_charge",
  "Returns energy consumption data since the vehicle was last charged",
  { vin: VinSchema },
  async ({ vin }) => {
    const data = await get(`/${vin}/consumption_since_charge`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_firmware_alerts",
  "Returns firmware alerts generated by the vehicle",
  { vin: VinSchema },
  async ({ vin }) => {
    const data = await get(`/${vin}/firmware_alerts`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== COMPOSITE TOOL =====================

server.tool(
  "get_full_status",
  "Returns a combined snapshot of battery, location, and full vehicle state in one call — ideal for a quick overall check",
  {
    vin: VinSchema,
  },
  async ({ vin }) => {
    // Fan out three requests in parallel
    const [battery, location, state] = await Promise.allSettled([
      get(`/${vin}/battery`),
      get(`/${vin}/location`),
      get(`/${vin}/state`, { use_cache: true }),
    ]);

    const result = {
      battery: battery.status === "fulfilled" ? battery.value : { error: (battery as PromiseRejectedResult).reason?.message },
      location: location.status === "fulfilled" ? location.value : { error: (location as PromiseRejectedResult).reason?.message },
      state: state.status === "fulfilled" ? state.value : { error: (state as PromiseRejectedResult).reason?.message },
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ===================== DRIVES & CHARGES =====================

server.tool(
  "get_drives",
  "Returns a list of drives for the vehicle, with distance, energy, speed, and route details",
  {
    vin: VinSchema,
    ...TimeRangeSchema,
    distance_format: DistanceFormatSchema,
    temperature_format: TemperatureFormatSchema,
    timezone: TimezoneSchema,
    tag: z.string().optional().describe("Filter by drive tag"),
    exclude_tag: z.string().optional().describe("Exclude drives with this tag"),
    minimum_distance: z.number().optional().describe("Minimum drive distance to include"),
    limit: z.number().optional().describe("Maximum number of drives to return"),
  },
  async ({ vin, from, to, distance_format, temperature_format, timezone, tag, exclude_tag, minimum_distance, limit }) => {
    const data = await get(`/${vin}/drives`, {
      from,
      to,
      distance_format: distance_format ?? getDefaultDistanceFormat(),
      temperature_format: temperature_format ?? getDefaultTempFormat(),
      timezone,
      tag,
      exclude_tag,
      minimum_distance,
      limit,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_drive_path",
  "Returns the GPS path for drives in a given timeframe",
  {
    vin: VinSchema,
    ...TimeRangeSchema,
    details: z.boolean().optional().describe("Include speed, battery, autopilot details per point"),
    simplify: z.boolean().optional().describe("Simplify the path (default true)"),
  },
  async ({ vin, from, to, details, simplify }) => {
    const data = await get(`/${vin}/path`, { from, to, details, simplify });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_drive_tag",
  "Sets a tag (e.g. 'business', 'personal') on one or more drives",
  {
    vin: VinSchema,
    drives: z.string().describe("Comma-separated list of drive IDs"),
    tag: z.string().describe("Tag to apply"),
  },
  async ({ vin, drives, tag }) => {
    const data = await post(`/${vin}/drives/set_tag`, undefined, { drives, tag });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_charges",
  "Returns charging sessions for the vehicle",
  {
    vin: VinSchema,
    ...TimeRangeSchema,
    distance_format: DistanceFormatSchema,
    timezone: TimezoneSchema,
    superchargers_only: z.boolean().optional().describe("Only return Supercharger sessions"),
    minimum_energy_added: z.number().optional().describe("Minimum kWh added to include"),
    limit: z.number().optional().describe("Maximum number of charges to return"),
  },
  async ({ vin, from, to, distance_format, timezone, superchargers_only, minimum_energy_added, limit }) => {
    const data = await get(`/${vin}/charges`, {
      from,
      to,
      distance_format: distance_format ?? getDefaultDistanceFormat(),
      timezone,
      superchargers_only,
      minimum_energy_added,
      limit,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_charge_cost",
  "Sets the cost for a specific charging session",
  {
    vin: VinSchema,
    charge_id: z.string().describe("The charge session ID"),
    cost: z.number().describe("Cost in dollars"),
  },
  async ({ vin, charge_id, cost }) => {
    const data = await post(`/${vin}/charges/${charge_id}/set_cost`, { cost });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_idles",
  "Returns idle periods (vehicle parked, not driving or charging)",
  {
    vin: VinSchema,
    ...TimeRangeSchema,
    distance_format: DistanceFormatSchema,
    timezone: TimezoneSchema,
    limit: z.number().optional().describe("Maximum number of idles to return"),
  },
  async ({ vin, from, to, distance_format, timezone, limit }) => {
    const data = await get(`/${vin}/idles`, {
      from,
      to,
      distance_format: distance_format ?? getDefaultDistanceFormat(),
      timezone,
      limit,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== WAKE =====================

server.tool(
  "wake_vehicle",
  "Explicitly wakes the vehicle from sleep (also called automatically before any command). Times out after 90 seconds.",
  { vin: VinSchema },
  async ({ vin }) => {
    await ensureAwake(vin);
    return { content: [{ type: "text", text: JSON.stringify({ status: "awake" }, null, 2) }] };
  }
);

// ===================== LOCK / UNLOCK =====================

server.tool(
  "lock",
  "Locks the vehicle doors (auto-wakes if asleep)",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/lock`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "unlock",
  "Unlocks the vehicle doors (auto-wakes if asleep)",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/unlock`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== TRUNKS =====================

server.tool(
  "open_front_trunk",
  "Opens the front trunk (frunk) — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/activate_front_trunk`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "open_rear_trunk",
  "Opens the rear trunk, or closes it if already open (powered trunk required) — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/activate_rear_trunk`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== WINDOWS & SUNROOF =====================

server.tool(
  "vent_windows",
  "Vents all windows slightly open — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/vent_windows`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "close_windows",
  "Closes all windows — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/close_windows`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "vent_sunroof",
  "Vents the sunroof — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/vent_sunroof`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "close_sunroof",
  "Closes the sunroof — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/close_sunroof`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== TONNEAU =====================

server.tool(
  "open_tonneau",
  "Opens the tonneau cover (Cybertruck) — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/open_tonneau`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "close_tonneau",
  "Closes the tonneau cover (Cybertruck) — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/close_tonneau`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== CLIMATE =====================

server.tool(
  "start_climate",
  "Starts the climate system and begins preconditioning the battery — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/start_climate`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "stop_climate",
  "Stops the climate system — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/stop_climate`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_temperatures",
  "Sets the cabin temperature (15-28°C) — auto-wakes if asleep",
  {
    vin: VinSchema,
    temperature: z.number().min(15).max(28).describe("Temperature in Celsius (15-28)"),
    ...CommandOptionsSchema,
  },
  async ({ vin, temperature, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/set_temperatures`, { temperature, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_seat_heat",
  "Sets the heating level for a specific seat (0=off, 1=low, 2=medium, 3=high) — auto-wakes if asleep",
  {
    vin: VinSchema,
    seat: z.enum(["driver", "passenger", "rear_left", "rear_center", "rear_right"]).describe("Which seat"),
    level: z.number().min(0).max(3).describe("Heat level 0-3"),
    ...CommandOptionsSchema,
  },
  async ({ vin, seat, level, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/set_seat_heat`, { seat, level, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_seat_cool",
  "Sets the cooling level for a specific seat (0=off, 1=low, 2=medium, 3=high) — auto-wakes if asleep",
  {
    vin: VinSchema,
    seat: z.enum(["driver", "passenger", "rear_left", "rear_center", "rear_right"]).describe("Which seat"),
    level: z.number().min(0).max(3).describe("Cooling level 0-3"),
    ...CommandOptionsSchema,
  },
  async ({ vin, seat, level, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/set_seat_cool`, { seat, level, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "start_defrost",
  "Starts max defrost mode — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/start_max_defrost`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "stop_defrost",
  "Stops max defrost mode — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/stop_max_defrost`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "start_steering_wheel_heater",
  "Turns on the steering wheel heater — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/start_steering_wheel_heater`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "stop_steering_wheel_heater",
  "Turns off the steering wheel heater — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/stop_steering_wheel_heater`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_cabin_overheat_protection",
  "Enables or disables Cabin Overheat Protection — auto-wakes if asleep",
  {
    vin: VinSchema,
    on: z.boolean().describe("Enable or disable"),
    fan_only: z.boolean().optional().describe("Fan only mode (no A/C)"),
    ...CommandOptionsSchema,
  },
  async ({ vin, on, fan_only, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/set_cabin_overheat_protection`, { on, fan_only, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_climate_keeper_mode",
  "Sets Climate Keeper mode: 0=Off, 1=Keep, 2=Dog, 3=Camp — auto-wakes if asleep",
  {
    vin: VinSchema,
    mode: z.number().min(0).max(3).describe("0=Off, 1=Keep, 2=Dog, 3=Camp"),
    ...CommandOptionsSchema,
  },
  async ({ vin, mode, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/set_climate_keeper_mode`, { mode, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_bioweapon_mode",
  "Enables or disables Bioweapon Defense Mode — auto-wakes if asleep",
  {
    vin: VinSchema,
    on: z.boolean().describe("Enable or disable"),
    ...CommandOptionsSchema,
  },
  async ({ vin, on, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/set_bioweapon_mode`, { on, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== CHARGING =====================

server.tool(
  "start_charging",
  "Starts charging the vehicle — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/start_charging`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "stop_charging",
  "Stops charging the vehicle — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/stop_charging`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_charge_limit",
  "Sets the charge limit percentage — auto-wakes if asleep",
  {
    vin: VinSchema,
    percent: z.number().min(50).max(100).describe("Charge limit percentage (50-100)"),
    ...CommandOptionsSchema,
  },
  async ({ vin, percent, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/set_charge_limit`, { percent, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "set_charging_amps",
  "Sets the charging amperage — auto-wakes if asleep",
  {
    vin: VinSchema,
    amps: z.number().min(1).describe("Charging amps"),
    ...CommandOptionsSchema,
  },
  async ({ vin, amps, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/set_charging_amps`, { amps, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "open_charge_port",
  "Opens the charge port door — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/open_charge_port`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "close_charge_port",
  "Closes the charge port door — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/close_charge_port`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== LIGHTS & HORN =====================

server.tool(
  "flash_lights",
  "Flashes the vehicle's lights — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/flash`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "honk",
  "Honks the vehicle's horn — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/honk`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== HOMELINK =====================

server.tool(
  "trigger_homelink",
  "Triggers the HomeLink garage door opener — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/trigger_homelink`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== KEYLESS DRIVING =====================

server.tool(
  "remote_start",
  "Enables keyless driving. Driving must begin within 2 minutes. Auto-wakes if asleep.",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/remote_start`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== SENTRY & VALET =====================

server.tool(
  "enable_sentry_mode",
  "Enables Sentry Mode — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/enable_sentry`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "disable_sentry_mode",
  "Disables Sentry Mode — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/disable_sentry`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "enable_valet_mode",
  "Enables Valet Mode — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/enable_valet`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "disable_valet_mode",
  "Disables Valet Mode — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/disable_valet`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "enable_guest_mode",
  "Enables Guest Mode — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/enable_guest`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "disable_guest_mode",
  "Disables Guest Mode — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/disable_guest`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== SPEED LIMIT =====================

server.tool(
  "enable_speed_limit",
  "Enables Speed Limit Mode — auto-wakes if asleep",
  {
    vin: VinSchema,
    limit_mph: z.number().optional().describe("Speed limit in mph"),
    ...CommandOptionsSchema,
  },
  async ({ vin, limit_mph, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/enable_speed_limit`, { limit_mph, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "disable_speed_limit",
  "Disables Speed Limit Mode — auto-wakes if asleep",
  {
    vin: VinSchema,
    pin: z.string().optional().describe("Speed limit PIN"),
    ...CommandOptionsSchema,
  },
  async ({ vin, pin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/disable_speed_limit`, { pin, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== SOFTWARE UPDATES =====================

server.tool(
  "schedule_software_update",
  "Schedules a software update to install after a delay (in seconds) — auto-wakes if asleep",
  {
    vin: VinSchema,
    offset_sec: z.number().describe("Seconds from now to begin the update"),
    ...CommandOptionsSchema,
  },
  async ({ vin, offset_sec, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/schedule_software_update`, { offset_sec, wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "cancel_software_update",
  "Cancels a scheduled software update — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/cancel_software_update`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ===================== FUN =====================

server.tool(
  "boombox",
  "Plays a fart sound from the external speaker (requires firmware 2022.40.25+) — auto-wakes if asleep",
  { vin: VinSchema, ...CommandOptionsSchema },
  async ({ vin, wait_for_completion, max_attempts }) => {
    const data = await command(vin, `/${vin}/command/boombox`, { wait_for_completion, max_attempts });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Tessie MCP server v1.1.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
