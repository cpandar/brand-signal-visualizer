import { useEffect, useState } from 'react'
import { GraphView } from '../graph/GraphView'
import { NodeDetailPanel } from '../graph/NodeDetailPanel'
import { GraphTopology } from '../types'

interface Props {
  topology:        GraphTopology | null
  topologyLoading: boolean
  requestGraph:    () => void
}

export function GraphPage({ topology, topologyLoading, requestGraph }: Props) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  // Request topology on first mount
  useEffect(() => {
    requestGraph()
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
              selectedNode={selectedNode}
              onSelectNode={n => setSelectedNode(prev => prev === n ? null : n)}
            />
            {selectedNodeData && (
              <NodeDetailPanel
                node={selectedNodeData}
                topology={topology}
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
  },
  toolbarTitle: { fontWeight: 600, fontSize: 13, color: '#cdd6f4' },
  refreshBtn: {
    background: '#313244', color: '#a6adc8', border: '1px solid #45475a',
    borderRadius: 5, padding: '3px 12px', cursor: 'pointer', fontSize: 12,
  },
  stats: { fontSize: 12, color: '#6c7086' },
  body: {
    flex: 1, display: 'flex', overflow: 'hidden',
  },
  placeholder: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#6c7086', fontSize: 14,
  },
}
