# ToolTrack — UHF RFID Tool Entry Logging

ToolTrack is a web-based tool-entry logging system for rental shops using a
UM202 UHF RFID reader over USB serial. It continuously reads binary inventory
reports, tracks each EPC independently, and creates one durable entry whenever
a registered tag transitions from out of range to active.

## Features

- UM202 reader connection through the browser Web Serial API
- Serial configuration: `115200 8N1`
- Buffered binary parsing for fragmented and coalesced serial reads
- Independent multi-tag session tracking with duplicate suppression
- Configurable per-tag out-of-range timeout (default: 3 seconds)
- Persistent tool registry and entry history using Cloudflare D1
- Live tag count, read count, RSSI, frequency, stability, and last-seen age
- Individual entry deletion and date-based bulk deletion
- Per-tool history with the latest five entries and a “View all” option
- Tool deletion while retaining historical EPC audit records
- India Standard Time display for UTC database timestamps
- Responsive dashboard for desktop and mobile screens

## Requirements

- Node.js 22.13 or newer
- A Chromium-based desktop browser with Web Serial support, such as Google
  Chrome or Microsoft Edge
- UM202 UHF RFID reader connected by USB serial, commonly through an FT232R
  USB UART adapter

Web Serial requires a secure context. It works on `localhost` during
development and over HTTPS in production. Safari and Firefox do not currently
support the required Web Serial API.

## Getting started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open the local URL printed by the server. In the application:

1. Open **Diagnostics**.
2. Select **Choose port** and authorize the UM202/FT232R serial device.
3. Select the authorized port.
4. Click **Connect reader**.
5. Confirm the reader status shows `Connected · 115200`.

The browser remembers authorized ports, allowing the reader to reconnect
without restarting the application.

## RFID packet format

The parser supports the observed UM202 inventory-report format:

```text
A5 5A | total length | 83 30 | antenna | EPC | signal | CRC | 0D 0A
```

Observed single-tag frame:

```text
A5 5A 00 19 83 30 00
E2 00 00 1B 66 04 00 82 17 20 34 D5
00 D4 01 B0 0D 0A
```

| Bytes | Meaning |
| --- | --- |
| `A5 5A` | Frame header |
| `00 19` | Total frame length: 25 bytes |
| `83 30` | Inventory-report command |
| `00` | Antenna/channel |
| Next 12 bytes | EPC (`E200001B66040082172034D5` in the example) |
| Signal metadata | Includes signed 8-bit RSSI (`D4` = -44 dBm) |
| Next 2 bytes | Reader checksum/CRC |
| `0D 0A` | Frame terminator |

The parser keeps an internal receive buffer, so a serial read may contain a
partial packet, one complete packet, or several packets. The earlier
`BB ... 7E` reader envelope remains available as a compatibility profile.

Checksum bytes are retained in diagnostics but are not rejected until the
UM202 vendor checksum polynomial is confirmed.

## Multi-tag session behavior

Every EPC has its own session state:

```text
EPC → firstSeen, lastSeen, isActive, readCount, lastRSSI
```

For every decoded tag report:

- An inactive or unseen EPC becomes active and creates one database entry if
  it belongs to a registered tool.
- A currently active EPC only updates `lastSeen`, `readCount`, and RSSI.
- An EPC becomes inactive when it has not been seen for more than 3 seconds.
- Detecting that EPC after timeout creates a new entry session.
- The state of one EPC never changes another EPC’s session.

Repeated reports such as the following create only three entries:

```text
TAG_A TAG_B TAG_C TAG_A TAG_B TAG_A TAG_C
```

## Application pages

### Dashboard

Shows registered tools, today’s entries, tags currently in range, reader
status, recent entries, and the live RFID field.

### Tools

Registers and searches tools by name, category, serial number, or EPC. Select a
tool name to see its latest five recorded entry times. Use **View all** to show
its complete history.

Deleting a tool removes its registration but keeps existing entry records
identified by EPC.

### Entries

Shows the complete entry timeline. Entries can be deleted individually or
filtered by an India-time calendar date and deleted together after
confirmation. Date-based deletion does not remove registered tools.

### Diagnostics

Provides reader connection controls, the per-EPC live tag monitor, decoded
frames, raw bytes, RSSI, read frequency, stability, and last-seen age.

## Database

ToolTrack uses Cloudflare D1 with two tables:

- `tools`: tool name, category, serial number, EPC, status, and creation time
- `entries`: tool reference, EPC, entry time, read count, and event source

The logical binding is configured as `DB` in `.openai/hosting.json`. Runtime
table initialization is handled by the store API, while the generated schema
migration is stored under `drizzle/`.

D1 stores timestamps in UTC. The application normalizes SQLite timestamps and
displays them in `Asia/Kolkata` time.

Generate a new migration after changing `db/schema.ts`:

```bash
npm run db:generate
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create a production build |
| `npm test` | Run RFID tests and the production build |
| `npm run lint` | Run ESLint |
| `npm run db:generate` | Generate a D1/Drizzle migration |

## Tests

The automated suite covers:

- A 100-cycle multi-tag burst creating exactly one activation per EPC
- Independent mixed-tag dropout and reactivation
- Fragmented and coalesced binary frames
- The captured `A5 5A / 83 30` UM202 report format
- Repeated UM202 reports remaining one active session
- UTC SQLite timestamps displayed in India Standard Time
- India-time calendar dates converted to correct UTC deletion boundaries

Run the complete verification:

```bash
npm test
```

## Project structure

```text
app/
  api/store/route.ts     D1 API and record mutations
  lib/datetime.ts        UTC/IST timestamp handling
  lib/rfid.ts            Binary parser and per-EPC state machine
  rfid-console.tsx       Dashboard and reader integration
db/
  schema.ts              Drizzle database schema
drizzle/                 Generated SQL migrations
tests/
  rfid-state.test.ts     Parser, session, and time-boundary tests
worker/
  index.ts               Cloudflare Worker entry point
```

## Operational notes

- RFID presence sessions are held in browser memory and restart after a page
  reload; saved tools and entry history remain in D1.
- The reader must be physically connected to the computer running the browser.
- If the serial cable is disconnected, reconnect from Diagnostics without
  restarting the application.
- A registered EPC must be unique. Continuous reads do not create duplicate
  entries while that EPC remains active.
