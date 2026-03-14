import { useCallback, useState } from 'react'
import { AddViewerDialog } from './components/AddViewerDialog'
import { ViewerCard } from './components/ViewerCard'
import { useWebSocket } from './hooks/useWebSocket'
import { ViewerConfig, ViewerType } from './types'

let nextId = 1

export function App() {
  const { status, manifest, send, onData } = useWebSocket()
  const [viewers, setViewers] = useState<ViewerConfig[]>([])
  const [showAddDialog, setShowAddDialog] = useState(false)

  function handleAddViewer(partial: Omit<ViewerConfig, 'id'>) {
    const config: ViewerConfig = { ...partial, id: String(nextId++) }
    setViewers(v => [...v, config])
    send({ type: 'subscribe', stream: config.stream, field: config.field })
  }

  function handleRemoveViewer(id: string) {
    const viewer = viewers.find(v => v.id === id)
    if (viewer) {
      // Unsubscribe only if no other viewer uses the same stream/field
      const others = viewers.filter(v => v.id !== id)
      const stillNeeded = others.some(
        v => v.stream === viewer.stream && v.field === viewer.field
      )
      if (!stillNeeded) {
        send({ type: 'unsubscribe', stream: viewer.stream, field: viewer.field })
      }
    }
    setViewers(v => v.filter(v => v.id !== id))
  }

  function handleTypeChange(id: string, newType: ViewerType) {
    setViewers(v => v.map(cfg => cfg.id === id ? { ...cfg, viewerType: newType } : cfg))
  }

  const registerDataHandler = useCallback(onData, [onData])

  const statusColor = status === 'connected' ? '#a6e3a1' : status === 'connecting' ? '#f9e2af' : '#f38ba8'

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <div style={styles.topbar}>
        <span style={styles.logo}>BRAND Signal Visualizer</span>
        <div style={styles.topbarRight}>
          <span style={{ ...styles.statusDot, background: statusColor }} />
          <span style={styles.statusLabel}>{status}</span>
          <button
            style={styles.addBtn}
            onClick={() => setShowAddDialog(true)}
            disabled={status !== 'connected' || Object.keys(manifest).length === 0}
          >
            + Add Viewer
          </button>
        </div>
      </div>

      {/* Viewer grid */}
      <div style={styles.grid}>
        {viewers.length === 0 && (
          <div style={styles.empty}>
            {status === 'connected'
              ? Object.keys(manifest).length === 0
                ? 'No streams found. Is the graph running?'
                : 'Click "+ Add Viewer" to start monitoring a signal.'
              : 'Connecting to BRAND node…'}
          </div>
        )}
        {viewers.map(cfg => (
          <ViewerCard
            key={cfg.id}
            config={cfg}
            onRemove={handleRemoveViewer}
            onTypeChange={handleTypeChange}
            registerDataHandler={registerDataHandler}
          />
        ))}
      </div>

      {/* Add viewer dialog */}
      {showAddDialog && (
        <AddViewerDialog
          manifest={manifest}
          onAdd={handleAddViewer}
          onClose={() => setShowAddDialog(false)}
        />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh', background: '#11111b', color: '#cdd6f4',
    fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column',
  },
  topbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 20px', background: '#1e1e2e', borderBottom: '1px solid #313244',
  },
  logo: { fontWeight: 700, fontSize: 16, color: '#89b4fa', letterSpacing: 0.5 },
  topbarRight: { display: 'flex', alignItems: 'center', gap: 10 },
  statusDot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
  statusLabel: { color: '#a6adc8', fontSize: 13 },
  addBtn: {
    background: '#89b4fa', color: '#1e1e2e', border: 'none',
    borderRadius: 6, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
  },
  grid: {
    flex: 1, padding: 16, display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(480px, 1fr))',
    gap: 12, alignContent: 'start',
  },
  empty: {
    gridColumn: '1 / -1', textAlign: 'center', color: '#6c7086',
    marginTop: 80, fontSize: 15,
  },
}
