import { useEffect, useState } from 'react'
import { DataBatch, ViewerConfig, ViewerType } from '../types'
import { TimeSeriesViewer } from '../viewers/TimeSeriesViewer'
import { RasterViewer } from '../viewers/RasterViewer'

const VIEWER_LABELS: Record<ViewerType, string> = {
  timeseries: 'Time Series',
  raster:     'Raster',
  heatmap:    'Heatmap',
  scatter:    '2D Scatter',
  gauge:      'Gauge',
}

interface Props {
  config: ViewerConfig
  onRemove: (id: string) => void
  onTypeChange: (id: string, newType: ViewerType) => void
  /** Subscribe this card to data; returns unsubscribe fn */
  registerDataHandler: (
    stream: string,
    field: string,
    handler: (batch: DataBatch) => void
  ) => () => void
}

export function ViewerCard({ config, onRemove, onTypeChange, registerDataHandler }: Props) {
  const [latestBatch, setLatestBatch] = useState<DataBatch | null>(null)
  const [showTypeMenu, setShowTypeMenu] = useState(false)

  useEffect(() => {
    const unsub = registerDataHandler(config.stream, config.field, (batch) => {
      setLatestBatch(batch)
    })
    return unsub
  }, [config.stream, config.field, registerDataHandler])

  // Determine available viewer types for this signal
  const { dtype, n_channels } = config.fieldInfo
  const availableTypes: ViewerType[] = (() => {
    if (n_channels === 1) return ['timeseries', 'gauge']
    if (n_channels === 2) return ['timeseries', 'scatter', 'gauge']
    if (n_channels <= 16) return ['timeseries', 'gauge']
    if (dtype === 'int8' || dtype === 'int16') return ['raster', 'heatmap', 'gauge']
    return ['heatmap', 'raster', 'gauge']
  })()

  function renderViewer() {
    switch (config.viewerType) {
      case 'timeseries':
        return <TimeSeriesViewer config={config} latestBatch={latestBatch} />
      case 'raster':
        return <RasterViewer config={config} latestBatch={latestBatch} />
      case 'heatmap':
        return <PlaceholderViewer label="Heatmap (coming soon)" />
      case 'scatter':
        return <PlaceholderViewer label="2D Scatter (coming soon)" />
      case 'gauge':
        return <PlaceholderViewer label="Gauge (coming soon)" />
    }
  }

  return (
    <div style={styles.card}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.title}>
          <span style={styles.streamName}>{config.stream}</span>
          <span style={styles.fieldName}>/{config.field}</span>
          <span style={styles.meta}>
            {config.fieldInfo.n_channels}ch · {config.fieldInfo.dtype} ·{' '}
            ~{config.fieldInfo.approx_rate_hz}Hz
          </span>
        </div>
        <div style={styles.controls}>
          {/* Viewer type switcher */}
          <div style={{ position: 'relative' }}>
            <button
              style={styles.typeBtn}
              onClick={() => setShowTypeMenu(v => !v)}
            >
              {VIEWER_LABELS[config.viewerType]} ▾
            </button>
            {showTypeMenu && (
              <div style={styles.typeMenu}>
                {availableTypes.map(vt => (
                  <button
                    key={vt}
                    style={{
                      ...styles.typeMenuItem,
                      ...(vt === config.viewerType ? styles.typeMenuItemActive : {}),
                    }}
                    onClick={() => {
                      onTypeChange(config.id, vt)
                      setShowTypeMenu(false)
                    }}
                  >
                    {VIEWER_LABELS[vt]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button style={styles.closeBtn} onClick={() => onRemove(config.id)}>✕</button>
        </div>
      </div>

      {/* Visualization */}
      <div style={styles.body}>
        {renderViewer()}
      </div>
    </div>
  )
}

function PlaceholderViewer({ label }: { label: string }) {
  return (
    <div style={{
      height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#6c7086', fontSize: 13,
    }}>
      {label}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: '#1e1e2e', borderRadius: 10, border: '1px solid #313244',
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 12px', borderBottom: '1px solid #313244', background: '#181825',
  },
  title: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' },
  streamName: { color: '#cdd6f4', fontWeight: 600, fontSize: 14 },
  fieldName: { color: '#89b4fa', fontSize: 14 },
  meta: { color: '#6c7086', fontSize: 11, marginLeft: 6 },
  controls: { display: 'flex', alignItems: 'center', gap: 6 },
  typeBtn: {
    background: '#313244', color: '#a6adc8', border: '1px solid #45475a',
    borderRadius: 5, padding: '3px 10px', cursor: 'pointer', fontSize: 12,
  },
  typeMenu: {
    position: 'absolute', right: 0, top: '100%', marginTop: 4,
    background: '#313244', border: '1px solid #45475a', borderRadius: 6,
    display: 'flex', flexDirection: 'column', zIndex: 50, minWidth: 130,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  typeMenuItem: {
    background: 'none', border: 'none', color: '#cdd6f4', padding: '7px 14px',
    textAlign: 'left', cursor: 'pointer', fontSize: 13,
  },
  typeMenuItemActive: { color: '#89b4fa', fontWeight: 600 },
  closeBtn: {
    background: 'none', border: 'none', color: '#6c7086', cursor: 'pointer',
    fontSize: 14, padding: '2px 6px', borderRadius: 4,
  },
  body: { padding: 8 },
}
