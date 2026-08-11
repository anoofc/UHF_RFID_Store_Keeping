"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseSimulationInput,
  ParsedFrame,
  TagRead,
  TagSession,
  TagSessionManager,
  Um202Parser,
} from "./lib/rfid";
import { formatDateTime, formatLocalDate, formatTime, indiaDateUtcRange, localDateKey, parseStoredTimestamp } from "./lib/datetime";

type Page = "dashboard" | "tools" | "entries" | "diagnostics";
type ToolRecord = {
  id: number;
  name: string;
  category: string;
  serialNumber: string;
  epc: string;
  status: string;
  createdAt: string;
};
type EntryRecord = {
  id: number;
  toolId: number;
  epc: string;
  enteredAt: string;
  readCount: number;
  source: string;
  toolName?: string;
  category?: string;
};
type StoreData = { tools: ToolRecord[]; entries: EntryRecord[] };
type DeleteTarget =
  | { type: "tool" | "entry"; id: number; label: string }
  | { type: "date"; dateKey: string; count: number; label: string };
type SerialPortLike = {
  readable?: ReadableStream<Uint8Array> | null;
  open(options: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
};
type SerialNavigator = Navigator & {
  serial?: {
    getPorts(): Promise<SerialPortLike[]>;
    requestPort(): Promise<SerialPortLike>;
  };
};

const seedTools: ToolRecord[] = [
  { id: 1, name: "Makita Impact Driver", category: "Power tools", serialNumber: "MK-18V-0442", epc: "E20034120123456789ABC001", status: "Available", createdAt: "2026-08-08T09:22:00Z" },
  { id: 2, name: "Bosch Rotary Hammer", category: "Power tools", serialNumber: "BH-26-1088", epc: "E20034120123456789ABC002", status: "Available", createdAt: "2026-08-07T13:14:00Z" },
  { id: 3, name: "Stanley Torque Wrench", category: "Hand tools", serialNumber: "ST-TW-2021", epc: "E20034120123456789ABC003", status: "Available", createdAt: "2026-08-06T11:40:00Z" },
  { id: 4, name: "Fluke Multimeter", category: "Test equipment", serialNumber: "FL-117-890", epc: "E20034120123456789ABC004", status: "Available", createdAt: "2026-08-03T16:05:00Z" },
];

const demoEntries: EntryRecord[] = [
  { id: 8, toolId: 1, epc: seedTools[0].epc, enteredAt: "2026-08-10T16:49:00.000Z", readCount: 1, source: "RFID", toolName: seedTools[0].name, category: seedTools[0].category },
  { id: 7, toolId: 2, epc: seedTools[1].epc, enteredAt: "2026-08-10T16:22:00.000Z", readCount: 1, source: "RFID", toolName: seedTools[1].name, category: seedTools[1].category },
  { id: 6, toolId: 3, epc: seedTools[2].epc, enteredAt: "2026-08-10T15:39:00.000Z", readCount: 1, source: "Simulator", toolName: seedTools[2].name, category: seedTools[2].category },
];
const DEFAULT_SIMULATION_FRAME = seedTools.slice(0, 3).map((tool) => tool.epc).join(" ");

function isStoreData(value: unknown): value is StoreData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoreData>;
  return Array.isArray(candidate.tools) && Array.isArray(candidate.entries);
}

async function readStoreData(response: Response): Promise<StoreData> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : "The database request failed";
    throw new Error(message);
  }
  if (!isStoreData(data)) throw new Error("The database returned an incomplete store response");
  return data;
}

function shortEpc(epc: string) {
  return epc.length > 15 ? `${epc.slice(0, 7)}…${epc.slice(-6)}` : epc;
}

function Icon({ name }: { name: string }) {
  const icons: Record<string, string> = { dashboard: "⌂", tools: "⌁", entries: "↳", diagnostics: "⌁", search: "⌕", add: "+", radio: "◉", chevron: "›", close: "×", menu: "☰" };
  return <span aria-hidden="true">{icons[name] ?? "•"}</span>;
}

export function RFIDConsole() {
  const [page, setPage] = useState<Page>("dashboard");
  const [store, setStore] = useState<StoreData>({ tools: seedTools, entries: demoEntries });
  const [sessions, setSessions] = useState<TagSession[]>([]);
  const [frames, setFrames] = useState<ParsedFrame[]>([]);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected" | "simulator">("disconnected");
  const [ports, setPorts] = useState<SerialPortLike[]>([]);
  const [selectedPort, setSelectedPort] = useState(0);
  const [search, setSearch] = useState("");
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [selectedTool, setSelectedTool] = useState<ToolRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Keep rendering safe during hot reload if an older client briefly retained
  // the pre-fix partial response in component state.
  const safeTools = Array.isArray(store.tools) ? store.tools : [];
  const safeEntries = Array.isArray(store.entries) ? store.entries : [];
  const manager = useRef(new TagSessionManager(3000));
  const parser = useRef(new Um202Parser());
  const activePort = useRef<SerialPortLike | null>(null);
  const stopReading = useRef(false);
  const frameNumber = useRef(0);

  const refreshStore = useCallback(async () => {
    try {
      const response = await fetch("/api/store");
      const data = await readStoreData(response);
      setStore(data);
      if (!data.tools.length) {
        const seeded = await fetch("/api/store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "seed" }) });
        setStore(await readStoreData(seeded));
      }
    } catch {
      // The UI remains fully demonstrable with its local sample records.
    }
  }, []);

  useEffect(() => { void refreshStore(); }, [refreshStore]);

  useEffect(() => {
    const serial = (navigator as SerialNavigator).serial;
    if (serial) void serial.getPorts().then(setPorts).catch(() => undefined);
    const timer = window.setInterval(() => {
      const current = Date.now();
      manager.current.expire(current);
      setSessions(manager.current.snapshot());
      setNow(current);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  };

  const logActivation = useCallback(async (session: TagSession, source: string) => {
    const tool = safeTools.find((item) => item.epc === session.epc);
    if (!tool) return;
    const optimistic: EntryRecord = { id: Date.now(), toolId: tool.id, epc: tool.epc, enteredAt: new Date(session.firstSeen).toISOString(), readCount: 1, source, toolName: tool.name, category: tool.category };
    setStore((current) => ({ ...current, entries: [optimistic, ...current.entries] }));
    try {
      const response = await fetch("/api/store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "logEntry", epc: session.epc, source }) });
      setStore(await readStoreData(response));
    } catch { /* optimistic event remains visible */ }
  }, [safeTools]);

  const processTags = useCallback((tags: TagRead[], source: string, rawHex = "SIMULATED MULTI-TAG FRAME") => {
    const receivedAt = Date.now();
    const update = manager.current.processFrame(tags, receivedAt);
    setSessions(update.sessions);
    const frame: ParsedFrame = { sequence: ++frameNumber.current, receivedAt, rawHex, tags };
    setFrames((current) => [frame, ...current].slice(0, 30));
    for (const activation of update.activations) void logActivation(activation, source);
    return update.activations.length;
  }, [logActivation]);

  const readPort = useCallback(async (port: SerialPortLike) => {
    if (!port.readable) return;
    const reader = port.readable.getReader();
    try {
      while (!stopReading.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const frame of parser.current.push(value)) processTags(frame.tags, "RFID", frame.rawHex);
      }
    } catch {
      if (!stopReading.current) notify("Reader disconnected. You can reconnect without reloading.");
    } finally {
      reader.releaseLock();
      setStatus("disconnected");
    }
  }, [processTags]);

  async function chooseReader() {
    const serial = (navigator as SerialNavigator).serial;
    if (!serial) return notify("Web Serial is unavailable. Use Chrome or Edge, or open Simulator mode.");
    try {
      const port = await serial.requestPort();
      setPorts((current) => current.includes(port) ? current : [...current, port]);
      setSelectedPort(ports.length);
      notify("Reader permission granted. Press Connect reader.");
    } catch { /* user closed the chooser */ }
  }

  async function connectReader() {
    const port = ports[selectedPort];
    if (!port) return void chooseReader();
    setStatus("connecting");
    stopReading.current = false;
    try {
      await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 8192 });
      activePort.current = port;
      setStatus("connected");
      notify("UM202 reader connected at 115200 8N1");
      void readPort(port);
    } catch {
      setStatus("disconnected");
      notify("Could not open that serial port. Check the cable and try again.");
    }
  }

  async function disconnectReader() {
    stopReading.current = true;
    try { await activePort.current?.close(); } catch { /* already disconnected */ }
    activePort.current = null;
    setStatus("disconnected");
  }

  function simulate(burst = false) {
    const tags = parseSimulationInput(DEFAULT_SIMULATION_FRAME);
    if (!tags.length) return notify("Enter at least one hexadecimal EPC.");
    setStatus("simulator");
    const repeat = burst ? 100 : 1;
    let newEntries = 0;
    for (let index = 0; index < repeat; index += 1) newEntries += processTags(tags, "Simulator");
    notify(`${tags.length} tags processed${burst ? " × 100 bursts" : ""}; ${newEntries} new session${newEntries === 1 ? "" : "s"}.`);
  }

  const activeSessions = sessions.filter((session) => session.isActive);
  const registeredActive = activeSessions.filter((session) => safeTools.some((tool) => tool.epc === session.epc));
  const todayKey = localDateKey(now);
  const todayEntries = safeEntries.filter((entry) => localDateKey(entry.enteredAt) === todayKey);
  const title: Record<Page, [string, string]> = {
    dashboard: ["Good morning", "Here’s what’s happening in your tool room."],
    tools: ["Tool registry", "Manage every RFID-linked asset in one place."],
    entries: ["Entry history", "A durable timeline of every tool arrival."],
    diagnostics: ["RFID diagnostics", "Inspect the live multi-tag field and reader health."],
  };

  const filteredTools = safeTools.filter((tool) => `${tool.name} ${tool.category} ${tool.serialNumber} ${tool.epc}`.toLowerCase().includes(search.toLowerCase()));
  const filteredEntries = safeEntries.filter((entry) => `${entry.toolName} ${entry.category} ${entry.epc}`.toLowerCase().includes(search.toLowerCase()));

  async function confirmDelete() {
    if (!deleteTarget) return;
    const previous: StoreData = { tools: safeTools, entries: safeEntries };
    const next = deleteTarget.type === "entry"
      ? { tools: safeTools, entries: safeEntries.filter((entry) => entry.id !== deleteTarget.id) }
      : deleteTarget.type === "date"
        ? { tools: safeTools, entries: safeEntries.filter((entry) => localDateKey(entry.enteredAt) !== deleteTarget.dateKey) }
      : {
          tools: safeTools.filter((tool) => tool.id !== deleteTarget.id),
          entries: safeEntries.map((entry) => entry.toolId === deleteTarget.id
            ? { ...entry, toolId: 0, toolName: undefined, category: undefined }
            : entry),
        };
    setDeleting(true);
    setStore(next);
    try {
      const response = await fetch("/api/store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(deleteTarget.type === "entry"
          ? { action: "deleteEntry", entryId: deleteTarget.id }
          : deleteTarget.type === "date"
            ? { action: "deleteEntriesByDate", ...indiaDateUtcRange(deleteTarget.dateKey) }
            : { action: "deleteTool", toolId: deleteTarget.id }),
      });
      const data = await readStoreData(response);
      setStore(data);
      notify(deleteTarget.type === "entry"
        ? "Entry deleted."
        : deleteTarget.type === "date"
          ? `All ${deleteTarget.count} entries for ${deleteTarget.label} were deleted.`
          : "Tool registration deleted. Historical entries were retained.");
      setDeleteTarget(null);
    } catch (error) {
      setStore(previous);
      notify(error instanceof Error ? error.message : "Could not delete that record.");
    } finally {
      setDeleting(false);
    }
  }

  function navigate(nextPage: Page) {
    setPage(nextPage);
    setSearch("");
    setMobileNav(false);
  }

  function updateSearch(value: string) {
    setSearch(value);
    if (value && (page === "dashboard" || page === "diagnostics")) setPage("tools");
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>Tool<span>Track</span></span></div>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Main navigation">
          {(["dashboard", "tools", "entries", "diagnostics"] as Page[]).map((item) => (
            <button key={item} className={page === item ? "active" : ""} onClick={() => navigate(item)}>
              <Icon name={item} /><span>{item[0].toUpperCase() + item.slice(1)}</span>{item === "entries" && <em>{todayEntries.length}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="reader-mini"><span className={`signal ${status}`}><i /><i /><i /></span><div><strong>UM202 Reader</strong><small>{status === "connected" ? "Connected · 115200" : status === "simulator" ? "Simulator active" : "Not connected"}</small></div></div>
          <button className="help-button">? <span>Help & support</span></button>
        </div>
      </aside>
      {mobileNav && <button className="nav-scrim" aria-label="Close menu" onClick={() => setMobileNav(false)} />}

      <main className="main">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Icon name="menu" /></button>
          <div><h1>{title[page][0]}{page === "dashboard" && <span>.</span>}</h1><p>{title[page][1]}</p></div>
          <div className="top-actions">
            <label className="search"><Icon name="search" /><input aria-label="Search tools and entries" placeholder={page === "entries" ? "Search entries, EPCs…" : "Search tools, EPCs…"} value={search} onChange={(event) => updateSearch(event.target.value)} />{search && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setSearch("")}>×</button>}</label>
            <button className="primary" onClick={() => setRegistrationOpen(true)}><Icon name="add" /> Add new tool</button>
            <div className="avatar" title="Store administrator">AM</div>
          </div>
        </header>

        <section className="content">
          {page === "dashboard" && <Dashboard tools={safeTools} entries={todayEntries} sessions={sessions} frames={frames} status={status} onNavigate={navigate} onSimulate={() => simulate(false)} onConnect={status === "connected" ? disconnectReader : connectReader} />}
          {page === "tools" && <ToolsPage tools={filteredTools} totalTools={safeTools.length} isFiltered={Boolean(search.trim())} entries={safeEntries} onAdd={() => setRegistrationOpen(true)} onSelect={setSelectedTool} onDelete={(tool) => setDeleteTarget({ type: "tool", id: tool.id, label: tool.name })} />}
          {page === "entries" && <EntriesPage entries={filteredEntries} allEntries={safeEntries} totalEntries={safeEntries.length} isFiltered={Boolean(search.trim())} onDelete={(entry) => setDeleteTarget({ type: "entry", id: entry.id, label: `${entry.toolName ?? "Unknown tool"} · ${formatDateTime(entry.enteredAt)}` })} onDeleteDate={(dateKey, count) => setDeleteTarget({ type: "date", dateKey, count, label: formatLocalDate(dateKey) })} />}
          {page === "diagnostics" && <Diagnostics sessions={sessions} frames={frames} now={now} status={status} ports={ports} selectedPort={selectedPort} setSelectedPort={setSelectedPort} chooseReader={chooseReader} connectReader={connectReader} disconnectReader={disconnectReader} />}
        </section>
      </main>

      {registrationOpen && <RegistrationModal sessions={sessions} tools={safeTools} onClose={() => setRegistrationOpen(false)} onSaved={(data) => { setStore(data); setRegistrationOpen(false); notify("Tool registered and ready for detection."); }} />}
      {selectedTool && <ToolHistoryDialog tool={selectedTool} entries={safeEntries} onClose={() => setSelectedTool(null)} />}
      {deleteTarget && <DeleteDialog target={deleteTarget} deleting={deleting} onCancel={() => setDeleteTarget(null)} onConfirm={confirmDelete} />}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </div>
  );
}

function Dashboard({ tools, entries, sessions, frames, status, onNavigate, onSimulate, onConnect }: { tools: ToolRecord[]; entries: EntryRecord[]; sessions: TagSession[]; frames: ParsedFrame[]; status: string; onNavigate: (page: Page) => void; onSimulate: () => void; onConnect: () => void }) {
  const active = sessions.filter((session) => session.isActive);
  const registered = active.filter((session) => tools.some((tool) => tool.epc === session.epc));
  const stats = [
    { label: "Tools registered", value: tools.length, note: `${Math.max(1, Math.round(tools.length / 4))} added this week`, icon: "⌁", tone: "teal" },
    { label: "Entries today", value: entries.length, note: entries.length ? "Live log is current" : "Awaiting first entry", icon: "↳", tone: "yellow" },
    { label: "Tags currently in range", value: active.length, note: `${registered.length} registered · ${active.length - registered.length} unknown`, icon: "◉", tone: "blue" },
    { label: "Reader status", value: status === "connected" ? "Online" : status === "simulator" ? "Sim" : "Offline", note: status === "connected" ? "115200 baud · 8N1" : "Ready to reconnect", icon: "⌁", tone: status === "connected" ? "green" : "slate" },
  ];
  return <>
    <div className="stat-grid">{stats.map((stat) => <article className="stat-card" key={stat.label}><div className={`stat-icon ${stat.tone}`}>{stat.icon}</div><div><p>{stat.label}</p><strong>{stat.value}</strong><small>{stat.note}</small></div></article>)}</div>
    <div className="dashboard-grid">
      <section className="panel activity-panel"><PanelHeading title="Recent entries" subtitle="Latest tool arrivals recorded by the reader" action="View all" onAction={() => onNavigate("entries")} />
        <div className="entry-list">{entries.slice(0, 5).map((entry) => <div className="entry-row" key={entry.id}><div className="tool-glyph">⌁</div><div className="entry-main"><strong>{entry.toolName ?? "Unregistered tag"}</strong><span>{entry.category ?? "Unknown tool"} · {shortEpc(entry.epc)}</span></div><div className="entry-time"><strong>{formatTime(entry.enteredAt)}</strong><span>Today</span></div><span className="entry-ok">✓</span></div>)}{!entries.length && <Empty text="No entries yet today. Bring a tagged tool into range." />}</div>
      </section>
      <section className="panel live-panel"><PanelHeading title="Live RFID field" subtitle="Independent EPC sessions" action="Diagnostics" onAction={() => onNavigate("diagnostics")} />
        <div className="field-visual"><div className="rings"><i/><i/><i/><span>⌁</span></div><div><strong>{active.length}</strong><span>tags in range</span></div></div>
        <div className="mini-tags">{active.slice(0, 4).map((session) => <div key={session.epc}><span className="live-dot"/><code>{shortEpc(session.epc)}</code><em>{session.readCount} reads</em></div>)}{!active.length && <p className="quiet">No live tags. Connect the reader or use the simulator.</p>}</div>
      </section>
    </div>
    <section className="panel quick-panel"><div><span className="eyebrow">Quick start</span><h2>Ready for your next scan</h2><p>Connect the UM202 over USB serial, or validate the multi-tag lifecycle with a simulated frame.</p></div><div className="quick-actions"><button className="secondary" onClick={onSimulate}>Run sample frame</button><button className="primary" onClick={onConnect}>{status === "connected" ? "Disconnect reader" : "Connect reader"}</button></div></section>
  </>;
}

function PanelHeading({ title, subtitle, action, onAction }: { title: string; subtitle: string; action?: string; onAction?: () => void }) {
  return <header className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div>{action && <button onClick={onAction}>{action} <Icon name="chevron" /></button>}</header>;
}

function ToolsPage({ tools, totalTools, isFiltered, entries, onAdd, onSelect, onDelete }: { tools: ToolRecord[]; totalTools: number; isFiltered: boolean; entries: EntryRecord[]; onAdd: () => void; onSelect: (tool: ToolRecord) => void; onDelete: (tool: ToolRecord) => void }) {
  const countLabel = isFiltered ? `${tools.length} of ${totalTools} registered tools` : `${totalTools} registered tools`;
  return <section className="panel table-panel"><PanelHeading title={countLabel} subtitle={isFiltered ? "Filtered results · clear search to show every registered tool" : "Select a tool to view its recorded entry history"} action="Register tool" onAction={onAdd} /><div className="table-scroll"><table><thead><tr><th>Tool</th><th>Category</th><th>Serial number</th><th>EPC</th><th>Entries</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{tools.map((tool) => <tr key={tool.id}><td><button className="tool-link" onClick={() => onSelect(tool)} aria-label={`View entry history for ${tool.name}`}><span>⌁</span><strong>{tool.name}</strong><Icon name="chevron" /></button></td><td>{tool.category}</td><td><code>{tool.serialNumber}</code></td><td><code>{tool.epc}</code></td><td>{entries.filter((entry) => entry.toolId === tool.id).length}</td><td><span className="status-pill available"><i/> {tool.status}</span></td><td className="action-cell"><button className="delete-button" onClick={() => onDelete(tool)} aria-label={`Delete ${tool.name}`}>Delete</button></td></tr>)}</tbody></table></div>{!tools.length && <Empty text="No matching tools found. Clear the search to show all registered tools." />}</section>;
}

function EntriesPage({ entries, allEntries, totalEntries, isFiltered, onDelete, onDeleteDate }: { entries: EntryRecord[]; allEntries: EntryRecord[]; totalEntries: number; isFiltered: boolean; onDelete: (entry: EntryRecord) => void; onDeleteDate: (dateKey: string, count: number) => void }) {
  const [selectedDate, setSelectedDate] = useState("");
  const visibleEntries = selectedDate ? entries.filter((entry) => localDateKey(entry.enteredAt) === selectedDate) : entries;
  const entriesOnSelectedDate = selectedDate ? allEntries.filter((entry) => localDateKey(entry.enteredAt) === selectedDate) : [];
  const isDateFiltered = Boolean(selectedDate);
  const countLabel = isDateFiltered
    ? `${visibleEntries.length} entries on ${formatLocalDate(selectedDate)}`
    : isFiltered ? `${entries.length} of ${totalEntries} entry events` : "All entry events";
  const subtitle = isDateFiltered
    ? `${entriesOnSelectedDate.length} total records exist for this India-time calendar date`
    : isFiltered ? "Filtered results · clear search to show the full history" : "One row per OUT → ACTIVE EPC transition";
  return <section className="panel table-panel"><PanelHeading title={countLabel} subtitle={subtitle} /><div className="date-controls"><label><span>Filter by date</span><input type="date" value={selectedDate} max={localDateKey(Date.now())} onChange={(event) => setSelectedDate(event.target.value)} /></label>{selectedDate && <><button className="secondary compact-button" onClick={() => setSelectedDate("")}>Clear date</button><button className="danger-button compact-button" disabled={!entriesOnSelectedDate.length} onClick={() => onDeleteDate(selectedDate, entriesOnSelectedDate.length)}>Delete all {entriesOnSelectedDate.length} for this date</button></>}</div><div className="table-scroll"><table><thead><tr><th>Date & time</th><th>Tool</th><th>Category</th><th>EPC</th><th>Source</th><th>Result</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={entry.id}><td><strong>{formatDateTime(entry.enteredAt)}</strong></td><td>{entry.toolName ?? "Deleted / unregistered tool"}</td><td>{entry.category ?? "—"}</td><td><code>{entry.epc}</code></td><td>{entry.source}</td><td><span className="status-pill logged"><i/> Logged once</span></td><td className="action-cell"><button className="delete-button" onClick={() => onDelete(entry)} aria-label={`Delete entry from ${formatDateTime(entry.enteredAt)}`}>Delete</button></td></tr>)}</tbody></table></div>{!visibleEntries.length && <Empty text={selectedDate ? "No entries were recorded on this date." : "No matching entry events found. Clear the search to show the full history."} />}</section>;
}

function Diagnostics({ sessions, frames, now, status, ports, selectedPort, setSelectedPort, chooseReader, connectReader, disconnectReader }: { sessions: TagSession[]; frames: ParsedFrame[]; now: number; status: string; ports: SerialPortLike[]; selectedPort: number; setSelectedPort: (index: number) => void; chooseReader: () => void; connectReader: () => void; disconnectReader: () => void }) {
  return <div className="diagnostic-layout">
    <section className="panel connection-panel"><PanelHeading title="Reader connection" subtitle="UM202 · A5 5A / 83 30 binary reports" /><div className="connection-state"><span className={`large-signal ${status}`}><i/><i/><i/><i/></span><div><strong>{status === "connected" ? "Reader online" : status === "simulator" ? "Simulator mode" : "Reader offline"}</strong><p>{status === "connected" ? "Receiving at 115200 baud, 8 data bits, no parity, 1 stop bit." : "Select an authorized serial port or grant access to a new reader."}</p></div></div><label className="field-label">Serial port<select value={selectedPort} onChange={(event) => setSelectedPort(Number(event.target.value))}><option value={0}>{ports.length ? portName(ports[0], 0) : "No authorized ports"}</option>{ports.slice(1).map((port, index) => <option value={index + 1} key={index}>{portName(port, index + 1)}</option>)}</select></label><div className="button-row"><button className="secondary" onClick={chooseReader}>Choose port</button><button className="primary" onClick={status === "connected" ? disconnectReader : connectReader}>{status === "connected" ? "Disconnect" : "Connect reader"}</button></div></section>
    <section className="panel monitor-panel"><PanelHeading title="Live tag monitor" subtitle={`${sessions.filter((s) => s.isActive).length} active · ${sessions.length} tracked in memory`} /><div className="table-scroll"><table><thead><tr><th>EPC</th><th>First seen</th><th>Last seen</th><th>Reads</th><th>RSSI</th><th>Frequency</th><th>Stability</th><th>Status</th></tr></thead><tbody>{sessions.map((session) => { const duration = Math.max(1, (session.lastSeen - session.firstSeen) / 1000); const frequency = session.readCount / duration; const stability = Math.min(99, Math.round((session.readCount / Math.max(1, duration * 5)) * 100)); return <tr key={session.epc}><td><code>{session.epc}</code></td><td>{formatTime(session.firstSeen)}</td><td>{Math.max(0, (now - session.lastSeen) / 1000).toFixed(1)}s ago</td><td>{session.readCount}</td><td>{session.lastRSSI ?? "—"}{session.lastRSSI !== undefined && " dBm"}</td><td>{frequency.toFixed(1)}/s</td><td><span className="stability"><i style={{ width: `${stability}%` }}/></span>{stability}%</td><td><span className={`status-pill ${session.isActive ? "active" : "out"}`}><i/>{session.isActive ? "ACTIVE" : "OUT"}</span></td></tr>; })}</tbody></table></div>{!sessions.length && <Empty text="No EPC sessions yet. Simulate a frame or connect the reader." />}</section>
    <section className="panel stream-panel"><PanelHeading title="Live UHF tag stream" subtitle="Most recent decoded reader frames" /><div className="frame-stream">{frames.map((frame) => <article key={`${frame.sequence}-${frame.receivedAt}`}><header><strong>Frame #{frame.sequence}</strong><span>{formatTime(frame.receivedAt)} · {frame.tags.length} tag{frame.tags.length === 1 ? "" : "s"} detected</span></header>{frame.tags.map((tag) => <div key={tag.epc}><code>{tag.epc}</code><span>{tag.rssi ?? "—"} dBm</span></div>)}<details><summary>Raw frame</summary><code>{frame.rawHex}</code></details></article>)}{!frames.length && <Empty text="Decoded frames will appear here in real time." />}</div></section>
  </div>;
}

function portName(port: SerialPortLike, index: number) {
  const info = port.getInfo();
  const vendor = info.usbVendorId?.toString(16).toUpperCase().padStart(4, "0");
  const product = info.usbProductId?.toString(16).toUpperCase().padStart(4, "0");
  return vendor ? `USB reader ${index + 1} · VID ${vendor}${product ? ` / PID ${product}` : ""}` : `Serial port ${index + 1}`;
}

function RegistrationModal({ sessions, tools, onClose, onSaved }: { sessions: TagSession[]; tools: ToolRecord[]; onClose: () => void; onSaved: (data: StoreData) => void }) {
  const candidates = sessions.filter((session) => !tools.some((tool) => tool.epc === session.epc)).sort((a, b) => b.firstSeen - a.firstSeen);
  const [epc, setEpc] = useState(candidates[0]?.epc ?? "");
  const [name, setName] = useState(""); const [category, setCategory] = useState("Power tools"); const [serialNumber, setSerialNumber] = useState(""); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    const tool = { name, category, serialNumber, epc };
    if (!name.trim() || !serialNumber.trim() || !epc.trim()) { setError("Name, serial number, and EPC are required."); setSaving(false); return; }
    try {
      const response = await fetch("/api/store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "addTool", tool }) });
      const data = await readStoreData(response);
      onSaved(data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not register tool"); setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="modal" onSubmit={save}><header><div><span className="eyebrow">RFID registry</span><h2>Add a new tool</h2><p>Link one physical tool to a unique UHF EPC.</p></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" /></button></header><div className="form-grid"><label className="field-label">Tool name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DeWalt Angle Grinder" /></label><label className="field-label">Category<select value={category} onChange={(e) => setCategory(e.target.value)}><option>Power tools</option><option>Hand tools</option><option>Test equipment</option><option>Safety equipment</option><option>Other</option></select></label><label className="field-label">Serial number<input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="Manufacturer serial" /></label><label className="field-label">EPC<input value={epc} onChange={(e) => setEpc(e.target.value.toUpperCase())} placeholder="24-digit hexadecimal EPC" /></label></div><div className="detected"><strong>Detected unregistered tags</strong><p>Select the tag introduced for this tool. Newest detection is highlighted.</p>{candidates.length ? candidates.map((session, index) => <button type="button" key={session.epc} className={`${epc === session.epc ? "selected" : ""} ${index === 0 ? "newest" : ""}`} onClick={() => setEpc(session.epc)}><span className="live-dot"/><code>{session.epc}</code><em>{index === 0 ? "Newest" : `${session.readCount} reads`}</em></button>) : <div className="empty-small">No unregistered tags detected. You can enter the EPC manually.</div>}</div>{error && <p className="form-error">{error}</p>}<footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Saving…" : "Register tool"}</button></footer></form></div>;
}

function ToolHistoryDialog({ tool, entries, onClose }: { tool: ToolRecord; entries: EntryRecord[]; onClose: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const toolEntries = entries
    .filter((entry) => entry.toolId === tool.id || entry.epc === tool.epc)
    .slice()
    .sort((a, b) => parseStoredTimestamp(b.enteredAt).getTime() - parseStoredTimestamp(a.enteredAt).getTime());
  const visibleEntries = showAll ? toolEntries : toolEntries.slice(0, 5);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title"><header><div className="history-title"><span className="history-tool-icon">⌁</span><div><span className="eyebrow">Tool entry history</span><h2 id="history-title">{tool.name}</h2><p>{tool.category} · <code>{tool.serialNumber}</code></p></div></div><button type="button" className="icon-button" aria-label="Close history" onClick={onClose}><Icon name="close" /></button></header><div className="history-meta"><div><span>EPC</span><code>{tool.epc}</code></div><div><span>Total entries</span><strong>{toolEntries.length}</strong></div><div><span>Last recorded</span><strong>{toolEntries[0] ? formatDateTime(toolEntries[0].enteredAt) : "Never"}</strong></div></div><div className="history-section-heading"><div><h3>{showAll ? "All recorded times" : "Last 5 recorded times"}</h3><p>One record per out-of-range to active transition</p></div>{toolEntries.length > 5 && <button onClick={() => setShowAll((current) => !current)}>{showAll ? "Show latest 5" : `View all ${toolEntries.length}`} <Icon name="chevron" /></button>}</div><div className="history-list">{visibleEntries.map((entry, index) => <div className="history-row" key={entry.id}><span className="history-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{formatDateTime(entry.enteredAt)}</strong><small>{entry.source} reader event</small></div><span className="status-pill logged"><i/> Recorded</span></div>)}{!toolEntries.length && <Empty text="No entry times have been recorded for this tool yet." />}</div><footer><button className="secondary" onClick={onClose}>Close</button></footer></section></div>;
}

function DeleteDialog({ target, deleting, onCancel, onConfirm }: { target: DeleteTarget; deleting: boolean; onCancel: () => void; onConfirm: () => void }) {
  const isTool = target.type === "tool";
  const isDate = target.type === "date";
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onCancel(); }}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title"><div className="danger-mark">!</div><div><span className="eyebrow">Permanent action</span><h2 id="delete-title">{isDate ? `Delete all ${target.count} entries for this date?` : `Delete ${isTool ? "registered tool" : "entry"}?`}</h2><p><strong>{target.label}</strong></p><p>{isDate ? "Every entry recorded during this India-time calendar date will be permanently removed. Tools remain registered." : isTool ? "The tool will no longer be recognized for new entries. Its existing entry history will remain available by EPC." : "This individual entry event will be permanently removed from history."}</p></div><footer><button className="secondary" onClick={onCancel} disabled={deleting}>Cancel</button><button className="danger-button" onClick={onConfirm} disabled={deleting}>{deleting ? "Deleting…" : isDate ? `Delete all ${target.count}` : "Delete permanently"}</button></footer></section></div>;
}

function Empty({ text }: { text: string }) { return <div className="empty"><span>⌁</span><p>{text}</p></div>; }
