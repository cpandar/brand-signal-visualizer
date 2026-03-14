# ADR-003: Binary wire format over WebSocket

## Status
Accepted

## Context
The backend needs to transmit signal data to the browser over WebSocket. The two
main options are text-based JSON and binary encoding. For multi-channel neural data
(e.g. 192 × int8) this choice has meaningful cost implications.

## Options considered

**JSON**
- Human-readable, easy to debug with browser devtools
- No special handling needed on either end
- Encoding cost: a 192-sample int8 array encodes to ~576 bytes as JSON (`[0,1,-1,...]`)
  vs 192 bytes raw — 3× overhead in payload size
- `json.dumps` in Python and `JSON.parse` in the browser add CPU cost proportional
  to array size; at 60 Hz × 192 channels this is non-trivial

**Binary (MessagePack or raw ArrayBuffer)**
- Payload size equals the underlying data size (no ASCII encoding overhead)
- Python serialization is minimal (struct pack or direct memoryview)
- Browser receives an `ArrayBuffer`, constructs a typed array (`Int8Array`, `Float32Array`)
  directly — no parsing step, directly usable by uPlot and Canvas renderers
- Slightly harder to inspect in devtools, but stream metadata (stream name, timestamp,
  dtype, shape) can be sent as a small JSON header preceding the binary payload,
  or as a separate control message

## Decision
Binary wire format using raw `ArrayBuffer` messages. Control messages (stream manifest,
subscription acknowledgements, errors) remain JSON for readability. Data messages are
binary: a small fixed header (stream name length, dtype tag, shape) followed by the
raw sample bytes.

## Consequences
- The browser must know the dtype and shape to interpret the buffer correctly; this
  information is provided once in the stream manifest on connect and cached client-side.
- A simple message framing convention must be defined and kept in sync between Python
  and TypeScript (mitigated by keeping it minimal and well-documented).
- Debugging raw data frames requires a small devtools helper or logging flag.
