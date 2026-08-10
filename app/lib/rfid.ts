export type TagRead = { epc: string; rssi?: number };

export type ParsedFrame = {
  sequence: number;
  receivedAt: number;
  rawHex: string;
  tags: TagRead[];
};

export type TagSession = {
  epc: string;
  firstSeen: number;
  lastSeen: number;
  isActive: boolean;
  readCount: number;
  lastRSSI?: number;
};

export type SessionUpdate = {
  activations: TagSession[];
  sessions: TagSession[];
};

const cleanEpc = (value: string) => value.replace(/[^0-9a-f]/gi, "").toUpperCase();
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ").toUpperCase();

/**
 * Independent per-EPC presence state machine. A read can only create an
 * activation after that EPC has timed out; other EPCs never affect it.
 */
export class TagSessionManager {
  private sessions = new Map<string, TagSession>();

  constructor(public readonly timeoutMs = 3000) {}

  processFrame(tags: TagRead[], now = Date.now()): SessionUpdate {
    this.expire(now);
    const unique = new Map<string, TagRead>();
    for (const tag of tags) {
      const epc = cleanEpc(tag.epc);
      if (!epc) continue;
      const existing = unique.get(epc);
      unique.set(epc, {
        epc,
        rssi: tag.rssi ?? existing?.rssi,
      });
    }

    const activations: TagSession[] = [];
    for (const tag of unique.values()) {
      const previous = this.sessions.get(tag.epc);
      if (!previous || !previous.isActive) {
        const next: TagSession = {
          epc: tag.epc,
          firstSeen: now,
          lastSeen: now,
          isActive: true,
          readCount: 1,
          lastRSSI: tag.rssi,
        };
        this.sessions.set(tag.epc, next);
        activations.push({ ...next });
      } else {
        previous.lastSeen = now;
        previous.readCount += 1;
        if (tag.rssi !== undefined) previous.lastRSSI = tag.rssi;
      }
    }
    return { activations, sessions: this.snapshot() };
  }

  expire(now = Date.now()): TagSession[] {
    const expired: TagSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.isActive && now - session.lastSeen > this.timeoutMs) {
        session.isActive = false;
        expired.push({ ...session });
      }
    }
    return expired;
  }

  snapshot(): TagSession[] {
    return Array.from(this.sessions.values(), (session) => ({ ...session })).sort(
      (a, b) => Number(b.isActive) - Number(a.isActive) || b.lastSeen - a.lastSeen,
    );
  }
}

type FrameDecoder = (frame: Uint8Array) => TagRead[];

/**
 * Buffered UM202 protocol boundary. It handles fragmented/coalesced reads and
 * delegates payload interpretation so the decoder can be swapped when the
 * reader vendor's final frame document is supplied. The primary envelope is
 * the observed UM202 report format:
 *
 * A5 5A | total length(2) | 83 30 | antenna | EPC | signal(2) | CRC(2) | 0D 0A
 *
 * The earlier BB...7E envelope remains supported as a compatibility profile.
 */
export class Um202Parser {
  private buffer = new Uint8Array(0);
  private sequence = 0;

  constructor(private readonly decoder: FrameDecoder = decodeUm202InventoryFrame) {}

  push(chunk: Uint8Array, receivedAt = Date.now()): ParsedFrame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const parsed: ParsedFrame[] = [];

    while (this.buffer.length) {
      const start = findFrameStart(this.buffer);
      if (start < 0) {
        this.buffer = new Uint8Array(0);
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);

      const isA55A = this.buffer[0] === 0xa5;
      const minimumHeaderLength = isA55A ? 4 : 5;
      if (this.buffer.length < minimumHeaderLength) break;

      const declaredLength = isA55A
        ? (this.buffer[2] << 8) | this.buffer[3]
        : (this.buffer[3] << 8) | this.buffer[4];
      const totalLength = isA55A ? declaredLength : declaredLength + 7;
      const minimumFrameLength = isA55A ? 13 : 7;
      if (totalLength < minimumFrameLength || totalLength > 4096) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < totalLength) break;
      const candidate = this.buffer.slice(0, totalLength);
      const hasValidEnd = isA55A
        ? candidate[totalLength - 2] === 0x0d && candidate[totalLength - 1] === 0x0a
        : candidate[totalLength - 1] === 0x7e;
      if (!hasValidEnd) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      this.buffer = this.buffer.slice(totalLength);
      parsed.push({
        sequence: ++this.sequence,
        receivedAt,
        rawHex: toHex(candidate),
        tags: this.decoder(candidate),
      });
    }
    return parsed;
  }
}

function findFrameStart(bytes: Uint8Array) {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0xbb) return index;
    if (bytes[index] === 0xa5 && (index + 1 === bytes.length || bytes[index + 1] === 0x5a)) return index;
  }
  return -1;
}

/** Default inventory decoder for the observed UM202 format plus legacy profile. */
export function decodeUm202InventoryFrame(frame: Uint8Array): TagRead[] {
  if (frame[0] === 0xa5 && frame[1] === 0x5a) return decodeA55AInventoryFrame(frame);
  return decodeLegacyInventoryFrame(frame);
}

/**
 * Decodes the captured 25-byte inventory report. The length field is used to
 * retain support for a different EPC length if the reader is configured for it.
 * The observed signal byte is an 8-bit two's-complement RSSI value.
 */
export function decodeA55AInventoryFrame(frame: Uint8Array): TagRead[] {
  if (frame.length < 13 || frame[0] !== 0xa5 || frame[1] !== 0x5a) return [];
  const declaredLength = (frame[2] << 8) | frame[3];
  if (declaredLength !== frame.length || frame[4] !== 0x83 || frame[5] !== 0x30) return [];
  if (frame[frame.length - 2] !== 0x0d || frame[frame.length - 1] !== 0x0a) return [];

  // Byte 6 is the antenna/channel. The six-byte trailer is signal metadata,
  // a two-byte CRC, and CRLF. CRC validation remains isolated until the vendor
  // polynomial is confirmed.
  const epc = frame.slice(7, frame.length - 6);
  if (epc.length < 4) return [];
  const rawRssi = frame[frame.length - 5];
  const rssi = rawRssi > 127 ? rawRssi - 256 : rawRssi;
  return [{ epc: toHex(epc).replaceAll(" ", ""), rssi }];
}

function decodeLegacyInventoryFrame(frame: Uint8Array): TagRead[] {
  if (frame.length < 7 || frame[2] !== 0x22) return [];
  const payloadLength = (frame[3] << 8) | frame[4];
  const payload = frame.slice(5, 5 + payloadLength);
  if (!payload.length) return [];

  // Multi-record layout: count, then [signed RSSI, EPC byte length, EPC bytes].
  const count = payload[0];
  if (count > 0 && count <= 100) {
    const tags: TagRead[] = [];
    let offset = 1;
    for (let index = 0; index < count; index += 1) {
      if (offset + 2 > payload.length) return [];
      const rssi = payload[offset] > 127 ? payload[offset] - 256 : payload[offset];
      const epcLength = payload[offset + 1];
      offset += 2;
      if (!epcLength || offset + epcLength > payload.length) return [];
      tags.push({ epc: toHex(payload.slice(offset, offset + epcLength)).replaceAll(" ", ""), rssi });
      offset += epcLength;
    }
    if (offset === payload.length) return tags;
  }

  // Common inventory response: RSSI, PC(2), EPC, optional CRC(2).
  if (payload.length >= 5) {
    const rssi = payload[0] > 127 ? payload[0] - 256 : payload[0];
    const words = ((payload[1] << 8) | payload[2]) >> 11;
    const epcLength = words * 2;
    if (epcLength >= 4 && 3 + epcLength <= payload.length) {
      return [{ epc: toHex(payload.slice(3, 3 + epcLength)).replaceAll(" ", ""), rssi }];
    }
  }
  return [];
}

export function parseSimulationInput(input: string): TagRead[] {
  return input
    .split(/[\s,]+/)
    .map(cleanEpc)
    .filter(Boolean)
    .map((epc, index) => ({ epc, rssi: -38 - (index % 5) * 3 }));
}
