import { GraphNode, GraphTopology } from '../types'

interface Props {
  node:     GraphNode
  topology: GraphTopology
  onClose:  () => void
}

export function NodeDetailPanel({ node, topology, onClose }: Props) {
  const allStreams = [
    ...node.in_streams.map(s  => ({ s, dir: 'in'  as const })),
    ...node.out_streams.map(s => ({ s, dir: 'out' as const })),
  ]
  // Deduplicate (a stream can appear in both in and out for ambiguous params)
  const seen = new Set<string>()
  const streams = allStreams.filter(({ s }) => {
    if (seen.has(s)) return false
    seen.add(s)
    return true
  })

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={styles.nickname}>{node.nickname}</div>
          <div style={styles.module}>{node.module}</div>
        </div>
        <button style={styles.closeBtn} onClick={onClose}>✕</button>
      </div>

      {/* Priority + Machine */}
      <div style={styles.meta}>
        <span style={styles.metaLabel}>run_priority</span>
        <span style={{
          ...styles.metaValue,
          color: (node.run_priority ?? 0) >= 90 ? '#f38ba8'
               : (node.run_priority ?? 0) >= 50 ? '#f9e2af' : '#a6e3a1'
        }}>
          {node.run_priority ?? 0}
        </span>
        <span style={{ ...styles.metaLabel, marginLeft: 12 }}>machine</span>
        <span style={{
          ...styles.metaValue,
          color: node.machine ? '#89dceb' : '#585b70',
          fontStyle: node.machine ? 'normal' : 'italic',
        }}>
          {node.machine || 'local'}
        </span>
      </div>

      {/* Streams I/O */}
      <div style={styles.sectionTitle}>Streams</div>
      {streams.length === 0
        ? <div style={styles.empty}>No streams detected</div>
        : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}></th>
                <th style={styles.th}>Stream</th>
                <th style={styles.th}>Fields</th>
                <th style={styles.th}>dtype</th>
                <th style={styles.th}>Ch</th>
                <th style={styles.th}>Rate</th>
              </tr>
            </thead>
            <tbody>
              {streams.map(({ s, dir }) => {
                const schema = topology.streams[s]
                const fields = schema ? Object.entries(schema) : []
                return fields.length > 0
                  ? fields.map(([fname, info], fi) => (
                    <tr key={`${s}-${fname}`} style={fi === 0 ? styles.rowFirst : styles.row}>
                      {fi === 0 && (
                        <>
                          <td style={styles.tdDir} rowSpan={fields.length}>
                            <span style={{
                              ...styles.dirBadge,
                              background: dir === 'in' ? '#1e3a2e' : '#1e2a3e',
                              color:      dir === 'in' ? '#a6e3a1' : '#89b4fa',
                            }}>
                              {dir === 'in' ? '← in' : '→ out'}
                            </span>
                          </td>
                          <td style={styles.tdStream} rowSpan={fields.length}>
                            {s}
                          </td>
                        </>
                      )}
                      <td style={styles.td}>{fname}</td>
                      <td style={styles.td}>{info.dtype}</td>
                      <td style={styles.td}>{info.n_channels}</td>
                      <td style={styles.td}>
                        {info.approx_rate_hz > 0 ? `~${info.approx_rate_hz} Hz` : '—'}
                      </td>
                    </tr>
                  ))
                  : (
                    <tr key={s} style={styles.rowFirst}>
                      <td style={styles.tdDir}>
                        <span style={{
                          ...styles.dirBadge,
                          background: dir === 'in' ? '#1e3a2e' : '#1e2a3e',
                          color:      dir === 'in' ? '#a6e3a1' : '#89b4fa',
                        }}>
                          {dir === 'in' ? '← in' : '→ out'}
                        </span>
                      </td>
                      <td style={styles.tdStream}>{s}</td>
                      <td style={{ ...styles.td, color: '#6c7086' }} colSpan={4}>
                        not active in Redis
                      </td>
                    </tr>
                  )
              })}
            </tbody>
          </table>
        )
      }

      {/* Parameters (collapsed by default) */}
      <div style={styles.sectionTitle}>Parameters</div>
      <div style={styles.params}>
        {Object.entries(node.parameters).length === 0
          ? <span style={{ color: '#6c7086' }}>none</span>
          : Object.entries(node.parameters).map(([k, v]) => (
            <div key={k} style={styles.paramRow}>
              <span style={styles.paramKey}>{k}</span>
              <span style={styles.paramVal}>{JSON.stringify(v)}</span>
            </div>
          ))
        }
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 380, minWidth: 340, background: '#1e1e2e',
    borderLeft: '1px solid #313244', overflowY: 'auto',
    display: 'flex', flexDirection: 'column',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    padding: '14px 16px 10px', borderBottom: '1px solid #313244',
    background: '#181825',
  },
  nickname: { fontWeight: 700, fontSize: 15, color: '#cdd6f4' },
  module:   { fontSize: 11, color: '#6c7086', fontFamily: 'monospace', marginTop: 2 },
  closeBtn: {
    background: 'none', border: 'none', color: '#6c7086',
    cursor: 'pointer', fontSize: 16, padding: '0 4px',
  },
  meta: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 16px', borderBottom: '1px solid #313244',
  },
  metaLabel: { fontSize: 11, color: '#6c7086' },
  metaValue: { fontSize: 12, fontFamily: 'monospace', fontWeight: 600 },
  sectionTitle: {
    fontSize: 11, fontWeight: 600, color: '#6c7086', textTransform: 'uppercase',
    letterSpacing: 0.8, padding: '10px 16px 4px',
  },
  empty: { padding: '6px 16px', color: '#6c7086', fontSize: 12 },
  table: {
    width: '100%', borderCollapse: 'collapse',
    fontSize: 12, fontFamily: 'monospace',
  },
  th: {
    padding: '4px 8px', textAlign: 'left', color: '#6c7086',
    fontSize: 10, fontWeight: 600, borderBottom: '1px solid #313244',
    background: '#181825',
  },
  rowFirst: { borderTop: '1px solid #313244' },
  row:      {},
  tdDir: {
    padding: '5px 8px', verticalAlign: 'top',
  },
  tdStream: {
    padding: '5px 8px', color: '#a6adc8', verticalAlign: 'top',
    maxWidth: 120, overflowWrap: 'break-word',
  },
  td: { padding: '3px 8px', color: '#cdd6f4', verticalAlign: 'top' },
  dirBadge: {
    display: 'inline-block', borderRadius: 3, padding: '1px 6px',
    fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
  },
  params: {
    padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 3,
  },
  paramRow: { display: 'flex', gap: 8, fontSize: 11 },
  paramKey: { color: '#89b4fa', fontFamily: 'monospace', minWidth: 100 },
  paramVal: { color: '#a6adc8', fontFamily: 'monospace', wordBreak: 'break-all' },
}
