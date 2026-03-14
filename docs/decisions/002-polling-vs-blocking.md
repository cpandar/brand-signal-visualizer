# ADR-002: Poll Redis at display rate, not per sample

## Status
Accepted

## Context
The display node needs to read from Redis streams continuously. The primary concern is
minimizing added overhead on the running graph — specifically, avoiding increased Redis
CPU load that could affect real-time nodes sharing the same Redis instance.

## Options considered

**Blocking XREAD per sample (`XREAD BLOCK 0`)**
- Redis wakes the display node on every new stream entry
- For a 1000 Hz stream, this is 1000 Redis wake-ups per second per stream
- For a 30 kHz raw neural stream (future support), this would be 30,000/second
- Redis CPU scales linearly with stream rate — unacceptable for high-rate streams
- Lowest possible display latency, but display latency is not the primary concern

**Periodic poll at display rate (~60 Hz)**
- One `XREAD COUNT <n> STREAMS <s1> <s2>...` call per frame, ~16 ms interval
- Reads all actively-viewed streams in a single Redis round-trip
- Redis overhead is bounded at ~60 calls/second regardless of stream rates
- Each call retrieves a batch (e.g. ~16 samples from a 1000 Hz stream)
- Display "latency" of up to ~16 ms — imperceptible for a monitoring tool
- When no browser is connected, no polls are issued at all

## Decision
Poll at display rate. The overhead model is predictable and bounded, and the display
latency tradeoff is irrelevant for a monitoring and debugging tool (as opposed to a
closed-loop node, where this would matter).

## Consequences
- Individual samples within a poll interval may arrive slightly out of phase with
  wall clock time, but will be displayed in correct relative order (Redis stream IDs
  are monotonically increasing).
- For viewer types that show individual events (raster), all events within the batch
  are rendered at their correct relative positions within the time window.
- If the browser tab is backgrounded (browser throttles JS to ~1 Hz), the poll loop
  should continue server-side to avoid backlog accumulation; only the rendering pauses.
