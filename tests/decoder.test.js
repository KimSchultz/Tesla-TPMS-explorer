// Run from the repo root with: node --test
// Loads the <script id="tpms-decoder"> block from both HTML files and feeds it hand-built protobuf messages.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const block = f => html(f).match(/<script id="tpms-decoder">([\s\S]*?)<\/script>/)[1];
const load = f => vm.runInNewContext(block(f) + "\n;TPMS");

// ---------- tiny protobuf encoder ----------
const varint = n => {
  n = BigInt(n); if (n < 0n) n = BigInt.asUintN(64, n);
  const o = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return o;
};
const zz = n => n >= 0 ? 2 * n : -2 * n - 1;
const vf = (f, n) => [...varint(f << 3), ...varint(n)];
const lf = (f, bytes) => [...varint((f << 3) | 2), ...varint(bytes.length), ...bytes];
const wheel = (f, inner) => Uint8Array.from(lf(2, lf(f, inner))); // FromTPWheelUnitMessage { unsignedMessage { field f } }

test("both pages carry the same decoder", () => {
  assert.equal(block("explorer.html"), block("index.html"));
});

test("every script in both pages compiles", () => {
  for (const f of ["index.html", "explorer.html"]){
    for (const [, src] of html(f).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(src, { filename: f });
  }
});

for (const file of ["index.html", "explorer.html"]){
  const T = load(file);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

  test(`${file}: TPData pressure and temperature`, () => {
    const d = T.decode(wheel(28, [...vf(1, 345), ...vf(2, zz(-5))]));
    assert.equal(d.kind, "data");
    assert.equal(d.pressureKpa, 345);
    assert.equal(d.tempC, -5);
    near(d.bar, (345 - 101.325) / 100);
    near(d.psi, (345 - 101.325) * 0.1450377);
  });

  test(`${file}: TPData omits 0 °C (proto3 default)`, () => {
    assert.equal(T.decode(wheel(28, vf(1, 340))).tempC, 0);
  });

  test(`${file}: gauge pressure clamps at 0`, () => {
    assert.equal(T.decode(wheel(28, vf(1, 90))).bar, 0);
  });

  test(`${file}: TPAdv with battery and notify reason`, () => {
    const d = T.decode(wheel(5, [...vf(1, 330), ...vf(2, zz(21)), ...vf(3, 3), ...vf(4, 3012), ...vf(5, 7)]));
    assert.equal(d.kind, "adv");
    assert.equal(d.batteryMv, 3012);
    assert.equal(d.notifyReason, "wheel moving");
    assert.equal(d.advCount, 7);
    assert.equal(d.tempC, 21);
    assert.ok("bar" in d);
  });

  test(`${file}: TPAdv without pressure is not a tyre reading`, () => {
    const d = T.decode(wheel(5, [...vf(3, 3), ...vf(4, 3012)]));
    assert.equal(d.batteryMv, 3012);
    assert.ok(!("bar" in d));
  });

  test(`${file}: TPData without pressure is not a tyre reading`, () => {
    assert.ok(!("bar" in T.decode(wheel(28, vf(2, zz(20))))));
  });

  test(`${file}: TPWheelUnitInfo battery and CRCs`, () => {
    const d = T.decode(wheel(29, [...lf(1, [0xde, 0xad]), ...lf(2, [0x01]), ...vf(3, 2950)]));
    assert.deepEqual({ ...d }, { kind: "info", tiAppCrc: "de ad", mlxAppCrc: "01", batteryMv: 2950 });
  });

  test(`${file}: rotation direction`, () => {
    const d = T.decode(wheel(33, [...vf(1, 3), ...vf(2, 120), ...vf(5, zz(-12))]));
    assert.equal(d.kind, "rotation");
    assert.equal(d.result, "left");
    assert.equal(d.periodMs, 120);
    assert.equal(d.zAccelDg, -12);
    assert.equal(d.count90, 0);
  });

  test(`${file}: unknown enum value`, () => {
    assert.equal(T.decode(wheel(33, vf(1, 9))).result, "unknown 9");
  });

  test(`${file}: connection metrics heartbeat`, () => {
    const d = T.decode(wheel(34, [...vf(1, 100), ...vf(2, 2), ...vf(3, 1)]));
    assert.deepEqual({ ...d }, { kind: "heartbeat", good: 100, missed: 2, badCrc: 1 });
  });

  test(`${file}: device activity enum`, () => {
    const d = T.decode(Uint8Array.from(lf(2, vf(35, 2))));
    assert.deepEqual({ ...d }, { kind: "activity", activity: "motion" });
  });

  test(`${file}: negative int32 accel (10-byte varint)`, () => {
    const d = T.decode(wheel(44, [...vf(1, -2), ...vf(2, 1)]));
    assert.equal(d.xAccelG, -2);
    assert.equal(d.zAccelG, 1);
  });

  test(`${file}: alarms, including an empty message`, () => {
    assert.equal(T.decode(wheel(45, vf(4, 1))).voltage, true);
    assert.equal(T.decode(wheel(45, [])).voltage, false);
  });

  test(`${file}: unknown UnsignedMessage field is "other"`, () => {
    assert.equal(T.decode(wheel(99, vf(1, 1))).kind, "other");
  });

  test(`${file}: garbage and non-wheel messages`, () => {
    assert.equal(T.decode(Uint8Array.from([0x01, 0xfe, 0x03])), null);
    assert.equal(T.decode(Uint8Array.from([0x12, 0x05, 0x01])), null); // truncated
    assert.equal(T.decode(Uint8Array.from(vf(1, 5))), null); // no field 2
  });

  test(`${file}: field dump names known paths and leaves unknown ones raw`, () => {
    const rows = T.fields(wheel(5, [...vf(4, 3012), ...vf(9, 77)]));
    const by = Object.fromEntries(rows.map(r => [r.path, r]));
    assert.equal(by["2"].name, "unsignedMessage");
    assert.equal(by["2.5"].name, "adv");
    assert.equal(by["2.5.4"].name, "adv.batteryMv");
    assert.equal(by["2.5.4"].value, 3012);
    assert.equal(by["2.5.9"].name, undefined);
    assert.match(by["2.5.9"].raw, /^varint 77/);
  });

  test(`${file}: field dump keeps bytes fields as bytes`, () => {
    const rows = T.fields(wheel(29, lf(1, vf(1, 5)))); // CRC bytes that happen to parse as protobuf
    const crc = rows.find(r => r.path === "2.29.1");
    assert.equal(crc.value, "08 05");
    assert.ok(!rows.some(r => r.path.startsWith("2.29.1.")));
  });

  test(`${file}: field dump shows empty and unparseable messages as bytes`, () => {
    const empty = T.fields(wheel(46, [])).find(r => r.path === "2.46");
    assert.equal(empty.raw, 'bytes [] ""');
    const bad = T.fields(Uint8Array.from(lf(2, lf(5, [0x07])))).find(r => r.path === "2.5");
    assert.equal(bad.name, "adv");
    assert.ok(!("value" in bad));
    assert.match(bad.raw, /^bytes \[07\]/);
  });

  test(`${file}: field dump of non-protobuf is null`, () => {
    assert.equal(T.fields(Uint8Array.from([0x07])), null);
  });
}
