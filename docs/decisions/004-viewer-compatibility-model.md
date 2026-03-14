# ADR-004: Shape/dtype-based viewer compatibility, not stream-name-based

## Status
Accepted

## Context
The frontend needs to decide which viewer types to offer for a given stream, and which
to select as the default. Two approaches are possible: infer from the stream name, or
infer from the stream's data shape and dtype.

## Options considered

**Name-based inference**
- e.g. "if stream name contains 'spikes', offer raster; if it contains 'vel', offer
  time series"
- Brittle: breaks for any stream not following the naming convention
- Requires hard-coded rules per stream name — couples the display node to specific graphs
- Impossible to generalize to streams in graphs we haven't seen yet

**Shape/dtype-based inference**
- Rules derived from the intrinsic properties of the data:
  - 1–16 channels → time series (default); scatter available if exactly 2 channels
  - > 16 channels, int8/int16 → raster (default); heatmap available
  - > 16 channels, float32 → heatmap (default); raster available
  - Any signal → gauge available as override
- Works for any stream in any graph without configuration
- Stream name is never consulted for compatibility decisions

## Decision
Shape/dtype-based inference. Stream names are displayed as labels only. The optional
`display_hints` section in the graph YAML (see ADR-005) allows per-stream overrides
for cases where the inferred default is not ideal, without hard-coding names in the
display node itself.

## Consequences
- The stream manifest sent to the browser on connect must include dtype and shape for
  each field, not just the stream name.
- The dtype/shape inference heuristics need to be documented and kept in sync between
  the backend (which generates the manifest) and the frontend (which applies the rules).
- Edge cases (e.g. a 2-channel int8 stream that is a binary flag, not a neural signal)
  will get the "wrong" default but the user can toggle to the correct viewer type.
