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

const DISPLAY_TIME_ZONE = "Asia/Kolkata";

function time(value: number | string) {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: DISPLAY_TIME_ZONE }).format(new Date(value));
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: DISPLAY_TIME_ZONE }).format(new Date(value));
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
  const [simInput, setSimInput] = useState(seedTools.slice(0, 3).map((tool) => tool.epc).join(" "));
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [now, setNow] = useState(Date.now());
  const manager = useRef(new TagSessionManager(3000));
  const parser = useRef(new Um202Parser());
  const activePort = useRef<SerialPortLike | null>(null);
  const stopReading = useRef(false);
  const frameNumber = useRef(0);

  const refreshStore = useCallback(async () => {
    try {
      const response = await fetch("/api/store");
      if (!response.ok) return;
      const data = (await response.json()) as StoreData;
      setStore(data);
      if (!data.tools.length) {
        const seeded = await fetch("/api/store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "seed" }) });
        if (seeded.ok) setStore((await seeded.json()) as StoreData);
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
    const tool = store.tools.find((item) => item.epc === session.epc);
    if (!tool) return;
    const optimistic: EntryRecord = { id: Date.now(), toolId: tool.id, epc: tool.epc, enteredAt: new Date(session.firstSeen).toISOString(), readCount: 1, source, toolName: tool.name, category: tool.category };
    setStore((current) => ({ ...current, entries: [optimistic, ...current.entries] }));
    try {
      const response = await fetch("/api/store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "logEntry", epc: session.epc, source }) });
      if (response.ok) setStore((await response.json()) as StoreData);
    } catch { /* optimistic event remains visible */ }
  }, [store.tools]);

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
    const tags = parseSimulationInput(simInput);
    if (!tags.length) return notify("Enter at least one hexadecimal EPC.");
    setStatus("simulator");
    const repeat = burst ? 100 : 1;
    let newEntries = 0;
    for (let index = 0; index < repeat; index += 1) newEntries += processTags(tags, "Simulator");
    notify(`${tags.length} tags processed${burst ? " × 100 bursts" : ""}; ${newEntries} new session${newEntries === 1 ? "" : "s"}.`);
  }

  const activeSessions = sessions.filter((session) => session.isActive);
  const registeredActive = activeSessions.filter((session) => store.tools.some((tool) => tool.epc === session.epc));
  const todayEntries = store.entries.filter((entry) => new Date(entry.enteredAt).toDateString() === new Date().toDateString());
  const title: Record<Page, [string, string]> = {
    dashboard: ["Good morning", "Here’s what’s happening in your tool room."],
    tools: ["Tool registry", "Manage every RFID-linked asset in one place."],
    entries: ["Entry history", "A durable timeline of every tool arrival."],
    diagnostics: ["RFID diagnostics", "Inspect the live multi-tag field and reader health."],
  };

  const filteredTools = store.tools.filter((tool) => `${tool.name} ${tool.category} ${tool.serialNumber} ${tool.epc}`.toLowerCase().includes(search.toLowerCase()));
  const filteredEntries = store.entries.filter((entry) => `${entry.toolName} ${entry.category} ${entry.epc}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>Tool<span>Track</span></span></div>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Main navigation">
          {(["dashboard", "tools", "entries", "diagnostics"] as Page[]).map((item) => (
            <button key={item} className={page === item ? "active" : ""} onClick={() => { setPage(item); setMobileNav(false); }}>
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
            <label className="search"><Icon name="search" /><input aria-label="Search tools and entries" placeholder="Search tools, EPCs…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <button className="primary" onClick={() => setRegistrationOpen(true)}><Icon name="add" /> Add new tool</button>
            <div className="avatar" title="Store administrator">AM</div>
          </div>
        </header>

        <section className="content">
          {page === "dashboard" && <Dashboard tools={store.tools} entries={todayEntries} sessions={sessions} frames={frames} status={status} onNavigate={setPage} onSimulate={() => simulate(false)} onConnect={status === "connected" ? disconnectReader : connectReader} />}
          {page === "tools" && <ToolsPage tools={filteredTools} entries={store.entries} onAdd={() => setRegistrationOpen(true)} />}
          {page === "entries" && <EntriesPage entries={filteredEntries} />}
          {page === "diagnostics" && <Diagnostics sessions={sessions} frames={frames} now={now} status={status} ports={ports} selectedPort={selectedPort} setSelectedPort={setSelectedPort} chooseReader={chooseReader} connectReader={connectReader} disconnectReader={disconnectReader} simInput={simInput} setSimInput={setSimInput} simulate={simulate} />}
        </section>
      </main>

      {registrationOpen && <RegistrationModal sessions={sessions} tools={store.tools} onClose={() => setRegistrationOpen(false)} onSaved={(data) => { setStore(data); setRegistrationOpen(false); notify("Tool registered and ready for detection."); }} />}
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
        <div className="entry-list">{entries.slice(0, 5).map((entry) => <div className="entry-row" key={entry.id}><div className="tool-glyph">⌁</div><div className="entry-main"><strong>{entry.toolName ?? "Unregistered tag"}</strong><span>{entry.category ?? "Unknown tool"} · {shortEpc(entry.epc)}</span></div><div className="entry-time"><strong>{time(entry.enteredAt)}</strong><span>Today</span></div><span className="entry-ok">✓</span></div>)}{!entries.length && <Empty text="No entries yet today. Bring a tagged tool into range." />}</div>
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

function ToolsPage({ tools, entries, onAdd }: { tools: ToolRecord[]; entries: EntryRecord[]; onAdd: () => void }) {
  return <section className="panel table-panel"><PanelHeading title={`${tools.length} registered tools`} subtitle="Each EPC is unique and maps to one physical tool" action="Register tool" onAction={onAdd} /><div className="table-scroll"><table><thead><tr><th>Tool</th><th>Category</th><th>Serial number</th><th>EPC</th><th>Entries</th><th>Status</th></tr></thead><tbody>{tools.map((tool) => <tr key={tool.id}><td><div className="table-tool"><span>⌁</span><strong>{tool.name}</strong></div></td><td>{tool.category}</td><td><code>{tool.serialNumber}</code></td><td><code>{tool.epc}</code></td><td>{entries.filter((entry) => entry.toolId === tool.id).length}</td><td><span className="status-pill available"><i/> {tool.status}</span></td></tr>)}</tbody></table></div>{!tools.length && <Empty text="No matching tools found." />}</section>;
}

function EntriesPage({ entries }: { entries: EntryRecord[] }) {
  return <section className="panel table-panel"><PanelHeading title="All entry events" subtitle="One row per OUT → ACTIVE EPC transition" /><div className="table-scroll"><table><thead><tr><th>Date & time</th><th>Tool</th><th>Category</th><th>EPC</th><th>Source</th><th>Result</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td><strong>{dateTime(entry.enteredAt)}</strong></td><td>{entry.toolName ?? "Unregistered tag"}</td><td>{entry.category ?? "—"}</td><td><code>{entry.epc}</code></td><td>{entry.source}</td><td><span className="status-pill logged"><i/> Logged once</span></td></tr>)}</tbody></table></div>{!entries.length && <Empty text="No matching entry events found." />}</section>;
}

function Diagnostics({ sessions, frames, now, status, ports, selectedPort, setSelectedPort, chooseReader, connectReader, disconnectReader, simInput, setSimInput, simulate }: { sessions: TagSession[]; frames: ParsedFrame[]; now: number; status: string; ports: SerialPortLike[]; selectedPort: number; setSelectedPort: (index: number) => void; chooseReader: () => void; connectReader: () => void; disconnectReader: () => void; simInput: string; setSimInput: (value: string) => void; simulate: (burst?: boolean) => void }) {
  return <div className="diagnostic-layout">
    <section className="panel connection-panel"><PanelHeading title="Reader connection" subtitle="UM202 · A5 5A / 83 30 binary reports" /><div className="connection-state"><span className={`large-signal ${status}`}><i/><i/><i/><i/></span><div><strong>{status === "connected" ? "Reader online" : status === "simulator" ? "Simulator mode" : "Reader offline"}</strong><p>{status === "connected" ? "Receiving at 115200 baud, 8 data bits, no parity, 1 stop bit." : "Select an authorized serial port or grant access to a new reader."}</p></div></div><label className="field-label">Serial port<select value={selectedPort} onChange={(event) => setSelectedPort(Number(event.target.value))}><option value={0}>{ports.length ? portName(ports[0], 0) : "No authorized ports"}</option>{ports.slice(1).map((port, index) => <option value={index + 1} key={index}>{portName(port, index + 1)}</option>)}</select></label><div className="button-row"><button className="secondary" onClick={chooseReader}>Choose port</button><button className="primary" onClick={status === "connected" ? disconnectReader : connectReader}>{status === "connected" ? "Disconnect" : "Connect reader"}</button></div></section>
    <section className="panel simulator-panel"><PanelHeading title="Multi-tag simulator" subtitle="Duplicates are suppressed per EPC session" /><label className="field-label">EPCs in frame<textarea value={simInput} onChange={(event) => setSimInput(event.target.value)} rows={4} spellCheck={false}/></label><div className="button-row"><button className="secondary" onClick={() => simulate(false)}>Simulate frame</button><button className="primary" onClick={() => simulate(true)}>Rapid burst × 100</button></div><p className="hint">Wait 3 seconds before replaying to create a new entry session.</p></section>
    <section className="panel monitor-panel"><PanelHeading title="Live tag monitor" subtitle={`${sessions.filter((s) => s.isActive).length} active · ${sessions.length} tracked in memory`} /><div className="table-scroll"><table><thead><tr><th>EPC</th><th>First seen</th><th>Last seen</th><th>Reads</th><th>RSSI</th><th>Frequency</th><th>Stability</th><th>Status</th></tr></thead><tbody>{sessions.map((session) => { const duration = Math.max(1, (session.lastSeen - session.firstSeen) / 1000); const frequency = session.readCount / duration; const stability = Math.min(99, Math.round((session.readCount / Math.max(1, duration * 5)) * 100)); return <tr key={session.epc}><td><code>{session.epc}</code></td><td>{time(session.firstSeen)}</td><td>{Math.max(0, (now - session.lastSeen) / 1000).toFixed(1)}s ago</td><td>{session.readCount}</td><td>{session.lastRSSI ?? "—"}{session.lastRSSI !== undefined && " dBm"}</td><td>{frequency.toFixed(1)}/s</td><td><span className="stability"><i style={{ width: `${stability}%` }}/></span>{stability}%</td><td><span className={`status-pill ${session.isActive ? "active" : "out"}`}><i/>{session.isActive ? "ACTIVE" : "OUT"}</span></td></tr>; })}</tbody></table></div>{!sessions.length && <Empty text="No EPC sessions yet. Simulate a frame or connect the reader." />}</section>
    <section className="panel stream-panel"><PanelHeading title="Live UHF tag stream" subtitle="Most recent decoded reader frames" /><div className="frame-stream">{frames.map((frame) => <article key={`${frame.sequence}-${frame.receivedAt}`}><header><strong>Frame #{frame.sequence}</strong><span>{time(frame.receivedAt)} · {frame.tags.length} tag{frame.tags.length === 1 ? "" : "s"} detected</span></header>{frame.tags.map((tag) => <div key={tag.epc}><code>{tag.epc}</code><span>{tag.rssi ?? "—"} dBm</span></div>)}<details><summary>Raw frame</summary><code>{frame.rawHex}</code></details></article>)}{!frames.length && <Empty text="Decoded frames will appear here in real time." />}</div></section>
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
      const data = await response.json() as StoreData & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not register tool");
      onSaved(data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not register tool"); setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="modal" onSubmit={save}><header><div><span className="eyebrow">RFID registry</span><h2>Add a new tool</h2><p>Link one physical tool to a unique UHF EPC.</p></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" /></button></header><div className="form-grid"><label className="field-label">Tool name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DeWalt Angle Grinder" /></label><label className="field-label">Category<select value={category} onChange={(e) => setCategory(e.target.value)}><option>Power tools</option><option>Hand tools</option><option>Test equipment</option><option>Safety equipment</option><option>Other</option></select></label><label className="field-label">Serial number<input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="Manufacturer serial" /></label><label className="field-label">EPC<input value={epc} onChange={(e) => setEpc(e.target.value.toUpperCase())} placeholder="24-digit hexadecimal EPC" /></label></div><div className="detected"><strong>Detected unregistered tags</strong><p>Select the tag introduced for this tool. Newest detection is highlighted.</p>{candidates.length ? candidates.map((session, index) => <button type="button" key={session.epc} className={`${epc === session.epc ? "selected" : ""} ${index === 0 ? "newest" : ""}`} onClick={() => setEpc(session.epc)}><span className="live-dot"/><code>{session.epc}</code><em>{index === 0 ? "Newest" : `${session.readCount} reads`}</em></button>) : <div className="empty-small">No unregistered tags detected. You can enter the EPC manually.</div>}</div>{error && <p className="form-error">{error}</p>}<footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Saving…" : "Register tool"}</button></footer></form></div>;
}

function Empty({ text }: { text: string }) { return <div className="empty"><span>⌁</span><p>{text}</p></div>; }
