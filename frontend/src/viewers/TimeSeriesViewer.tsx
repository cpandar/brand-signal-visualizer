import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { DataBatch, ViewerConfig } from '../types'

// Keep up to MAX_BUFFER_SECS of history so expanding the window reveals
// real past data instead of an empty plot.
const MAX_BUFFER_SECS = 60

interface Props {
  config: ViewerConfig
  latestBatch: DataBatch | null
  windowSecs?: number
}

export function TimeSeriesViewer({ config, latestBatch, windowSecs = 5 }: Props) {
  const containerRef   = useRef<HTMLDivElement>(null)
  const plotRef        = useRef<uPlot | null>(null)
  const windowSecsRef  = useRef(windowSecs)   // mutable ref read inside uPlot range fn

  // Ring buffer: timestamps + one array per channel
  const bufRef = useRef<{
    ts: number[]
    channels: number[][]
  }>({ ts: [], channels: [] })

  const { fieldInfo } = config
  const nChannels = fieldInfo.n_channels
  const hints     = fieldInfo.hints

  // Derive a per-viewer point cap from the actual stream rate so that the
  // full MAX_BUFFER_SECS of history is always available regardless of Hz.
  // e.g. 1000 Hz × 60 s × 1.5 headroom = 90 000 pts (~3.6 MB Float64 per ch)
  const maxPoints = Math.max(6000,
    Math.ceil((fieldInfo.approx_rate_hz || 1000) * MAX_BUFFER_SECS * 1.5)
  )

  // Keep windowSecsRef in sync without re-creating the plot
  useEffect(() => {
    windowSecsRef.current = windowSecs
    // If we already have a plot, nudge it to re-evaluate scales immediately
    if (plotRef.current && bufRef.current.ts.length > 0) {
      const buf  = bufRef.current
      const now  = buf.ts[buf.ts.length - 1]
      const winS = windowSecsRef.current
      plotRef.current.setScale('x', { min: now - winS, max: now })
    }
  }, [windowSecs])

  // Initialize uPlot once per stream/field
  useEffect(() => {
    if (!containerRef.current) return

    const channelLabels = hints.channel_labels
    const series: uPlot.Series[] = [
      {},
      ...Array.from({ length: nChannels }, (_, i) => ({
        label: channelLabels?.[i] ?? (nChannels === 1 ? config.field : `ch${i}`),
        stroke: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
        width: 1.5,
      })),
    ]

    const opts: uPlot.Options = {
      width:  containerRef.current.clientWidth,
      height: 160,
      series,
      scales: {
        x: {
          // Always show exactly windowSecs of data, anchored to the latest sample.
          // Reading from windowSecsRef means this closure always sees the current
          // value without needing to destroy/re-create the plot on every change.
          range: (_u, _min, dataMax) => {
            const winS = windowSecsRef.current
            return [dataMax - winS, dataMax]
          },
        },
      },
      axes: [
        { label: hints.x_label ?? 'Time (s)', stroke: '#a6adc8', ticks: { stroke: '#313244' } },
        { label: hints.y_label ?? config.field, stroke: '#a6adc8', ticks: { stroke: '#313244' } },
      ],
      cursor: { show: false },
      legend: { show: nChannels <= 8 },
    }

    const emptyData: uPlot.AlignedData = [
      new Float64Array(0),
      ...Array.from({ length: nChannels }, () => new Float64Array(0)),
    ]

    plotRef.current  = new uPlot(opts, emptyData, containerRef.current)
    bufRef.current   = { ts: [], channels: Array.from({ length: nChannels }, () => []) }

    return () => {
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [nChannels, config.field, hints])  // eslint-disable-line react-hooks/exhaustive-deps

  // Ingest new data batches
  useEffect(() => {
    if (!latestBatch || !plotRef.current) return

    const buf = bufRef.current

    // Append
    for (let s = 0; s < latestBatch.nSamples; s++) {
      buf.ts.push(latestBatch.timestamps[s])
      for (let ch = 0; ch < nChannels && ch < latestBatch.nChannels; ch++) {
        buf.channels[ch].push(Number(latestBatch.data[ch * latestBatch.nSamples + s]))
      }
    }

    // Trim to MAX_BUFFER_SECS (not windowSecs) so history is available
    // when the user expands the time window.
    const now    = buf.ts[buf.ts.length - 1]
    const cutoff = now - MAX_BUFFER_SECS
    let trimIdx  = 0
    while (trimIdx < buf.ts.length && buf.ts[trimIdx] < cutoff) trimIdx++
    if (trimIdx > 0) {
      buf.ts.splice(0, trimIdx)
      buf.channels.forEach(ch => ch.splice(0, trimIdx))
    }

    // Hard cap (rate-derived)
    if (buf.ts.length > maxPoints) {
      const excess = buf.ts.length - maxPoints
      buf.ts.splice(0, excess)
      buf.channels.forEach(ch => ch.splice(0, excess))
    }

    // Push to uPlot — the scales.x.range function handles the visible window
    const data: uPlot.AlignedData = [
      new Float64Array(buf.ts),
      ...buf.channels.map(ch => new Float64Array(ch)),
    ]
    plotRef.current.setData(data)
  }, [latestBatch, nChannels])  // windowSecs intentionally omitted — handled via ref

  return (
    <div ref={containerRef} style={{ width: '100%', background: '#181825', borderRadius: 6 }} />
  )
}

const CHANNEL_COLORS = [
  '#89b4fa', '#a6e3a1', '#f38ba8', '#fab387',
  '#f9e2af', '#94e2d5', '#cba6f7', '#89dceb',
]
