# brand-monitor

Real-time browser-based monitoring dashboard for [BRAND](https://github.com/brandbci/brand) graphs.

Runs as a standard BRAND graph node. Open `http://localhost:8765` in any browser while
a graph is running to monitor live signals and inspect graph structure without adding
meaningful overhead to the graph.

<img src="docs/images/signals-view.png" alt="Signal viewer showing live raster and time series plots" width="900">

<img src="docs/images/graph-view.png" alt="Graph view showing node topology with stream freshness indicators" width="900">

## Quick start

### 1. Add to your graph YAML

```yaml
nodes:
  - name: signal_visualizer
    nickname: signal_visualizer
    module: ../brand-modules/brand-monitor
    run_priority: 10
    parameters:
      port: 8765
      log: INFO
```

### 2. Build

```bash
make        # builds node + frontend (requires npm for frontend)
make node   # node only (no npm needed at runtime)
```

### 3. Run the graph

Start your graph normally with supervisor/booter. Then open:

```
http://localhost:8765
```

Click **+ Add Viewer**, select a stream and field, and choose a visualization type.

## Optional: display_hints in graph YAML

You can annotate streams with viewer hints. All existing tooling ignores this section.

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
```

## Frontend development

```bash
cd frontend
npm install
npm run dev     # starts Vite dev server with hot reload at http://localhost:5173
                # proxies /ws and /manifest to the running Python node on port 8765
```

## Architecture

See [docs/DESIGN.md](docs/DESIGN.md) for the full design document and
[docs/decisions/](docs/decisions/) for architecture decision records.

## Dependencies

Runtime: `fastapi`, `uvicorn`, `redis`, `numpy` (all present in the BRAND `rt` conda env
or installable via `pip install fastapi uvicorn`).

Frontend dev: Node.js 18+ and npm. Not required at runtime.
