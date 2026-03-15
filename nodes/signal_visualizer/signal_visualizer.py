"""
signal_visualizer.py — BRAND node for real-time browser-based signal visualization.

Runs a FastAPI server that:
  - Serves a pre-built React frontend (nodes/signal_visualizer/static/)
  - Exposes a WebSocket endpoint that bridges Redis streams to the browser
  - Polls all actively-viewed Redis streams at display rate (~60 Hz) using a
    single batched XREAD call, to minimize overhead on the running graph

Graph YAML parameters:
  port        (int, default 8765)  HTTP/WebSocket port
  redis_host  (str, default localhost)  Redis host (supports remote monitoring)
  log         (str, default INFO)  Log level
"""

import asyncio
import json
import logging
import struct
import sys
from pathlib import Path
from typing import Dict, Optional, Set

import numpy as np
import yaml
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, str(Path(__file__).parents[4] / 'brand' / 'lib' / 'python'))
from brand import BRANDNode  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POLL_INTERVAL_S = 1.0 / 60.0  # 60 Hz poll rate

DTYPE_TAG: Dict[str, int] = {
    'int8': 0, 'int16': 1, 'float32': 2, 'float64': 3
}
DTYPE_FROM_TAG: Dict[int, type] = {
    0: np.int8, 1: np.int16, 2: np.float32, 3: np.float64
}
DTYPE_ITEMSIZE: Dict[int, int] = {0: 1, 1: 2, 2: 4, 3: 8}

SKIP_STREAMS = {'supergraph_stream', 'supervisor_ipstream'}
SKIP_FIELDS = {'ts', 'sync'}

STATIC_DIR = Path(__file__).parent / 'static'


# ---------------------------------------------------------------------------
# WebSocket connection + subscription manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    """Tracks active WebSocket connections and per-(stream, field) subscriptions."""

    def __init__(self):
        self.connections: Set[WebSocket] = set()
        # subscriptions[stream][field] -> set of WebSocket clients
        self.subscriptions: Dict[str, Dict[str, Set[WebSocket]]] = {}
        # last Redis ID read per stream (start from '$' = current tail)
        self.last_ids: Dict[str, str] = {}

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.add(ws)
        logging.info('Browser client connected')

    def disconnect(self, ws: WebSocket, latency_subscribers: Optional[Set] = None):
        self.connections.discard(ws)
        for stream_subs in self.subscriptions.values():
            for field_subs in stream_subs.values():
                field_subs.discard(ws)
        if latency_subscribers is not None:
            latency_subscribers.discard(ws)
        logging.info('Browser client disconnected')

    def subscribe(self, ws: WebSocket, stream: str, field: str, last_id: str = '0-0'):
        self.subscriptions.setdefault(stream, {}).setdefault(field, set()).add(ws)
        # Only set last_id if this stream is brand new — don't overwrite an
        # already-running poll cursor
        if stream not in self.last_ids:
            self.last_ids[stream] = last_id
        logging.info(f'Subscribed to {stream}/{field}')

    def unsubscribe(self, ws: WebSocket, stream: str, field: str):
        try:
            self.subscriptions[stream][field].discard(ws)
        except KeyError:
            pass

    def active_streams(self) -> Dict[str, str]:
        """Return {stream: last_id} for streams that have at least one subscriber."""
        active = {}
        for stream, fields in self.subscriptions.items():
            if any(len(subs) > 0 for subs in fields.values()):
                active[stream] = self.last_ids.get(stream, '$')
        return active

    def subscribed_fields(self, stream: str) -> Set[str]:
        """Return field names that have active subscribers for a given stream."""
        result = set()
        for field, subs in self.subscriptions.get(stream, {}).items():
            if subs:
                result.add(field)
        return result

    async def broadcast(self, stream: str, field: str, payload: bytes):
        dead: Set[WebSocket] = set()
        for ws in self.subscriptions.get(stream, {}).get(field, set()):
            try:
                await ws.send_bytes(payload)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.disconnect(ws)


# ---------------------------------------------------------------------------
# Binary message packing
# ---------------------------------------------------------------------------

def pack_data_message(stream: str, field: str, dtype_tag: int,
                      entries) -> Optional[bytes]:
    """
    Pack a batch of Redis stream entries into a binary WebSocket message.

    Wire format (little-endian):
      0x01                        1 byte   message type
      stream_name_len             1 byte
      stream_name                 N bytes  UTF-8
      field_name_len              1 byte
      field_name                  M bytes  UTF-8
      dtype_tag                   1 byte   (0=int8,1=int16,2=float32,3=float64)
      n_channels                  4 bytes  uint32
      n_samples                   4 bytes  uint32
      timestamps (ms)             n_samples * 8 bytes  uint64
      data (channels-first)       n_channels * n_samples * itemsize bytes
    """
    dtype_np = DTYPE_FROM_TAG[dtype_tag]
    field_b = field.encode('utf-8')

    samples = []
    timestamps = []
    for entry_id, fields in entries:
        raw = fields.get(field_b)
        if raw is None:
            continue
        arr = np.frombuffer(raw, dtype=dtype_np)
        samples.append(arr)
        ts_ms = int(entry_id.decode().split('-')[0])
        timestamps.append(ts_ms)

    if not samples:
        return None

    try:
        data = np.stack(samples, axis=-1)  # (n_channels, n_samples)
    except ValueError:
        # Samples have inconsistent shapes — skip this batch
        return None

    n_channels, n_samples = data.shape
    stream_b = stream.encode('utf-8')
    ts_arr = np.array(timestamps, dtype=np.uint64)

    buf = bytearray()
    buf.append(0x01)
    buf.append(len(stream_b))
    buf.extend(stream_b)
    buf.append(len(field_b))
    buf.extend(field_b)
    buf.append(dtype_tag)
    buf.extend(struct.pack('<II', n_channels, n_samples))
    buf.extend(ts_arr.tobytes())
    buf.extend(data.tobytes())
    return bytes(buf)


# ---------------------------------------------------------------------------
# dtype inference
# ---------------------------------------------------------------------------

def infer_dtype(sample_bytes: bytes, n_bytes: int) -> str:
    """
    Heuristically infer the dtype of a stream field from its raw bytes.

    Strategy:
    - If divisible by 4 and n_bytes/4 <= 16: try float32 (small-channel decoded output)
    - If divisible by 4 and values look like valid floats: float32
    - If divisible by 2 and n_bytes/2 <= 16: int16
    - Otherwise: int8
    """
    if n_bytes == 0:
        return 'int8'

    # Small float candidates (e.g. 2-channel decoder output = 8 bytes)
    if n_bytes % 4 == 0:
        n_chan = n_bytes // 4
        if n_chan <= 16:
            arr = np.frombuffer(sample_bytes, dtype=np.float32)
            if np.all(np.isfinite(arr)) and np.any(arr != 0):
                return 'float32'

    # Larger float candidates (e.g. 192-channel firing rates = 768 bytes)
    if n_bytes % 4 == 0 and n_bytes >= 256:
        arr = np.frombuffer(sample_bytes, dtype=np.float32)
        if np.all(np.isfinite(arr)):
            return 'float32'

    # Small int16 (e.g. 3-channel mouse = 6 bytes)
    if n_bytes % 2 == 0 and (n_bytes // 2) <= 16:
        return 'int16'

    return 'int8'


# ---------------------------------------------------------------------------
# BRAND node
# ---------------------------------------------------------------------------

class SignalVisualizerNode(BRANDNode):

    def __init__(self):
        super().__init__()
        self.port = int(self.parameters.get('port', 8765))
        self.display_hints: dict = {}
        self.manager = ConnectionManager()
        # dtype cache: (stream, field) -> dtype_tag
        self._dtype_cache: Dict[tuple, int] = {}
        self._server: Optional[uvicorn.Server] = None
        self._shutdown = False
        # Latency service state
        self._topology: Optional[dict] = None          # cached after first get_graph
        self._latency_subscribers: Set[WebSocket] = set()
        self._latency_history: Dict[str, list] = {}    # node_nickname -> [latency_ms, ...]
        LATENCY_HISTORY_MAX = 1200                      # 2 min × 10 Hz
        self._LATENCY_HISTORY_MAX = LATENCY_HISTORY_MAX

    # ------------------------------------------------------------------
    # Graph YAML helpers
    # ------------------------------------------------------------------

    def _load_display_hints(self):
        """Read display_hints from the supergraph YAML if present."""
        try:
            entries = self.r.xrange('supergraph_stream', '-', '+', count=1)
            if entries:
                raw = entries[-1][1].get(b'data')
                if raw is None:
                    return
                text = raw.decode('utf-8')
                try:
                    data = json.loads(text)
                    if isinstance(data, str):
                        data = yaml.safe_load(data)
                except json.JSONDecodeError:
                    data = yaml.safe_load(text)
                if isinstance(data, dict):
                    self.display_hints = data.get('display_hints', {})
                    logging.info(f'Loaded display_hints for streams: '
                                 f'{list(self.display_hints.keys())}')
        except Exception as e:
            logging.warning(f'Could not load display_hints: {e}')

    # ------------------------------------------------------------------
    # Stream manifest
    # ------------------------------------------------------------------

    def _suggest_viewer(self, dtype_str: str, n_channels: int) -> str:
        if n_channels <= 16:
            return 'timeseries'
        if dtype_str in ('int8', 'int16'):
            return 'raster'
        return 'heatmap'

    def _estimate_rate_hz(self, stream: str) -> float:
        try:
            entries = self.r.xrevrange(stream, '+', '-', count=100)
            if len(entries) < 2:
                return 0.0
            t_new = int(entries[0][0].decode().split('-')[0])
            t_old = int(entries[-1][0].decode().split('-')[0])
            dt_ms = t_new - t_old
            if dt_ms <= 0:
                return 0.0
            return round((len(entries) - 1) / (dt_ms / 1000.0), 1)
        except Exception:
            return 0.0

    def _build_manifest(self) -> dict:
        """
        Auto-discover all Redis streams and infer field properties.
        Returns a nested dict: {stream_name: {field_name: StreamField}}.
        """
        manifest = {}
        try:
            for key in self.r.keys('*'):
                stream = key.decode('utf-8')
                if stream in SKIP_STREAMS or stream.endswith('_state'):
                    continue
                try:
                    if self.r.type(key).decode() != 'stream':
                        continue
                    entries = self.r.xrevrange(stream, '+', '-', count=1)
                    if not entries:
                        continue
                    _, fields = entries[0]
                    stream_info = {}
                    rate = self._estimate_rate_hz(stream)
                    for fk, fv in fields.items():
                        fname = fk.decode('utf-8')
                        if fname in SKIP_FIELDS:
                            continue
                        n_bytes = len(fv)
                        dtype_str = infer_dtype(fv, n_bytes)
                        n_channels = n_bytes // np.dtype(dtype_str).itemsize
                        hints = (self.display_hints
                                 .get(stream, {})
                                 .get(fname, {}))
                        if 'dtype' in hints:
                            dtype_str = hints['dtype']
                            n_channels = n_bytes // np.dtype(dtype_str).itemsize
                        suggested = hints.get(
                            'viewer',
                            self._suggest_viewer(dtype_str, n_channels)
                        )
                        # cache dtype for use in polling
                        self._dtype_cache[(stream, fname)] = DTYPE_TAG.get(dtype_str, 0)
                        stream_info[fname] = {
                            'dtype': dtype_str,
                            'n_channels': n_channels,
                            'approx_rate_hz': rate,
                            'suggested_viewer': suggested,
                            'hints': hints,
                        }
                    if stream_info:
                        manifest[stream] = stream_info
                except Exception:
                    continue
        except Exception as e:
            logging.error(f'Error building manifest: {e}')
        return manifest

    # ------------------------------------------------------------------
    # Polling loop
    # ------------------------------------------------------------------

    async def _polling_loop(self):
        """
        Core polling loop: one XREAD per display frame covering all active streams.
        Runs as a background asyncio task alongside the uvicorn server.
        """
        r = self.r  # redis-py client (sync) — acceptable in asyncio with care
        manager = self.manager

        while not self._shutdown:
            t_start = asyncio.get_event_loop().time()

            active = manager.active_streams()
            if active:
                try:
                    # Single XREAD covering all active streams
                    results = r.xread(
                        {s: i for s, i in active.items()},
                        count=200  # max samples per stream per poll
                    )
                    if results:
                        for stream_key, entries in results:
                            stream = stream_key.decode()
                            if entries:
                                manager.last_ids[stream] = entries[-1][0].decode()
                            for field in manager.subscribed_fields(stream):
                                dtype_tag = self._dtype_cache.get((stream, field), 0)
                                msg = pack_data_message(stream, field, dtype_tag, entries)
                                if msg:
                                    await manager.broadcast(stream, field, msg)
                except Exception as e:
                    logging.error(f'Polling error: {e}')

            elapsed = asyncio.get_event_loop().time() - t_start
            await asyncio.sleep(max(0.0, POLL_INTERVAL_S - elapsed))

    # ------------------------------------------------------------------
    # FastAPI app
    # ------------------------------------------------------------------

    def _build_app(self) -> FastAPI:
        app = FastAPI(title='brand-signal-visualizer')
        manager = self.manager
        node = self

        @app.get('/manifest')
        async def get_manifest():
            return JSONResponse(node._build_manifest())

        @app.websocket('/ws')
        async def ws_endpoint(ws: WebSocket):
            await manager.connect(ws)
            # Send manifest immediately on connect
            try:
                manifest = node._build_manifest()
                await ws.send_json({'type': 'manifest', 'streams': manifest})
            except Exception as e:
                logging.warning(f'Could not send manifest: {e}')

            try:
                while True:
                    msg = await ws.receive_json()
                    await node._handle_message(ws, msg)
            except WebSocketDisconnect:
                manager.disconnect(ws, node._latency_subscribers)
            except Exception as e:
                logging.error(f'WebSocket error: {e}')
                manager.disconnect(ws, node._latency_subscribers)

        # Serve React frontend
        if STATIC_DIR.exists():
            @app.get('/')
            async def index():
                return FileResponse(str(STATIC_DIR / 'index.html'))

            app.mount('/assets', StaticFiles(directory=str(STATIC_DIR / 'assets')),
                      name='assets')
        else:
            @app.get('/')
            async def no_frontend():
                return JSONResponse({
                    'status': 'running',
                    'message': (
                        'Frontend not built. Run `make frontend` in the repo root. '
                        'WebSocket available at /ws.'
                    )
                })

        return app

    # ------------------------------------------------------------------
    # Graph topology
    # ------------------------------------------------------------------

    def _find_stream_refs(self, params: object, known_streams: set) -> dict:
        """
        Recursively walk a parameters object and collect values that match
        known Redis stream names. Uses the parameter key name as a
        directional hint (in/out) when possible.
        """
        in_streams: list = []
        out_streams: list = []

        IN_HINTS  = ('in_', 'input', 'read', 'source', 'from', 'listen')
        OUT_HINTS = ('out_', 'output', 'write', 'dest', 'sink', 'publish', 'send')

        def walk(obj, key: str = ''):
            key_l = key.lower()
            if isinstance(obj, str) and obj in known_streams:
                if any(h in key_l for h in OUT_HINTS):
                    out_streams.append(obj)
                elif any(h in key_l for h in IN_HINTS):
                    in_streams.append(obj)
                else:
                    # Ambiguous key — add to both; cross-node pass will resolve
                    in_streams.append(obj)
                    out_streams.append(obj)
            elif isinstance(obj, list):
                for item in obj:
                    walk(item, key)
            elif isinstance(obj, dict):
                for k, v in obj.items():
                    walk(v, k)

        walk(params)
        return {'in': in_streams, 'out': out_streams}

    def _build_graph_topology(self) -> dict:
        """
        Build a graph topology snapshot from supergraph_stream and live Redis streams.
        Returns a dict compatible with the graph_topology WebSocket message.
        """
        topology: dict = {'nodes': [], 'edges': [], 'streams': {}}

        # 1. Read supergraph YAML from Redis
        logging.info('[get_graph] Reading supergraph_stream …')
        try:
            entries = self.r.xrange('supergraph_stream', '-', '+', count=1)
            if not entries:
                logging.warning('supergraph_stream is empty — graph topology unavailable')
                return topology
            raw = entries[-1][1].get(b'data')
            if raw is None:
                # Fall back to first available field
                raw = next(iter(entries[-1][1].values()), None)
            if raw is None:
                return topology
            # BRAND supervisor may store the supergraph in several formats:
            #   (a) JSON-encoded dict  → json.loads returns dict directly
            #   (b) JSON-encoded str of YAML text → json.loads returns str, then yaml.safe_load
            #   (c) Raw YAML bytes → json.loads throws, fall back to yaml.safe_load
            text = raw.decode('utf-8')
            try:
                graph_data = json.loads(text)
                if isinstance(graph_data, str):
                    # Case (b): double-encoded — json gave us the YAML text
                    graph_data = yaml.safe_load(graph_data)
            except json.JSONDecodeError:
                # Case (c): raw YAML
                graph_data = yaml.safe_load(text)
            if not isinstance(graph_data, dict):
                logging.error(f'supergraph_stream data parsed to unexpected type: '
                              f'{type(graph_data)}')
                return topology
        except Exception as e:
            logging.error(f'Could not read supergraph_stream: {e}')
            return topology

        # 2. Enumerate all live Redis streams
        known_streams: set = set()
        try:
            for key in self.r.keys('*'):
                k = key.decode('utf-8')
                try:
                    if self.r.type(key).decode() == 'stream':
                        known_streams.add(k)
                except Exception:
                    pass
        except Exception as e:
            logging.warning(f'Could not enumerate Redis streams: {e}')

        logging.info(f'[get_graph] supergraph_stream OK — '
                     f'top-level keys: {list(graph_data.keys())}')

        # 3. Build stream schemas (reuse manifest logic, suppresses SKIP_STREAMS)
        logging.info('[get_graph] Building manifest …')
        topology['streams'] = self._build_manifest()
        logging.info(f'[get_graph] Manifest built — {len(topology["streams"])} streams')

        # 4. First pass — collect stream refs per node
        nodes_raw = graph_data.get('nodes', [])
        if nodes_raw is None:
            nodes_raw = []
        logging.info(f'[get_graph] nodes_raw type={type(nodes_raw).__name__}, '
                     f'len={len(nodes_raw) if hasattr(nodes_raw, "__len__") else "N/A"}')
        if nodes_raw and not isinstance(nodes_raw, list):
            logging.warning(f'[get_graph] nodes_raw is not a list — '
                            f'value preview: {str(nodes_raw)[:200]}')
            nodes_raw = list(nodes_raw.values()) if isinstance(nodes_raw, dict) else []

        node_refs: dict = {}
        for i, node in enumerate(nodes_raw):
            if not isinstance(node, dict):
                logging.warning(f'[get_graph] node[{i}] is {type(node).__name__}, '
                                f'not dict — skipping. Value: {str(node)[:100]}')
                continue
            nickname = node.get('nickname') or node.get('name', '')
            params   = node.get('parameters') or {}
            refs     = self._find_stream_refs(params, known_streams)
            node_refs[nickname] = refs

        # 5. Cross-node resolution pass
        # If stream S appears unambiguously as output of any node, remove it
        # from 'in' lists where it was only found due to ambiguous key names.
        definite_outputs: set = set()
        for refs in node_refs.values():
            for s in refs.get('out', []):
                definite_outputs.add(s)

        # 6. Build node records
        for node in nodes_raw:
            if not isinstance(node, dict):
                continue
            nickname = node.get('nickname') or node.get('name', '')
            params   = node.get('parameters') or {}
            refs     = node_refs.get(nickname, {'in': [], 'out': []})

            # Deduplicate, preserving order
            in_s  = list(dict.fromkeys(refs.get('in',  [])))
            out_s = list(dict.fromkeys(refs.get('out', [])))

            topology['nodes'].append({
                'nickname':     nickname,
                'name':         node.get('name', nickname),
                'module':       node.get('module', ''),
                'machine':      node.get('machine') or '',
                'run_priority': node.get('run_priority', 0),
                'in_streams':   in_s,
                'out_streams':  out_s,
                'parameters':   params,
            })

        # 7. Build edges: A → stream → B when stream is in A's out AND B's in
        seen: set = set()
        for node_a in topology['nodes']:
            for stream in node_a['out_streams']:
                for node_b in topology['nodes']:
                    if node_b['nickname'] == node_a['nickname']:
                        continue
                    if stream in node_b['in_streams']:
                        key = (node_a['nickname'], node_b['nickname'], stream)
                        if key not in seen:
                            topology['edges'].append({
                                'from':   node_a['nickname'],
                                'to':     node_b['nickname'],
                                'stream': stream,
                            })
                            seen.add(key)

        return topology

    # ------------------------------------------------------------------
    # Latency / freshness service
    # ------------------------------------------------------------------

    async def _latency_loop(self):
        """
        10 Hz background loop that computes stream freshness and per-node
        processing latency, then pushes latency_update messages to all
        subscribed WebSocket clients.
        """
        INTERVAL = 0.1  # 10 Hz

        while not self._shutdown:
            t_start = asyncio.get_event_loop().time()

            if self._latency_subscribers and self._topology:
                try:
                    update = self._compute_latency_update()
                    if update and self._latency_subscribers:
                        payload = json.dumps(update,
                                             default=lambda o: float(o)
                                             if hasattr(o, '__float__') else str(o))
                        dead: Set[WebSocket] = set()
                        for ws in list(self._latency_subscribers):
                            try:
                                await ws.send_text(payload)
                            except Exception:
                                dead.add(ws)
                        self._latency_subscribers -= dead
                except Exception as e:
                    logging.error(f'[latency_loop] Error: {e}', exc_info=True)

            elapsed = asyncio.get_event_loop().time() - t_start
            await asyncio.sleep(max(0.0, INTERVAL - elapsed))

    def _compute_latency_update(self) -> Optional[dict]:
        """
        Compute one latency snapshot from Redis and return the latency_update dict.
        Called from _latency_loop at 10 Hz.
        """
        import time as _time
        now_ms = _time.time() * 1000.0

        topo = self._topology
        if not topo:
            return None

        # --- 1. Collect latest Redis timestamps for every relevant stream ---
        # Fetch the two most recent entries per stream to compute both the latest
        # timestamp and the inter-sample interval (for jitter/freshness threshold).
        all_streams: Set[str] = set()
        for node in topo.get('nodes', []):
            for s in node.get('in_streams', []):
                all_streams.add(s)
            for s in node.get('out_streams', []):
                all_streams.add(s)

        stream_latest_ms: Dict[str, float] = {}    # stream -> ms of latest entry
        stream_interval_ms: Dict[str, float] = {}  # stream -> inter-sample ms

        for stream in all_streams:
            try:
                entries = self.r.xrevrange(stream, '+', '-', count=2)
                if not entries:
                    continue
                t0 = int(entries[0][0].decode().split('-')[0])
                stream_latest_ms[stream] = float(t0)
                if len(entries) >= 2:
                    t1 = int(entries[1][0].decode().split('-')[0])
                    interval = abs(t0 - t1)
                    if interval > 0:
                        stream_interval_ms[stream] = float(interval)
            except Exception:
                continue

        # --- 2. Freshness per stream ---
        freshness: Dict[str, float] = {}
        for stream, latest_ms in stream_latest_ms.items():
            freshness[stream] = round(now_ms - latest_ms, 2)

        # --- 3. Per-node latency and jitter ---
        latency_new: Dict[str, float] = {}   # nickname -> latest latency_ms
        jitter: Dict[str, float] = {}         # nickname -> interval std_ms

        for node in topo.get('nodes', []):
            nickname = node.get('nickname', '')
            in_streams  = [s for s in node.get('in_streams',  []) if s in stream_latest_ms]
            out_streams = [s for s in node.get('out_streams', []) if s in stream_latest_ms]

            if not in_streams or not out_streams:
                continue

            latest_in  = max(stream_latest_ms[s] for s in in_streams)
            # For multi-output, take the minimum latency (earliest output)
            latest_out = min(stream_latest_ms[s] for s in out_streams)

            lat = latest_out - latest_in
            if -50 < lat < 60_000:  # sanity range: ignore obviously bogus values
                latency_new[nickname] = round(lat, 2)

                # Accumulate history
                hist = self._latency_history.setdefault(nickname, [])
                hist.append(lat)
                if len(hist) > self._LATENCY_HISTORY_MAX:
                    hist.pop(0)

            # Jitter: std dev of inter-sample intervals on primary output stream
            primary_out = out_streams[0]
            if primary_out in stream_interval_ms:
                # We only have one interval per stream per tick; use running
                # std dev over the last 20 interval samples stored separately.
                jitter[nickname] = round(stream_interval_ms[primary_out], 2)

        # --- 4. Critical path: longest cumulative latency sum ---
        critical_path_ms = 0.0
        critical_path_nodes: list = []
        edges = topo.get('edges', [])
        nodes_by_nick = {n['nickname']: n for n in topo.get('nodes', [])}

        if latency_new and edges:
            # Build adjacency for path finding
            adj: Dict[str, list] = {n: [] for n in nodes_by_nick}
            for e in edges:
                if e['from'] in adj:
                    adj[e['from']].append(e['to'])

            # DFS to find heaviest path by cumulative latency
            def dfs(node_name: str, path: list, acc: float):
                nonlocal critical_path_ms, critical_path_nodes
                new_acc = acc + latency_new.get(node_name, 0.0)
                new_path = path + [node_name]
                if new_acc > critical_path_ms:
                    critical_path_ms = new_acc
                    critical_path_nodes = new_path
                for nxt in adj.get(node_name, []):
                    dfs(nxt, new_path, new_acc)

            sources = [n for n in nodes_by_nick if not any(
                e['to'] == n for e in edges)]
            for src in sources:
                dfs(src, [], 0.0)

        return {
            'type':                 'latency_update',
            't':                    round(now_ms / 1000.0, 3),
            'freshness':            freshness,
            'latency':              latency_new,
            'jitter':               jitter,
            'critical_path_ms':     round(critical_path_ms, 2),
            'critical_path_nodes':  critical_path_nodes,
        }

    async def _handle_message(self, ws: WebSocket, msg: dict):
        mtype = msg.get('type')
        if mtype == 'get_manifest':
            manifest = self._build_manifest()
            await ws.send_json({'type': 'manifest', 'streams': manifest})
        elif mtype == 'subscribe':
            stream = msg.get('stream', '')
            field = msg.get('field', '')
            if stream and field:
                # Resolve the current last entry ID so the polling loop starts
                # from "now" rather than replaying all history. Using '$' with
                # non-blocking XREAD always returns nothing; we need the actual ID.
                last_id = '0-0'
                try:
                    entries = self.r.xrevrange(stream, '+', '-', count=1)
                    if entries:
                        last_id = entries[0][0].decode()
                except Exception:
                    pass
                self.manager.subscribe(ws, stream, field, last_id=last_id)
                await ws.send_json({'type': 'subscribed', 'stream': stream, 'field': field})
        elif mtype == 'unsubscribe':
            stream = msg.get('stream', '')
            field = msg.get('field', '')
            if stream and field:
                self.manager.unsubscribe(ws, stream, field)
        elif mtype == 'get_graph':
            try:
                topo = self._build_graph_topology()
                self._topology = topo   # cache for latency service
                logging.info(f'[get_graph] Built topology: '
                             f'{len(topo["nodes"])} nodes, {len(topo["edges"])} edges')
                payload = json.dumps({'type': 'graph_topology', **topo},
                                     default=lambda o: int(o) if hasattr(o, '__index__')
                                     else float(o) if hasattr(o, '__float__')
                                     else str(o))
                await ws.send_text(payload)
                logging.info('[get_graph] graph_topology sent successfully')
            except Exception as e:
                logging.error(f'[get_graph] Failed to build/send graph topology: {e}',
                              exc_info=True)
                try:
                    await ws.send_json({'type': 'graph_topology',
                                        'nodes': [], 'edges': [], 'streams': {},
                                        'error': str(e)})
                except Exception:
                    pass
        elif mtype == 'subscribe_graph_latency':
            self._latency_subscribers.add(ws)
            logging.info(f'[latency] Client subscribed ({len(self._latency_subscribers)} total)')
        elif mtype == 'unsubscribe_graph_latency':
            self._latency_subscribers.discard(ws)
            logging.info(f'[latency] Client unsubscribed ({len(self._latency_subscribers)} total)')
        else:
            logging.warning(f'Unknown message type: {mtype}')

    # ------------------------------------------------------------------
    # Entry point
    # ------------------------------------------------------------------

    def terminate(self, sig, frame):
        logging.info('SIGINT received, shutting down signal_visualizer')
        self._shutdown = True
        if self._server:
            self._server.should_exit = True

    async def _async_main(self):
        self._load_display_hints()
        app = self._build_app()
        config = uvicorn.Config(
            app,
            host='0.0.0.0',
            port=self.port,
            log_level='warning',
        )
        self._server = uvicorn.Server(config)
        server = self._server
        logging.info(f'signal_visualizer listening on http://localhost:{self.port}')
        await asyncio.gather(
            server.serve(),
            self._polling_loop(),
            self._latency_loop(),
        )

    def run(self):
        asyncio.run(self._async_main())


if __name__ == '__main__':
    node = SignalVisualizerNode()
    node.run()
