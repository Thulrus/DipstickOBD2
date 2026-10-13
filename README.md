# Dipstick

An open-source OBD2 app that runs in the browser. No install, no account, no paywall.

Plug a cheap ELM327 Bluetooth adapter into your vehicle, open the page, and you get live sensor data, trouble codes, and a log of every drive that you can export or hand to an AI assistant for help with diagnosis.

> **Status: early.** It works end to end against the built-in simulated vehicle. Testing on real vehicles and adapters has only just started, so expect rough edges and please report them.

## What it does

- **Live data.** Every standard sensor your vehicle reports: RPM, speed, temperatures, fuel trims, oxygen sensors, airflow, timing and more. You choose which ones to watch.
- **Automatic logging.** Each connection is recorded as a session, saved every few seconds, and kept in your browser. Nothing is uploaded.
- **Exports that explain themselves.** A short summary to paste into an AI chat, a per-second CSV, a CSV of every raw reading, and a JSON file. All of them name their units and include the vehicle, trouble codes and readiness monitors.
- **Signal profiles.** One-tap selections such as "Catalyst test" or "Fuel trims". The adapter reads one signal at a time, so a short list is how you see fast-changing things.
- **Markers.** Stamp the log as you drive ("A/C on", "holding 2,500 rpm") so the data can be read in context.
- **Trouble codes.** Read stored, pending and permanent codes, see readiness monitors (what an emissions test checks), and clear codes.
- **Full diagnostic report.** On every connection the app also reads the freeze frame (what the engine was doing when a fault was recorded), fuel system status, one reading of every sensor the vehicle supports, and the vehicle's own self-test results (OBD service 06). Copy it as one report, or find it saved with the session.
- **Other modules (airbag, ABS, body...).** An optional, read-only scan asks every computer it can reach for its stored codes and lists whatever answers, with the raw codes, so you can look them up or paste the report into an AI chat. Nothing is decoded per manufacturer and nothing is ever cleared or changed. On 11-bit CAN vehicles (most from about 2008) it sweeps all diagnostic ids, which reaches airbag, ABS and similar modules; it takes about a minute. On older vehicles the OBD port only reaches the emissions computers (engine, sometimes transmission), so the scan lists each one separately with its codes, check-engine status, calibration ids and name. Airbag and ABS on those vehicles (for example Nissan's CONSULT line) need a different adapter. Live logging pauses while it runs.
- **Works offline.** After the first visit the app is cached, so it works in a garage or on the road with no signal.
- **Demo mode.** A simulated truck with a lean-running bank 2, so you can try everything with no hardware.

## What you need

| | Supported |
|---|---|
| Browser | Chrome on Android (138 or newer), or Chrome / Edge on Windows, macOS, Linux or ChromeOS |
| Adapter | ELM327-compatible, Bluetooth Classic or USB |
| Vehicle | Anything with OBD2: US vehicles from 1996, EU petrol from 2001, EU diesel from 2004 |

Not supported yet: iPhone and iPad (Safari has no way for a web page to reach the adapter), Firefox, WiFi adapters, and Bluetooth LE adapters (planned).

## Using it

1. Plug the adapter into the OBD2 port and turn the ignition on.
2. Pair the adapter in your device's Bluetooth settings. The PIN is usually `1234` or `0000`.
3. Open the app, tap **Connect adapter**, and pick the adapter from the list.

**Android: if the list says "No compatible devices found"**, Chrome is missing a permission that it doesn't ask for itself. Open Settings → Apps → Chrome → Permissions and allow **Nearby devices**, then try again. If the adapter still isn't listed, restart the phone once.

Only one app can talk to the adapter at a time, so close any other OBD2 app first.

## Development

```sh
npm install
npm run dev      # start a local dev server
npm test         # run the test suite
npm run build    # type-check and build to dist/
```

You don't need a vehicle to work on this. **Try the demo** in the app connects to `src/transport/simulator.ts`, a fake ELM327 that speaks the same text protocol as a real one. The test suite runs against it on both a CAN bus and an older ISO 9141 bus.

### How the code is laid out

```
src/
  transport/   Byte pipe to the adapter: Web Serial, and the simulator
  elm/         ELM327 driver (command queue, init) and response parsing
  obd/         Signal definitions, units, trouble codes, polling
  log/         IndexedDB storage, recorder, export formats
  ui/          React screens
  store.ts     App state and the connection lifecycle
```

Manufacturer-specific knowledge, such as what a pre-CAN vehicle's self-test ids mean, lives in `src/obd/vehicles/` and is matched on the VIN.

Each layer only knows about the one below it. To support a new kind of adapter connection, implement `Transport`. To add a sensor, add an entry to `SIGNALS` in `src/obd/signals.ts`.

## Roadmap

- Plain-English descriptions for trouble codes
- Scaled units for self-test results (they are raw numbers today)
- Manufacturer-specific signals, defined in data files per vehicle (starting with Nissan)
- Faster sampling by batching several sensors into one request on CAN vehicles
- Markers drawn on the session charts
- Bluetooth LE adapters
- Comparing sessions side by side

## Contributing

Bug reports are especially useful right now. Please include your vehicle (year, make, model, engine), your adapter, and what the Settings tab shows under **Adapter**.

## License

[MIT](LICENSE)
