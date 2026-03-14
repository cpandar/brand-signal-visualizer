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

    def disconnect(self, ws: WebSocket):
        self.connections.discard(ws)
        for stream_subs in self.subscriptions.values():
            for field_subs in stream_subs.values():
                field_subs.discard(ws)
        logging.info('Browser client disconnected')

    def subscribe(self, ws: WebSocket, stream: str, field: str):
        self.subscriptions.setdefault(stream, {}).setdefault(field, set()).add(ws)
        # Only reset to '$' if this stream is brand new (don't reset for new viewers
        # on an already-polled stream)
        if stream not in self.last_ids:
            self.last_ids[stream] = '$'
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

    # ------------------------------------------------------------------
    # Graph YAML helpers
    # ------------------------------------------------------------------

    def _load_display_hints(self):
        """Read display_hints from the supergraph YAML if present."""
        try:
            entries = self.r.xrange('supergraph_stream', '-', '+', count=1)
            if entries:
                data = json.loads(entries[-1][1][b'data'].decode())
                self.display_hints = data.get('display_hints', {})
                logging.info(f'Loaded display_hints for streams: '
                             f'{list(self.display_hints.keys())}')
        except Exception as e:
            logging.warning(f'Could not load display_hints: {e}')

    # ------------------------------------------------------------------
    # Stream manifest
    # ------------------------------------------------------------------

    def _suggest_viewer(self, dtype_str: str, n_channels: int) -> str:
        if n_channels == 1:
            return 'gauge'
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

        while True:
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
                manager.disconnect(ws)
            except Exception as e:
                logging.error(f'WebSocket error: {e}')
                manager.disconnect(ws)

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

    async def _handle_message(self, ws: WebSocket, msg: dict):
        mtype = msg.get('type')
        if mtype == 'get_manifest':
            manifest = self._build_manifest()
            await ws.send_json({'type': 'manifest', 'streams': manifest})
        elif mtype == 'subscribe':
            stream = msg.get('stream', '')
            field = msg.get('field', '')
            if stream and field:
                self.manager.subscribe(ws, stream, field)
                await ws.send_json({'type': 'subscribed', 'stream': stream, 'field': field})
        elif mtype == 'unsubscribe':
            stream = msg.get('stream', '')
            field = msg.get('field', '')
            if stream and field:
                self.manager.unsubscribe(ws, stream, field)
        else:
            logging.warning(f'Unknown message type: {mtype}')

    # ------------------------------------------------------------------
    # Entry point
    # ------------------------------------------------------------------

    async def _async_main(self):
        self._load_display_hints()
        app = self._build_app()
        config = uvicorn.Config(
            app,
            host='0.0.0.0',
            port=self.port,
            log_level='warning',
        )
        server = uvicorn.Server(config)
        logging.info(f'signal_visualizer listening on http://localhost:{self.port}')
        await asyncio.gather(
            server.serve(),
            self._polling_loop(),
        )

    def run(self):
        asyncio.run(self._async_main())


if __name__ == '__main__':
    node = SignalVisualizerNode()
    node.run()
