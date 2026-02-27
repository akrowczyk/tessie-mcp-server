# Tessie MCP Server

> Control and monitor your Tesla from any MCP-compatible AI assistant — including Claude, Cursor, and more.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)

An **MCP (Model Context Protocol) server** that bridges AI assistants to the [Tessie API](https://developer.tessie.com), giving you natural-language control of your Tesla vehicle. Ask Claude to check your battery, preheat the cabin, lock the car, or pull charging history — all in plain English.

---

## ✨ Features

- 🔋 **Battery & Range** — level, estimated range, voltage, temperature, health/degradation
- 📍 **Location** — GPS coordinates and street address
- 🌡️ **Climate Control** — start/stop, set temperature, seat heat/cool, defrost, Keep/Dog/Camp mode, Bioweapon Defense
- 🔒 **Security** — lock/unlock, Sentry Mode, Valet Mode, Guest Mode, Speed Limit Mode
- ⚡ **Charging** — start/stop, set charge limit %, set amps, charge port control
- 🚗 **Drive Data** — history with distance, energy & speed; GPS path per trip; drive tags
- 📊 **Charge History** — sessions with cost tracking
- 🛻 **Trunks & Covers** — frunk, rear trunk, Cybertruck tonneau
- 🪟 **Windows & Sunroof** — vent or close
- 💡 **Lights & Horn** — flash lights, honk
- 🏠 **HomeLink** — trigger garage door opener
- 🔑 **Remote Start** — keyless driving (2-minute window)
- 📱 **Software Updates** — schedule or cancel
- 😴 **Auto-Wake** — commands automatically wake a sleeping vehicle before executing
- 💨 **Fun** — Boombox fart sounds 🐄

---

## ⚡ Quick Start

### 1. Get a Tessie Account & API Token

Tessie is the service that provides secure API access to your Tesla.

👉 **Sign up for Tessie:** [share.tessie.com/v4Gklbe1U0b](https://share.tessie.com/v4Gklbe1U0b)

Once signed in, get your API token at: [dash.tessie.com/settings/api](https://dash.tessie.com/settings/api)

### 2. Install & Build

```bash
git clone https://github.com/akrowczyk/tessie-mcp-server.git
cd tessie-mcp-server
npm install
npm run build
```

---

## 🔧 Configuration

### Environment Variables

Authentication and preferences are configured entirely via environment variables — no secrets ever touch source code.

| Variable | Required | Description |
|---|---|---|
| `TESSIE_API_TOKEN` | ✅ Yes | Your Tessie API token |
| `TESSIE_DEFAULT_VIN` | Optional | Default VIN when not specified per-call |
| `TESSIE_DISTANCE_FORMAT` | Optional | `mi` or `km` — applies to all distance tools |
| `TESSIE_TEMP_FORMAT` | Optional | `f` or `c` — applies to all temperature tools |
| `TESSIE_PRESSURE_FORMAT` | Optional | `psi`, `bar`, or `kpa` — applies to tire pressure |

Per-call parameters always override the env var defaults.

---

### Claude Desktop

Add this block to your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tessie": {
      "command": "node",
      "args": ["/absolute/path/to/tessie-mcp-server/dist/index.js"],
      "env": {
        "TESSIE_API_TOKEN": "your-tessie-api-token",
        "TESSIE_DEFAULT_VIN": "your-17-digit-vin",
        "TESSIE_DISTANCE_FORMAT": "mi",
        "TESSIE_TEMP_FORMAT": "f",
        "TESSIE_PRESSURE_FORMAT": "psi"
      }
    }
  }
}
```

> **Note:** Replace `/absolute/path/to/tessie-mcp-server` with the actual path where you cloned this repo.

After saving, **restart Claude Desktop**.

---

### Claude Code (CLI)

```bash
claude mcp add tessie -- node /absolute/path/to/tessie-mcp-server/dist/index.js

export TESSIE_API_TOKEN="your-tessie-api-token"
export TESSIE_DEFAULT_VIN="your-17-digit-vin"
export TESSIE_DISTANCE_FORMAT="mi"
export TESSIE_TEMP_FORMAT="f"
export TESSIE_PRESSURE_FORMAT="psi"
```

---

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "tessie": {
      "command": "node",
      "args": ["/absolute/path/to/tessie-mcp-server/dist/index.js"],
      "env": {
        "TESSIE_API_TOKEN": "your-tessie-api-token",
        "TESSIE_DEFAULT_VIN": "your-17-digit-vin",
        "TESSIE_DISTANCE_FORMAT": "mi",
        "TESSIE_TEMP_FORMAT": "f",
        "TESSIE_PRESSURE_FORMAT": "psi"
      }
    }
  }
}
```

---

### Windsurf

Open **Settings → MCP Servers → Add**:

```json
{
  "tessie": {
    "command": "node",
    "args": ["/absolute/path/to/tessie-mcp-server/dist/index.js"],
    "env": {
      "TESSIE_API_TOKEN": "your-tessie-api-token",
      "TESSIE_DEFAULT_VIN": "your-17-digit-vin",
      "TESSIE_DISTANCE_FORMAT": "mi",
      "TESSIE_TEMP_FORMAT": "f",
      "TESSIE_PRESSURE_FORMAT": "psi"
    }
  }
}
```

---

### Continue.dev

In `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/tessie-mcp-server/dist/index.js"],
          "env": {
            "TESSIE_API_TOKEN": "your-tessie-api-token",
            "TESSIE_DEFAULT_VIN": "your-17-digit-vin",
            "TESSIE_DISTANCE_FORMAT": "mi",
            "TESSIE_TEMP_FORMAT": "f",
            "TESSIE_PRESSURE_FORMAT": "psi"
          }
        }
      }
    ]
  }
}
```

---

## 😴 Auto-Wake

All vehicle commands automatically wake a sleeping vehicle before executing — no need to call `wake_vehicle` manually first.

- If the vehicle is **already awake**, commands execute instantly with zero added latency
- If the vehicle is **asleep**, the server sends a wake command and polls every 3 seconds until the vehicle is awake (up to 90 seconds), then sends your command
- Read-only data tools (`get_battery`, `get_location`, etc.) use cached data by default and do **not** wake the vehicle

---

## 📡 MCP Resources

In addition to tools, this server exposes vehicle data as **MCP Resources** — structured data that AI clients can read as contextual documents:

| URI | Description |
|---|---|
| `tessie://vehicles` | Fleet overview — all vehicles on the account |
| `tessie://{vin}/state` | Full live vehicle state (charge, climate, drive, config) |
| `tessie://{vin}/status` | Current awake/asleep status |

Resources are accessible in Claude Desktop and other MCP clients that support the resources protocol.

---

## 🛠️ Available Tools

### Vehicle Data
| Tool | Description |
|------|-------------|
| `get_vehicles` | List all vehicles on the account |
| `get_vehicle_state` | Full state — drive, charge, climate, config |
| `get_vehicle_status` | Check if vehicle is awake/asleep |
| `get_full_status` | **Combined** battery + location + state in one call |
| `get_battery` | Battery level, range, voltage, temperature |
| `get_battery_health` | Battery degradation over time |
| `get_location` | GPS coordinates and street address |
| `get_weather` | Weather at the vehicle's current location |
| `get_tire_pressure` | All four tire pressures |
| `get_consumption_since_charge` | Energy usage since last charge |
| `get_firmware_alerts` | Vehicle firmware alerts |

### Drives & Charges
| Tool | Description |
|------|-------------|
| `get_drives` | Drive history with distance, energy, speed |
| `get_drive_path` | GPS path for drives |
| `set_drive_tag` | Tag drives as business/personal |
| `get_charges` | Charging session history |
| `set_charge_cost` | Set cost for a charge session |
| `get_idles` | Idle periods (parked, not charging) |

### Commands *(all auto-wake)*
| Tool | Description |
|------|-------------|
| `wake_vehicle` | Explicitly wake from sleep |
| `lock` / `unlock` | Door locks |
| `open_front_trunk` / `open_rear_trunk` | Trunk controls |
| `vent_windows` / `close_windows` | Window controls |
| `vent_sunroof` / `close_sunroof` | Sunroof controls |
| `open_tonneau` / `close_tonneau` | Cybertruck tonneau cover |
| `flash_lights` / `honk` | Lights and horn |
| `trigger_homelink` | Garage door opener |
| `remote_start` | Keyless driving (2-min window) |
| `boombox` | External speaker fart sound 🐄 |

### Climate *(all auto-wake)*
| Tool | Description |
|------|-------------|
| `start_climate` / `stop_climate` | Climate system |
| `set_temperatures` | Set cabin temp (15–28°C) |
| `set_seat_heat` / `set_seat_cool` | Seat heating/cooling (0–3) |
| `start_defrost` / `stop_defrost` | Max defrost mode |
| `start_steering_wheel_heater` / `stop_steering_wheel_heater` | Steering wheel heater |
| `set_cabin_overheat_protection` | Cabin Overheat Protection |
| `set_climate_keeper_mode` | Keep / Dog / Camp mode |
| `set_bioweapon_mode` | Bioweapon Defense Mode |

### Charging *(all auto-wake)*
| Tool | Description |
|------|-------------|
| `start_charging` / `stop_charging` | Start/stop charging |
| `set_charge_limit` | Set charge limit (50–100%) |
| `set_charging_amps` | Set charging amperage |
| `open_charge_port` / `close_charge_port` | Charge port door |

### Modes *(all auto-wake)*
| Tool | Description |
|------|-------------|
| `enable_sentry_mode` / `disable_sentry_mode` | Sentry Mode |
| `enable_valet_mode` / `disable_valet_mode` | Valet Mode |
| `enable_guest_mode` / `disable_guest_mode` | Guest Mode |
| `enable_speed_limit` / `disable_speed_limit` | Speed Limit Mode |

### Software *(all auto-wake)*
| Tool | Description |
|------|-------------|
| `schedule_software_update` | Schedule a software update |
| `cancel_software_update` | Cancel a scheduled update |

---

## 💬 Example Prompts

Once configured, try asking your AI assistant:

- *"How is my Tesla doing right now?"* → uses `get_full_status`
- *"What's my battery level and estimated range?"*
- *"Where is my car parked right now?"*
- *"Start the climate and set it to 72°F"* (auto-wakes if needed)
- *"Lock the car and turn on Sentry Mode"* (auto-wakes if needed)
- *"Show me my drives from this week"*
- *"Open the frunk"*
- *"What's the tire pressure on all four tires?"*
- *"Set my charge limit to 80%"*
- *"Tag all my drives this month as business"*

---

## 🔒 Security Notes

- Your **Tessie API token** is passed as an environment variable — **never** stored in code or config files
- The `.gitignore` in this repo explicitly excludes `.env` files
- If your token has been exposed, rotate it immediately at [dash.tessie.com/settings/api](https://dash.tessie.com/settings/api)
- All vehicle commands are authenticated with your personal token — only you can control your vehicle

---

## 🛠️ Development

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript
npm run dev        # Watch mode (auto-rebuild on changes)
npm start          # Run the compiled server
```

**Requirements:** Node.js 18+

---

## 🔗 Referrals & Links

If this project is useful to you, consider using these referral links:

- **Tessie** — The vehicle API that powers this server. Sign up here: [share.tessie.com/v4Gklbe1U0b](https://share.tessie.com/v4Gklbe1U0b)
- **Buying a Tesla?** Use my referral code for exclusive deals and rewards: [ts.la/andrew80231](https://ts.la/andrew80231)

---

## 📄 License

[MIT](LICENSE) © 2026 Andrew Krowczyk
