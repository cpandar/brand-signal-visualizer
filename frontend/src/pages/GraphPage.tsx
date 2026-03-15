import { useEffect, useRef, useState } from 'react'
import { GraphView } from '../graph/GraphView'
import { NodeDetailPanel } from '../graph/NodeDetailPanel'
import { GraphTopology, LatencyUpdate } from '../types'

const DEFAULT_REFRESH_MS = 600
const PARAM_KEY = 'refreshMs'

function readRefreshMs(): number {
  const raw = new URLSearchParams(window.location.search).get(PARAM_KEY)
  const n = raw !== null ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n >= 50 ? n : DEFAULT_REFRESH_MS
}

function writeRefreshMs(ms: number) {
  const url = new URL(window.location.href)
  if (ms === DEFAULT_REFRESH_MS) {
    url.searchParams.delete(PARAM_KEY)
  } else {
    url.searchParams.set(PARAM_KEY, String(ms))
  }
  window.history.replaceState(null, '', url.toString())
}

interface Props {
  topology:                GraphTopology | null
  topologyLoading:         boolean
  latency:                 LatencyUpdate | null
  requestGraph:            () => void
  subscribeGraphLatency:   () => void
  unsubscribeGraphLatency: () => void
}

export function GraphPage({
  topology, topologyLoading, latency,
  requestGraph, subscribeGraphLatency, unsubscribeGraphLatency,
}: Props) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  // Display refresh rate — initialised from URL param, synced back on change
  const [refreshMs, setRefreshMs] = useState<number>(readRefreshMs)
  const [refreshInput, setRefreshInput] = useState<string>(String(readRefreshMs()))

  function applyRefreshMs(ms: number) {
    setRefreshMs(ms)
    setRefreshInput(String(ms))
    writeRefreshMs(ms)
    lastDisplayRef.current = 0  // apply immediately
  }

  // Throttle latency for displayed text so numbers don't flicker at 10 Hz.
  const [displayLatency, setDisplayLatency] = useState<LatencyUpdate | null>(null)
  const lastDisplayRef = useRef<number>(0)
  useEffect(() => {
    const now = Date.now()
    if (now - lastDisplayRef.current >= refreshMs) {
      setDisplayLatency(latency)
      lastDisplayRef.current = now
    }
  }, [latency, refreshMs])

  // Request topology on first mount
  useEffect(() => {
    requestGraph()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to latency updates while this page is mounted
  useEffect(() => {
    subscribeGraphLatency()
    return () => unsubscribeGraphLatency()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const selectedNodeData = topology?.nodes.find(n => n.nickname === selectedNode) ?? null

  return (
    <div style={styles.root}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <span style={styles.toolbarTitle}>Graph Topology</span>
        <button
          style={styles.refreshBtn}
          onClick={requestGraph}
          disabled={topologyLoading}
        >
          {topologyLoading ? 'Loading…' : '↻ Refresh'}
        </button>
        {topology && (
          <span style={styles.stats}>
            {topology.nodes.length} nodes · {topology.edges.length} edges
          </span>
        )}

        {/* Critical path latency */}
        {displayLatency && displayLatency.critical_path_ms > 0 && (
          <span style={styles.criticalPath}>
            critical path: <strong>{displayLatency.critical_path_ms.toFixed(1)} ms</strong>
            {displayLatency.critical_path_nodes.length > 0 && (
              <span style={styles.criticalPathNodes}>
                {' '}({displayLatency.critical_path_nodes.join(' → ')})
              </span>
            )}
          </span>
        )}

        {/* Refresh-rate control — pushed to the right */}
        <div style={styles.refreshControl}>
          <label style={styles.refreshLabel} htmlFor="refreshMs">update every</label>
          <input
            id="refreshMs"
            type="number"
            min={50}
            max={10000}
            step={50}
            style={styles.refreshInput}
            value={refreshInput}
            onChange={e => setRefreshInput(e.target.value)}
            onBlur={() => {
              const n = parseInt(refreshInput, 10)
              applyRefreshMs(Number.isFinite(n) && n >= 50 ? n : refreshMs)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const n = parseInt(refreshInput, 10)
                applyRefreshMs(Number.isFinite(n) && n >= 50 ? n : refreshMs)
              } else if (e.key === 'Escape') {
                setRefreshInput(String(refreshMs))  // revert
              }
            }}
          />
          <span style={styles.refreshLabel}>ms</span>
        </div>
      </div>

      {/* Main content */}
      <div style={styles.body}>
        {topologyLoading && !topology && (
          <div style={styles.placeholder}>Loading graph topology…</div>
        )}

        {!topologyLoading && !topology && (
          <div style={styles.placeholder}>
            Could not load topology. Is the graph running?
          </div>
        )}

        {topology && (
          <>
            <GraphView
              topology={topology}
              latency={displayLatency}
              selectedNode={selectedNode}
              onSelectNode={n => setSelectedNode(prev => prev === n ? null : n)}
            />
            {selectedNodeData && (
              <NodeDetailPanel
                node={selectedNodeData}
                topology={topology}
                latency={displayLatency}
                onClose={() => setSelectedNode(null)}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 16px', background: '#181825', borderBottom: '1px solid #313244',
    flexWrap: 'wrap',
  },
  toolbarTitle: { fontWeight: 600, fontSize: 13, color: '#cdd6f4' },
  refreshBtn: {
    background: '#313244', color: '#a6adc8', border: '1px solid #45475a',
    borderRadius: 5, padding: '3px 12px', cursor: 'pointer', fontSize: 12,
  },
  stats: { fontSize: 12, color: '#6c7086' },
  criticalPath: { fontSize: 12, color: '#a6adc8', marginLeft: 8 },
  criticalPathNodes: { color: '#6c7086', fontFamily: 'monospace', fontSize: 11 },
  body: {
    flex: 1, display: 'flex', overflow: 'hidden',
  },
  placeholder: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#6c7086', fontSize: 14,
  },
  refreshControl: {
    display: 'flex', alignItems: 'center', gap: 5,
    marginLeft: 'auto',
  },
  refreshLabel: { fontSize: 11, color: '#6c7086' },
  refreshInput: {
    width: 60, background: '#313244', color: '#cdd6f4',
    border: '1px solid #45475a', borderRadius: 4,
    padding: '2px 6px', fontSize: 12, fontFamily: 'monospace',
    textAlign: 'right',
  },
}
