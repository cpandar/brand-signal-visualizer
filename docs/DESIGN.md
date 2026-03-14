# brand-signal-visualizer — Design Document

## Overview

`brand-signal-visualizer` is a BRAND graph node that provides real-time browser-based
visualization of signals flowing through a BRAND graph. It runs as a standard node
alongside other graph nodes, reads from Redis streams, and serves a React/TypeScript
dashboard accessible at a localhost URL. Users can add multiple signal viewers,
each displaying a live stream, without meaningfully impacting the running graph.

## Goals

- Allow any Redis stream in a running BRAND graph to be visualized in a browser
- Add negligible computational overhead to the graph (the display node is a passive observer)
- Require no additional hardware — runs on the same machine as the graph
- Support multiple simultaneous viewers, each independently configured
- Be extensible to new signal types and viewer types without hard-coded stream names

## Non-Goals

- Recording or saving data (that is handled by the graph and NWB pipeline)
- Replacing the task display (e.g. `display_centerOut`) — this is a debugging/monitoring tool
- Providing closed-loop feedback into the graph
- Real-time analysis or processing of signals

---

## Architecture

```mermaid
flowchart TB
    subgraph graph["BRAND Graph (existing nodes)"]
        MA[mouseAdapter] -->|mouse_vel| R
        TU[thresholds_udp] -->|threshold_values| R
        BM[bin_multiple] -->|binned_spikes| R
        WF[wiener_filter] -->|wiener_filter| R
        R[(Redis Streams)]
    end

    subgraph viz["brand-signal-visualizer node"]
        R -->|"XREAD poll @ ~60 Hz\n(all active streams, one call)"| PY["Python Node\nFastAPI + asyncio"]
        PY -->|"HTTP — serves static files"| FE["React/TypeScript\nFrontend Build"]
        PY <-->|WebSocket| BR["Browser Dashboard"]
        FE -.->|"loaded once on open"| BR
    end

    subgraph browser["Browser (multiple viewers)"]
        BR --> V1["Viewer: wiener_filter\n(time series)"]
        BR --> V2["Viewer: binned_spikes\n(raster)"]
        BR --> V3["Viewer: mouse_vel\n(time series)"]
    end
```

The display node has two responsibilities:

1. **Redis bridge**: Polls all actively-viewed streams at display rate (~60 Hz) using a
   single batched `XREAD` call, then pushes new data to connected WebSocket clients.
2. **Static file server**: Serves the pre-built React frontend over HTTP so no separate
   web server is required.

---

## Backend

**Language and framework:** Python with FastAPI. This fits naturally into the BRAND
ecosystem (Python throughout, `redis-py` already a dependency) and FastAPI provides
clean async WebSocket support.

**Polling strategy:** The background thread calls `XREAD COUNT <n> STREAMS <s1> <s2>...`
once per display frame (~16 ms), reading all actively-viewed streams in a single Redis
round-trip. This bounds Redis overhead at ~60 calls/second regardless of the native
sample rate of any stream. For a 1000 Hz stream this means reading ~16 samples per
poll in one batch; for a 100 Hz stream, ~1–2 samples per poll.

No streams are polled if no browser is connected, and only streams with active viewers
are included in each poll. When the last viewer for a stream is closed, that stream
is dropped from the poll list immediately.

**Wire format:** Binary (MessagePack or raw ArrayBuffers) rather than JSON for
multi-channel data. See ADR-003.

**Configuration (graph YAML `parameters` block):**
```yaml
- name: signal_visualizer
  nickname: signal_visualizer
  module: ../brand-modules/brand-signal-visualizer
  run_priority: 10          # deliberately low — not a real-time node
  parameters:
    port: 8765
    redis_host: localhost   # supports remote Redis for separate-machine use
    log: INFO
```

`run_priority: 10` ensures the OS scheduler deprioritizes this node relative to
real-time graph nodes (which typically run at priority 99).

---

## Frontend

**Stack:** React + TypeScript, built with Vite, committed as a pre-built static bundle
so users do not need `npm` to run the node. `npm` is a dev-time dependency only.

**Dashboard:** A free-form grid of viewer cards. Each card has:
- A header showing stream name, field, current sample rate, and viewer type selector
- The visualization area
- A close button

**Add Viewer flow:**
1. User opens "Add Viewer" dialog
2. Backend sends a stream manifest on connect (stream names, field names, dtype, shape,
   approximate current rate — inferred from the last Redis entry)
3. User selects a stream and field
4. Frontend pre-selects the default viewer type based on shape/dtype rules (see below)
5. User can override the viewer type before confirming
6. Viewer appears; type can be changed at any time via the card toolbar

**Viewer types (MVP):**

| Type | Compatible when | Default for |
|---|---|---|
| Time series | Any signal, ≤ ~16 channels | 1–16 ch float or int |
| Raster | Multi-channel, int/binary-ish | > 16 ch int8/int16 |
| Heatmap | Multi-channel, continuous | > 16 ch float |
| Scatter / 2D | Exactly 2 channels, continuous | — (optional override) |
| Gauge | Any, 1 channel | — (optional override) |

Viewer type is determined by signal shape and dtype — **never by stream name**.
Switching type is a frontend-only operation with no backend round-trip.

**Charting libraries:**
- Time series and scatter: [uPlot](https://github.com/leeoniya/uPlot) — purpose-built
  for high-frequency time series, handles large typed arrays at 60 fps efficiently
- Raster and heatmap: direct Canvas 2D API rendering for performance

---

## Signal Types in the Simulator Graphs

| Stream | Shape | dtype | Rate | Default viewer |
|---|---|---|---|---|
| `mouse_vel` | 3 | int16 | 200 Hz | Time series |
| `firing_rates` | 192 | float32 | 200 Hz | Heatmap |
| `threshold_values` | 192 | int8 | 1000 Hz | Raster |
| `binned_spikes` | 192 | int8 | 100 Hz | Raster |
| `wiener_filter` | 2 | float32 | 100 Hz | Time series |
| `control` | 2 | float32 | 100 Hz | Time series |
| `cursorData` | 2 | float32 | task-driven | Time series |
| `targetData` | 2 | float32 | task-driven | Time series |

---

## Graph YAML Integration

The node is added to any graph YAML like any other node. An optional top-level
`display_hints` section can annotate streams with viewer overrides and channel labels.
All existing tooling ignores this section; it is purely advisory for the display node.

```yaml
display_hints:
  binned_spikes:
    samples:
      viewer: raster
      y_label: "Channel"
  wiener_filter:
    samples:
      viewer: timeseries
      channel_labels: ["vel_x", "vel_y"]
  firing_rates:
    samples:
      viewer: heatmap
      y_label: "Neuron"
```

If `display_hints` is absent, defaults are inferred from shape and dtype.

---

## Computational Overhead Strategy

The display node is designed to be a **rate-limited passive observer**:

- One `XREAD` call per display frame covers all active streams simultaneously
- Polls only streams with active browser viewers; idles completely when no browser is connected
- Runs at low OS scheduler priority (`run_priority: 10` vs 99 for real-time nodes)
- Does not use `SCHED_FIFO` — standard `SCHED_OTHER` only
- Wire format is binary to minimize serialization CPU cost
- No stream entries are acknowledged or consumed (no consumer groups) — purely read-only,
  no effect on stream trimming or other consumers

---

## MVP Scope

- [ ] Python node: FastAPI server, WebSocket endpoint, Redis polling loop
- [ ] Stream manifest endpoint (auto-discover available streams on connect)
- [ ] Time series viewer (uPlot, scrolling window, configurable duration)
- [ ] Raster viewer (Canvas 2D, configurable time window)
- [ ] Add/remove viewers dynamically
- [ ] Viewer type toggle (frontend only)
- [ ] `display_hints` parsing from graph YAML
- [ ] macOS + Linux support (follows patterns established in brand-tutorial porting)
- [ ] Pre-built React bundle committed to repo

## Future / Post-MVP

- Heatmap viewer
- Scatter / 2D viewer
- Gauge viewer
- Viewer layout persistence (survive browser refresh)
- Data backfill on viewer open (last N seconds from Redis stream history)
- Remote Redis support (separate machine monitoring)
- npm-based build step integrated into repo Makefile

---

## Open Questions (TBD)

- **Backfill on viewer open**: When a viewer is added mid-session, should it receive
  historical data from the Redis stream (Redis stores a configurable history), or only
  live data going forward? Backfill improves usability but adds complexity.
- **Viewer state persistence**: Should configured viewers survive a browser refresh?
  (Browser `localStorage` is available since this is a standalone app, not an artifact.)
- **npm as dev dependency**: Is npm acceptable as a requirement for frontend development?
  The pre-built bundle avoids it at runtime, but contributors modifying the frontend need it.
- **Repo location**: Standalone `brandbci/brand-signal-visualizer` repo (preferred) vs
  adding to an existing `brand-modules` repo.
