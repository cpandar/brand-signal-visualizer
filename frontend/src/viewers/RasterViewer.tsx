import { useEffect, useRef } from 'react'
import { DataBatch, ViewerConfig } from '../types'

const WINDOW_S = 5      // seconds of history
const ROW_HEIGHT = 2    // pixels per channel row

interface RasterEvent {
  ts: number  // seconds
  ch: number  // channel index
}

interface Props {
  config: ViewerConfig
  latestBatch: DataBatch | null
}

export function RasterViewer({ config, latestBatch }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const eventsRef = useRef<RasterEvent[]>([])
  const animFrameRef = useRef<number>(0)

  const nChannels = config.fieldInfo.n_channels
  const canvasHeight = Math.max(80, nChannels * ROW_HEIGHT)

  // Ingest new events
  useEffect(() => {
    if (!latestBatch) return

    const events = eventsRef.current

    for (let s = 0; s < latestBatch.nSamples; s++) {
      const ts = latestBatch.timestamps[s]
      for (let ch = 0; ch < latestBatch.nChannels; ch++) {
        const val = latestBatch.data[ch * latestBatch.nSamples + s]
        if (val !== 0) {
          events.push({ ts, ch })
        }
      }
    }

    // Trim old events
    const now = latestBatch.timestamps[latestBatch.timestamps.length - 1]
    const cutoff = now - WINDOW_S
    let i = 0
    while (i < events.length && events[i].ts < cutoff) i++
    if (i > 0) events.splice(0, i)
  }, [latestBatch, config.field])

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    function render() {
      const events = eventsRef.current
      const W = canvas!.width
      const H = canvas!.height

      ctx.fillStyle = '#181825'
      ctx.fillRect(0, 0, W, H)

      if (events.length === 0) {
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      const now = events[events.length - 1].ts
      const tStart = now - WINDOW_S
      const tRange = WINDOW_S

      ctx.fillStyle = '#89b4fa'
      for (const ev of events) {
        const x = ((ev.ts - tStart) / tRange) * W
        const y = (ev.ch / nChannels) * H
        ctx.fillRect(x, y, 2, Math.max(1, ROW_HEIGHT))
      }

      // Channel axis label (every 32 channels)
      ctx.fillStyle = '#6c7086'
      ctx.font = '9px monospace'
      for (let ch = 0; ch < nChannels; ch += 32) {
        const y = (ch / nChannels) * H
        ctx.fillText(`${ch}`, 2, y + 9)
      }

      animFrameRef.current = requestAnimationFrame(render)
    }

    animFrameRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [nChannels])

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={canvasHeight}
      style={{ width: '100%', height: canvasHeight, display: 'block', borderRadius: 6 }}
    />
  )
}
