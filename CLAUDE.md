# Tesla TPMS explorer

GitHub Pages site (https://kimschultz.github.io/Tesla-TPMS-explorer/) that reads Tesla Model 3/Y BLE tyre pressure sensors from Chrome on Android via Web Bluetooth. Kim's car: 2021 Model 3 AWD, factory BLE sensors. Android phone only, no iPhone.

## Rules
- Plain single-file HTML/CSS/JS. No build step, no dependencies besides Google Fonts.
- Mobile-first, light and dark mode.
- Read-only toward the sensor. The only write allowed is the CCCD (startNotifications). Never write anything else: the sensor accepts OTA firmware updates. That includes requests like `genealogyRequest` or `TPDataRequest`, even though they would return more data.
- Nothing sensitive in localStorage.
- No em-dashes in repo text.
- Personal repo, no Jira: short descriptive branch names. Don't commit until tests pass and Kim has reviewed the diff; ask before pushing to main.
- BLE can't be tested from the dev machine. Kim tests at the car and brings back exported JSON.

## Files
- `index.html`: one-tap reader. Four wheel cards (FL/FR/RL/RR). "Read" (parked sensors, picker filtered on 0x022B + `01 FE 03`) and "Read after driving" (filtered on 0x022B only, listens 45 s, keeps every message). Saves to localStorage key `tesla-tpms:readings:v1`. "Not in list" marks a dead sensor. CSV/JSON export, Android share sheet.
- `explorer.html`: raw explorer. Broadcast watching with byte diffs, GATT browser, named protobuf field dump, labelled log download.
- The `<script id="tpms-decoder">` block is identical in both HTML files. Edit both; `tests/decoder.test.js` fails if they differ.
- Tests: `node --test` from the repo root (Node 18+, no npm packages).

## Protocol
Sources: VincentMasselis/TPMS-advanced PR #510 (TeslaGatt.kt, RawTeslaIdOnly.kt); field numbers from trifinite/vcsec-archive `protos/VCSECv4.20.69.proto`.

- Adverts: manufacturer data, company 0x022B. Parked sensors send `01 FE 03` about once a second, no measurements, no sensor ID. The car also uses 0x022B with payloads over 8 bytes.
- OEM and Autel MX-Sensor BLE use TI MAC prefixes BC:6A:29 / E4:FA:5B; a clone used a random static address. Web Bluetooth hides the MAC from the page; Chrome's picker shows it to the user.
- GATT: service `00000211-b2d1-43f0-9b88-960cebf8b91e`, indicate characteristic `00000213-b2d1-43f0-9b88-960cebf8b91e`.
- One connection at a time: while the phone is connected the car can't read the sensor.
- Cheap 1490701-01-C clones may report a fixed 29 °C.
- Messages are protobuf, not size-prefixed. Field 2 = UnsignedMessage, which holds one of:

| Path | Message | Fields |
|---|---|---|
| 2.5 | TPAdv | 1 pressure, 2 temp (sint32), 3 notify reason, 4 batteryVoltage_mV, 5 adv count, 6 adv type |
| 2.27 | SleepManagerStats | 1 CPU time, 2 awake time, 3 BLE trim applied |
| 2.28 | TPData | 1 pressure (absolute kPa; gauge = abs - 101.325, clamp >= 0), 2 temp (sint32 °C) |
| 2.29 | TPWheelUnitInfo | 1 TI app CRC, 2 MLX app CRC, 3 batteryVoltage_mV |
| 2.30 | ResetTrackerStats | 1-10 reset counters |
| 2.31 | TPNotifyTrackerStats | 1-7 notify reason counters |
| 2.33 | TPLRDetection | 1 result (0-2 error, 3 left, 4 right), 2 period ms, 3 x90deg count, 4 x270deg count, 5 Z accel (sint32, dg), 6 Z accel diff count |
| 2.34 | ConnectionMetrics | 1 good, 2 missed, 3 bad CRC; every ~4 min while connected and static |
| 2.35 | deviceActivity (enum) | 0 none, 1 stationary, 2 motion, 3 significant motion |
| 2.44 | AccelData | 1 X accel g, 2 Z accel g (int32) |
| 2.45 | TPMSAlarms | bools: 1 pressure, 2 temperature, 3 acceleration, 4 voltage, 5 LF detect, 6 wheel motion |

TPAdv notify reasons: 0 unknown, 1 low pressure, 2 P/T update, 3 wheel moving, 4 rotation direction ready, 5 LF, 6 fault.

## Open question: battery
TPMS-advanced says the sensor doesn't send battery. The Tireless iOS app (tff-forum.de thread 161530) read ~3000 mV on new sensors, plus connection metrics, rotation direction and Z acceleration, while sensors were awake from driving. The proto has battery in two places:
- TPWheelUnitInfo (2.29.3): a reply to the car's `genealogyRequest = 3`. Getting it means writing a request, which the read-only rule forbids.
- TPAdv (2.5.4): has battery plus a "wheel moving" notify reason. Hypothesis: awake sensors send it unprompted. "Read after driving" exists to test this.

The low-battery threshold (`LOW_MV` in index.html) is a guess until real readings come in.
