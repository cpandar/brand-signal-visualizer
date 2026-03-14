import { useState } from 'react'
import { StreamManifest, StreamFieldInfo, ViewerType, ViewerConfig } from '../types'

// Which viewer types are compatible with a given signal shape/dtype
function compatibleViewers(info: StreamFieldInfo): ViewerType[] {
  const { dtype, n_channels } = info
  const types: ViewerType[] = []

  if (n_channels === 1) {
    types.push('timeseries', 'gauge')
  } else if (n_channels === 2) {
    types.push('timeseries', 'scatter')
  } else if (n_channels <= 16) {
    types.push('timeseries')
  } else {
    if (dtype === 'int8' || dtype === 'int16') types.push('raster', 'heatmap')
    else types.push('heatmap', 'raster')
  }

  // Gauge is always available as a fallback
  if (!types.includes('gauge')) types.push('gauge')

  return types
}

const VIEWER_LABELS: Record<ViewerType, string> = {
  timeseries: 'Time Series',
  raster:     'Raster',
  heatmap:    'Heatmap',
  scatter:    '2D Scatter',
  gauge:      'Gauge',
}

interface Props {
  manifest: StreamManifest
  onAdd: (config: Omit<ViewerConfig, 'id'>) => void
  onClose: () => void
}

export function AddViewerDialog({ manifest, onAdd, onClose }: Props) {
  const streamNames = Object.keys(manifest)
  const [selectedStream, setSelectedStream] = useState(streamNames[0] ?? '')
  const fieldNames = selectedStream ? Object.keys(manifest[selectedStream] ?? {}) : []
  const [selectedField, setSelectedField] = useState(fieldNames[0] ?? '')

  const fieldInfo: StreamFieldInfo | null =
    selectedStream && selectedField
      ? manifest[selectedStream]?.[selectedField] ?? null
      : null

  const compatible = fieldInfo ? compatibleViewers(fieldInfo) : []
  const [selectedViewer, setSelectedViewer] = useState<ViewerType>(
    fieldInfo?.suggested_viewer ?? 'timeseries'
  )

  // Reset field + viewer when stream changes
  function handleStreamChange(s: string) {
    setSelectedStream(s)
    const fields = Object.keys(manifest[s] ?? {})
    const f = fields[0] ?? ''
    setSelectedField(f)
    if (f && manifest[s]?.[f]) {
      setSelectedViewer(manifest[s][f].suggested_viewer)
    }
  }

  // Reset viewer when field changes
  function handleFieldChange(f: string) {
    setSelectedField(f)
    if (selectedStream && manifest[selectedStream]?.[f]) {
      setSelectedViewer(manifest[selectedStream][f].suggested_viewer)
    }
  }

  function handleAdd() {
    if (!fieldInfo) return
    onAdd({
      stream: selectedStream,
      field: selectedField,
      viewerType: selectedViewer,
      fieldInfo,
    })
    onClose()
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.dialog}>
        <h2 style={styles.title}>Add Viewer</h2>

        <label style={styles.label}>Stream</label>
        <select
          style={styles.select}
          value={selectedStream}
          onChange={e => handleStreamChange(e.target.value)}
        >
          {streamNames.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <label style={styles.label}>Field</label>
        <select
          style={styles.select}
          value={selectedField}
          onChange={e => handleFieldChange(e.target.value)}
        >
          {fieldNames.map(f => <option key={f} value={f}>{f}</option>)}
        </select>

        {fieldInfo && (
          <div style={styles.meta}>
            {fieldInfo.n_channels} ch · {fieldInfo.dtype} · ~{fieldInfo.approx_rate_hz} Hz
          </div>
        )}

        <label style={styles.label}>Viewer type</label>
        <div style={styles.viewerTypeRow}>
          {compatible.map(vt => (
            <button
              key={vt}
              style={{
                ...styles.typeBtn,
                ...(selectedViewer === vt ? styles.typeBtnActive : {}),
              }}
              onClick={() => setSelectedViewer(vt)}
            >
              {VIEWER_LABELS[vt]}
            </button>
          ))}
        </div>

        <div style={styles.actions}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={styles.addBtn}
            onClick={handleAdd}
            disabled={!fieldInfo}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
  },
  dialog: {
    background: '#1e1e2e', borderRadius: 10, padding: 28, minWidth: 360,
    display: 'flex', flexDirection: 'column', gap: 8,
    boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
  },
  title: { margin: 0, color: '#cdd6f4', fontSize: 18, marginBottom: 8 },
  label: { color: '#a6adc8', fontSize: 12, marginTop: 4 },
  select: {
    background: '#313244', color: '#cdd6f4', border: '1px solid #45475a',
    borderRadius: 6, padding: '6px 10px', fontSize: 14,
  },
  meta: { color: '#6c7086', fontSize: 12 },
  viewerTypeRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 },
  typeBtn: {
    background: '#313244', color: '#a6adc8', border: '1px solid #45475a',
    borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 13,
  },
  typeBtnActive: {
    background: '#89b4fa', color: '#1e1e2e', borderColor: '#89b4fa',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  cancelBtn: {
    background: 'transparent', color: '#a6adc8', border: '1px solid #45475a',
    borderRadius: 6, padding: '6px 16px', cursor: 'pointer',
  },
  addBtn: {
    background: '#89b4fa', color: '#1e1e2e', border: 'none',
    borderRadius: 6, padding: '6px 18px', cursor: 'pointer', fontWeight: 600,
  },
}
