import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tools = sqliteTable("tools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  category: text("category").notNull(),
  serialNumber: text("serial_number").notNull(),
  epc: text("epc").notNull().unique(),
  status: text("status").notNull().default("Available"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  toolId: integer("tool_id").references(() => tools.id),
  epc: text("epc").notNull(),
  enteredAt: text("entered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  readCount: integer("read_count").notNull().default(1),
  source: text("source").notNull().default("RFID"),
});
