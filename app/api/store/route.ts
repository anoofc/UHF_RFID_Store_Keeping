import { env } from "cloudflare:workers";

export const runtime = "edge";

type ToolInput = { name: string; category: string; serialNumber: string; epc: string };

async function ready() {
  if (!env.DB) throw new Error("D1 database binding is unavailable");
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      serial_number TEXT NOT NULL,
      epc TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'Available',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER,
      epc TEXT NOT NULL,
      entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_count INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'RFID',
      FOREIGN KEY (tool_id) REFERENCES tools(id)
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS entries_epc_time_idx ON entries (epc, entered_at)"),
  ]);
  return env.DB;
}

export async function GET() {
  try {
    const db = await ready();
    const [toolRows, entryRows] = await Promise.all([
      db.prepare("SELECT id, name, category, serial_number AS serialNumber, epc, status, strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS createdAt FROM tools ORDER BY created_at DESC").all(),
      db.prepare(`SELECT e.id, e.tool_id AS toolId, e.epc, strftime('%Y-%m-%dT%H:%M:%SZ', e.entered_at) AS enteredAt,
        e.read_count AS readCount, e.source, t.name AS toolName, t.category
        FROM entries e LEFT JOIN tools t ON t.id = e.tool_id ORDER BY e.entered_at DESC`).all(),
    ]);
    return Response.json({ tools: toolRows.results, entries: entryRows.results });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Database error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = await ready();
    const body = (await request.json()) as { action?: string; tool?: ToolInput; epc?: string; source?: string; entryId?: number; toolId?: number };
    if (body.action === "addTool" && body.tool) {
      const tool = body.tool;
      if (!tool.name.trim() || !tool.category.trim() || !tool.serialNumber.trim() || !tool.epc.trim()) {
        return Response.json({ error: "All tool fields are required" }, { status: 400 });
      }
      await db.prepare("INSERT INTO tools (name, category, serial_number, epc) VALUES (?, ?, ?, ?)")
        .bind(tool.name.trim(), tool.category.trim(), tool.serialNumber.trim(), tool.epc.replace(/[^0-9a-f]/gi, "").toUpperCase()).run();
    } else if (body.action === "logEntry" && body.epc) {
      const epc = body.epc.replace(/[^0-9a-f]/gi, "").toUpperCase();
      const tool = await db.prepare("SELECT id FROM tools WHERE epc = ? LIMIT 1").bind(epc).first<{ id: number }>();
      // Preserve the mutation response contract even if registration changed
      // between the client's lookup and this database operation.
      if (!tool) return GET();
      await db.prepare("INSERT INTO entries (tool_id, epc, source) VALUES (?, ?, ?)")
        .bind(tool.id, epc, body.source ?? "RFID").run();
    } else if (body.action === "deleteEntry" && Number.isInteger(body.entryId)) {
      await db.prepare("DELETE FROM entries WHERE id = ?").bind(body.entryId).run();
    } else if (body.action === "deleteTool" && Number.isInteger(body.toolId)) {
      // Keep the audit trail, but detach it before removing the registration.
      // Historical rows remain identifiable by their captured EPC.
      await db.batch([
        db.prepare("UPDATE entries SET tool_id = NULL WHERE tool_id = ?").bind(body.toolId),
        db.prepare("DELETE FROM tools WHERE id = ?").bind(body.toolId),
      ]);
    } else if (body.action === "seed") {
      const count = await db.prepare("SELECT COUNT(*) AS count FROM tools").first<{ count: number }>();
      if (!count?.count) {
        await db.batch([
          db.prepare("INSERT INTO tools (name, category, serial_number, epc) VALUES (?, ?, ?, ?)").bind("Makita Impact Driver", "Power tools", "MK-18V-0442", "E20034120123456789ABC001"),
          db.prepare("INSERT INTO tools (name, category, serial_number, epc) VALUES (?, ?, ?, ?)").bind("Bosch Rotary Hammer", "Power tools", "BH-26-1088", "E20034120123456789ABC002"),
          db.prepare("INSERT INTO tools (name, category, serial_number, epc) VALUES (?, ?, ?, ?)").bind("Stanley Torque Wrench", "Hand tools", "ST-TW-2021", "E20034120123456789ABC003"),
          db.prepare("INSERT INTO tools (name, category, serial_number, epc) VALUES (?, ?, ?, ?)").bind("Fluke Multimeter", "Test equipment", "FL-117-890", "E20034120123456789ABC004"),
        ]);
      }
    } else {
      return Response.json({ error: "Unsupported action" }, { status: 400 });
    }
    return GET();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database error";
    const status = message.includes("UNIQUE") ? 409 : 500;
    return Response.json({ error: status === 409 ? "That EPC is already registered" : message }, { status });
  }
}
