# ADR-005: Optional `display_hints` section in graph YAML

## Status
Accepted

## Context
Auto-detection of viewer type from shape/dtype (ADR-004) covers most cases, but there
are situations where a human-readable annotation would improve the out-of-box experience:
named channel labels, explicit viewer overrides, or axis labels. We need a mechanism
to express these without coupling the display node to specific stream names.

## Options considered

**YAML comments**
- Zero implementation cost
- Not machine-readable — YAML parsers strip comments entirely
- Rejected

**Per-node `parameters` annotations**
- Each node in the graph YAML could annotate its own output streams within its
  `parameters` block
- Couples stream display hints to node configuration; harder to find and edit
- Requires every node to know about the display system
- Rejected

**New top-level `display_hints` section**
- An optional key at the top level of the graph YAML, alongside `nodes` and `parameters`
- BRAND's supervisor only reads `nodes`, `parameters`, `participant_id`, `graph_name`,
  and `session_description` — any unknown top-level key is silently ignored
- All existing tooling (supervisor, booter, notebooks) continues to work unchanged
- The display node reads this section at startup if present; falls back to auto-detection
  if absent
- Entirely opt-in: existing graphs require no modification

## Decision
New optional top-level `display_hints` section. Format:

```yaml
display_hints:
  <stream_name>:
    <field_name>:
      viewer: <type>               # optional: override default viewer type
      channel_labels: [...]        # optional: per-channel names for raster/heatmap
      y_label: "..."               # optional: y-axis label
      x_label: "..."               # optional: x-axis label (usually "Time (s)")
```

All keys within a hint are optional. The section itself is optional.

## Consequences
- The display node must parse the graph YAML at startup, which BRAND nodes already
  do to receive their own parameters — no new file access pattern required.
- The hint schema is intentionally minimal; anything more complex (color scales,
  axis ranges, layout) should be configured interactively in the browser.
- Future hint keys can be added without breaking existing graphs or tooling.
