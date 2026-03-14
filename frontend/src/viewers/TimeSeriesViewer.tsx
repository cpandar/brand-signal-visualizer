import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { DataBatch, ViewerConfig } from '../types'

const WINDOW_S = 5       // seconds of history to display
const MAX_POINTS = 2000  // max samples retained per channel

interface Props {
  config: ViewerConfig
  latestBatch: DataBatch | null
}

export function TimeSeriesViewer({ config, latestBatch }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  // Ring buffer: timestamps + one Float64Array per channel
  const bufRef = useRef<{
    ts: number[]
    channels: number[][]
  }>({ ts: [], channels: [] })

  const { fieldInfo } = config
  const nChannels = fieldInfo.n_channels
  const hints = fieldInfo.hints

  // Initialize uPlot once
  useEffect(() => {
    if (!containerRef.current) return

    const channelLabels = hints.channel_labels
    const series: uPlot.Series[] = [
      {},  // x-axis (timestamps)
      ...Array.from({ length: nChannels }, (_, i) => ({
        label: channelLabels?.[i] ?? (nChannels === 1 ? config.field : `ch${i}`),
        stroke: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
        width: 1.5,
      })),
    ]

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 160,
      series,
      axes: [
        { label: hints.x_label ?? 'Time (s)', stroke: '#a6adc8', ticks: { stroke: '#313244' } },
        { label: hints.y_label ?? config.field, stroke: '#a6adc8', ticks: { stroke: '#313244' } },
      ],
      cursor: { show: false },
      legend: { show: nChannels <= 8 },
    }

    // Initialize with empty data
    const emptyData: uPlot.AlignedData = [
      new Float64Array(0),
      ...Array.from({ length: nChannels }, () => new Float64Array(0)),
    ]

    plotRef.current = new uPlot(opts, emptyData, containerRef.current)
    bufRef.current = { ts: [], channels: Array.from({ length: nChannels }, () => []) }

    return () => {
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [nChannels, config.field, hints])  // eslint-disable-line react-hooks/exhaustive-deps

  // Ingest new data batches
  useEffect(() => {
    if (!latestBatch || !plotRef.current) return

    const buf = bufRef.current

    // Append new samples
    for (let s = 0; s < latestBatch.nSamples; s++) {
      buf.ts.push(latestBatch.timestamps[s])
      for (let ch = 0; ch < nChannels && ch < latestBatch.nChannels; ch++) {
        buf.channels[ch].push(Number(latestBatch.data[ch * latestBatch.nSamples + s]))
      }
    }

    // Trim to window
    const now = buf.ts[buf.ts.length - 1]
    const cutoff = now - WINDOW_S
    let trimIdx = 0
    while (trimIdx < buf.ts.length && buf.ts[trimIdx] < cutoff) trimIdx++
    if (trimIdx > 0) {
      buf.ts.splice(0, trimIdx)
      buf.channels.forEach(ch => ch.splice(0, trimIdx))
    }

    // Also cap at MAX_POINTS
    if (buf.ts.length > MAX_POINTS) {
      const excess = buf.ts.length - MAX_POINTS
      buf.ts.splice(0, excess)
      buf.channels.forEach(ch => ch.splice(0, excess))
    }

    // Push to uPlot
    const data: uPlot.AlignedData = [
      new Float64Array(buf.ts),
      ...buf.channels.map(ch => new Float64Array(ch)),
    ]
    plotRef.current.setData(data)
  }, [latestBatch, nChannels])

  return (
    <div ref={containerRef} style={{ width: '100%', background: '#181825', borderRadius: 6 }} />
  )
}

const CHANNEL_COLORS = [
  '#89b4fa', '#a6e3a1', '#f38ba8', '#fab387',
  '#f9e2af', '#94e2d5', '#cba6f7', '#89dceb',
]
