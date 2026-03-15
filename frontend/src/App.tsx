import { useCallback, useState } from 'react'
import { AddViewerDialog } from './components/AddViewerDialog'
import { ViewerCard } from './components/ViewerCard'
import { GraphPage } from './pages/GraphPage'
import { useWebSocket } from './hooks/useWebSocket'
import { ViewerConfig, ViewerType } from './types'

let nextId = 1
type Page = 'signals' | 'graph'

export function App() {
  const { status, manifest, topology, topologyLoading, send, requestGraph, onData } = useWebSocket()
  const [viewers,        setViewers]        = useState<ViewerConfig[]>([])
  const [showAddDialog,  setShowAddDialog]  = useState(false)
  const [activePage,     setActivePage]     = useState<Page>('signals')

  function handleAddViewer(partial: Omit<ViewerConfig, 'id'>) {
    const config: ViewerConfig = { ...partial, id: String(nextId++) }
    setViewers(v => [...v, config])
    send({ type: 'subscribe', stream: config.stream, field: config.field })
  }

  function handleRemoveViewer(id: string) {
    const viewer = viewers.find(v => v.id === id)
    if (viewer) {
      const others      = viewers.filter(v => v.id !== id)
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

  const statusColor = status === 'connected'    ? '#a6e3a1'
                    : status === 'connecting'   ? '#f9e2af'
                    : '#f38ba8'

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <div style={styles.topbar}>
        <span style={styles.logo}>BRAND Monitor</span>

        {/* Tab bar */}
        <div style={styles.tabs}>
          <button
            style={{ ...styles.tab, ...(activePage === 'signals' ? styles.tabActive : {}) }}
            onClick={() => setActivePage('signals')}
          >
            Signals
          </button>
          <button
            style={{ ...styles.tab, ...(activePage === 'graph' ? styles.tabActive : {}) }}
            onClick={() => setActivePage('graph')}
          >
            Graph
          </button>
        </div>

        <div style={styles.topbarRight}>
          <span style={{ ...styles.statusDot, background: statusColor }} />
          <span style={styles.statusLabel}>{status}</span>
          {activePage === 'signals' && (
            <button
              style={styles.addBtn}
              onClick={() => setShowAddDialog(true)}
              disabled={status !== 'connected' || Object.keys(manifest).length === 0}
            >
              + Add Viewer
            </button>
          )}
        </div>
      </div>

      {/* Page content */}
      {activePage === 'signals' ? (
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
      ) : (
        <GraphPage
          topology={topology}
          topologyLoading={topologyLoading}
          requestGraph={requestGraph}
        />
      )}

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
    display: 'flex', alignItems: 'center', gap: 0,
    padding: '0 20px', height: 48, background: '#1e1e2e',
    borderBottom: '1px solid #313244', flexShrink: 0,
  },
  logo: { fontWeight: 700, fontSize: 16, color: '#89b4fa', letterSpacing: 0.5, marginRight: 24 },
  tabs: { display: 'flex', gap: 2, flex: 1 },
  tab: {
    background: 'none', border: 'none', borderBottom: '2px solid transparent',
    color: '#6c7086', padding: '0 16px', height: 48, cursor: 'pointer',
    fontSize: 13, fontWeight: 500, transition: 'color 0.15s',
  },
  tabActive: { color: '#89b4fa', borderBottomColor: '#89b4fa' },
  topbarRight: { display: 'flex', alignItems: 'center', gap: 10 },
  statusDot:   { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
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
