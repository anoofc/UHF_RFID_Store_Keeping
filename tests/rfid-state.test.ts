import assert from "node:assert/strict";
import test from "node:test";
import { TagSessionManager, Um202Parser } from "../app/lib/rfid.ts";

const A = { epc: "E20034120123456789ABC001", rssi: -41 };
const B = { epc: "E20034120123456789ABC002", rssi: -44 };
const C = { epc: "E20034120123456789ABC003", rssi: -49 };

test("100 repeated multi-tag bursts create exactly three activations", () => {
  const manager = new TagSessionManager(3000);
  let activations = 0;
  for (let index = 0; index < 100; index += 1) activations += manager.processFrame([A, B, C, A], index * 10).activations.length;
  assert.equal(activations, 3);
  assert.deepEqual(manager.snapshot().map((tag) => tag.readCount), [100, 100, 100]);
});

test("mixed dropout expires EPCs independently and permits reactivation", () => {
  const manager = new TagSessionManager(3000);
  assert.equal(manager.processFrame([A, B, C], 0).activations.length, 3);
  manager.processFrame([A, B], 1000);
  manager.processFrame([A], 2999);
  manager.expire(4001);
  assert.equal(manager.snapshot().find((tag) => tag.epc === A.epc)?.isActive, true);
  assert.equal(manager.snapshot().find((tag) => tag.epc === B.epc)?.isActive, false);
  assert.equal(manager.snapshot().find((tag) => tag.epc === C.epc)?.isActive, false);
  assert.equal(manager.processFrame([B], 5000).activations.length, 1);
});

test("binary receive buffer handles fragmented and coalesced frames", () => {
  const frame = (epcHex: string, rssi: number) => {
    const epc = Uint8Array.from(epcHex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
    const payload = Uint8Array.from([1, rssi & 0xff, epc.length, ...epc]);
    return Uint8Array.from([0xbb, 0x02, 0x22, 0, payload.length, ...payload, 0, 0x7e]);
  };
  const first = frame(A.epc, -41); const second = frame(B.epc, -44);
  const parser = new Um202Parser();
  assert.equal(parser.push(first.slice(0, 8)).length, 0);
  const joined = Uint8Array.from([...first.slice(8), ...second]);
  const parsed = parser.push(joined);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((item) => item.tags[0].epc), [A.epc, B.epc]);
});
