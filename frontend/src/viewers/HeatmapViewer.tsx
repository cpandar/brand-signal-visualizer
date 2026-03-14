import { useEffect, useRef, useState } from 'react'
import { DataBatch, ViewerConfig } from '../types'

const MAX_COLS = 2000

interface Props {
  config: ViewerConfig
  latestBatch: DataBatch | null
  windowSecs?: number
}

// ---------------------------------------------------------------------------
// Plasma colormap LUT — for raw firing rates (dark=low, yellow=high)
// ---------------------------------------------------------------------------
const PLASMA_LUT = buildLUT([
  [0.00,  13,   8, 135],
  [0.20,  94,   1, 167],
  [0.40, 177,  42, 144],
  [0.60, 237,  99,  93],
  [0.80, 253, 181,  55],
  [1.00, 240, 249,  33],
])

// ---------------------------------------------------------------------------
// Diverging RdBu LUT — for demeaned data (blue=below mean, red=above mean)
// ---------------------------------------------------------------------------
const RDBU_LUT = buildLUT([
  [0.00,  59,  76, 192],   // deep blue  (large negative deviation)
  [0.25, 114, 158, 233],   // light blue
  [0.50, 245, 245, 245],   // near-white (zero deviation)
  [0.75, 220,  90,  70],   // light red
  [1.00, 180,   4,  38],   // deep red   (large positive deviation)
])

function buildLUT(stops: [number, number, number, number][]): Uint8Array {
  const lut = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let lo = stops[0], hi = stops[stops.length - 1]
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        lo = stops[s]; hi = stops[s + 1]; break
      }
    }
    const f = lo[0] === hi[0] ? 0 : (t - lo[0]) / (hi[0] - lo[0])
    lut[i * 3]     = Math.round(lo[1] + f * (hi[1] - lo[1]))
    lut[i * 3 + 1] = Math.round(lo[2] + f * (hi[2] - lo[2]))
    lut[i * 3 + 2] = Math.round(lo[3] + f * (hi[3] - lo[3]))
  }
  return lut
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HeatmapViewer({ config, latestBatch, windowSecs = 5 }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const [demeaned, setDemeaned] = useState(false)

  const nChannels = config.fieldInfo.n_channels
  // EMA time constant: 10 seconds.  alpha ≈ 1 / (rate × tau)
  const emaAlpha = Math.min(0.3,
    1.0 / (Math.max(1, config.fieldInfo.approx_rate_hz) * 10.0)
  )

  // Scale pixels-per-channel so total canvas height ≈ 200 px
  const pxPerCh     = Math.max(1, Math.min(4, Math.floor(200 / nChannels)))
  const canvasHeight = Math.max(80, nChannels * pxPerCh)

  // Data buffer: time-columns + per-channel EMA for demeaning
  const bufRef = useRef<{
    cols:        Array<{ ts: number; values: Float32Array }>
    ema:         Float32Array   // per-channel exponential moving average
    emaReady:    boolean
    rangeMax:    number         // adaptive max for plasma (raw) mode
    devMax:      number         // adaptive max absolute deviation (demeaned mode)
  }>({
    cols: [], ema: new Float32Array(nChannels),
    emaReady: false, rangeMax: 1, devMax: 1,
  })

  // Reset buffer when stream/field changes
  useEffect(() => {
    bufRef.current = {
      cols: [], ema: new Float32Array(nChannels),
      emaReady: false, rangeMax: 1, devMax: 1,
    }
  }, [nChannels, config.stream, config.field])

  // ------------------------------------------------------------------
  // Ingest new data batches
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!latestBatch || latestBatch.nSamples === 0) return
    const buf = bufRef.current

    // Lazy-initialize EMA to first sample's values to avoid a long transient
    if (!buf.emaReady) {
      for (let ch = 0; ch < nChannels && ch < latestBatch.nChannels; ch++) {
        buf.ema[ch] = Number(latestBatch.data[ch * latestBatch.nSamples])
      }
      buf.emaReady = true
    }

    for (let s = 0; s < latestBatch.nSamples; s++) {
      const col = new Float32Array(nChannels)
      for (let ch = 0; ch < nChannels && ch < latestBatch.nChannels; ch++) {
        const v = Number(latestBatch.data[ch * latestBatch.nSamples + s])
        // Update EMA
        buf.ema[ch] += emaAlpha * (v - buf.ema[ch])
        col[ch] = v
      }
      buf.cols.push({ ts: latestBatch.timestamps[s], values: col })
    }

    // Trim to windowSecs
    const now    = latestBatch.timestamps[latestBatch.timestamps.length - 1]
    const cutoff = now - windowSecs
    let i = 0
    while (i < buf.cols.length && buf.cols[i].ts < cutoff) i++
    if (i > 0) buf.cols.splice(0, i)
    if (buf.cols.length > MAX_COLS) buf.cols.splice(0, buf.cols.length - MAX_COLS)

    // Update adaptive ranges
    let dataMax = 0, devMax = 0
    for (const c of buf.cols) {
      for (let ch = 0; ch < nChannels; ch++) {
        const v   = c.values[ch]
        const dev = Math.abs(v - buf.ema[ch])
        if (v   > dataMax) dataMax = v
        if (dev > devMax)  devMax  = dev
      }
    }
    if (dataMax > 0) {
      buf.rangeMax = buf.rangeMax * 0.98 + dataMax * 0.02
      if (dataMax > buf.rangeMax) buf.rangeMax = dataMax
    }
    if (devMax > 0) {
      buf.devMax = buf.devMax * 0.98 + devMax * 0.02
      if (devMax > buf.devMax) buf.devMax = devMax
    }
  }, [latestBatch, nChannels, windowSecs, emaAlpha])

  // ------------------------------------------------------------------
  // Render loop (requestAnimationFrame)
  // ------------------------------------------------------------------
  const demeandedRef = useRef(demeaned)
  useEffect(() => { demeandedRef.current = demeaned }, [demeaned])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    function render() {
      const { cols, ema, rangeMax, devMax } = bufRef.current
      const isDemeaned = demeandedRef.current
      const W  = canvas!.width
      const H  = canvas!.height
      const lut = isDemeaned ? RDBU_LUT : PLASMA_LUT

      ctx.fillStyle = '#181825'
      ctx.fillRect(0, 0, W, H)

      if (cols.length < 2) {
        ctx.fillStyle = '#6c7086'
        ctx.font = '12px monospace'
        ctx.fillText('Waiting for data…', W / 2 - 60, H / 2)
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      const nCols    = cols.length
      const plotW    = W - 22        // leave right strip for color bar
      const imgData  = ctx.createImageData(plotW, H)
      const pixels   = imgData.data

      const scale    = isDemeaned ? (devMax > 0 ? devMax : 1) : (rangeMax > 0 ? rangeMax : 1)

      for (let px = 0; px < plotW; px++) {
        const colIdx  = Math.floor((px / plotW) * nCols)
        const colVals = cols[Math.min(colIdx, nCols - 1)].values

        for (let ch = 0; ch < nChannels; ch++) {
          let t: number
          if (isDemeaned) {
            // Map deviation to [0,1]: 0=max-neg, 0.5=zero, 1=max-pos
            const dev = colVals[ch] - ema[ch]
            t = 0.5 + 0.5 * Math.max(-1, Math.min(1, dev / scale))
          } else {
            t = Math.max(0, Math.min(1, colVals[ch] / scale))
          }

          const lutIdx = Math.round(t * 255) * 3
          const r = lut[lutIdx], g = lut[lutIdx + 1], b = lut[lutIdx + 2]

          const yStart = ch * pxPerCh
          const yEnd   = Math.min(yStart + pxPerCh, H)
          for (let y = yStart; y < yEnd; y++) {
            const idx = (y * plotW + px) * 4
            pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255
          }
        }
      }

      ctx.putImageData(imgData, 0, 0)

      // Color bar
      const barX = plotW + 4, barW = 10
      for (let py = 0; py < H; py++) {
        const t      = 1 - py / H
        const lutIdx = Math.round(t * 255) * 3
        ctx.fillStyle = `rgb(${lut[lutIdx]},${lut[lutIdx + 1]},${lut[lutIdx + 2]})`
        ctx.fillRect(barX, py, barW, 1)
      }
      ctx.fillStyle = '#a6adc8'; ctx.font = '8px monospace'
      if (isDemeaned) {
        ctx.fillText(`+${scale.toFixed(1)}`, barX, 8)
        ctx.fillText(`−${scale.toFixed(1)}`, barX, H - 2)
      } else {
        ctx.fillText(scale.toFixed(1), barX, 8)
        ctx.fillText('0', barX, H - 2)
      }

      // Channel axis labels
      const labelEvery = Math.max(1, Math.floor(nChannels / 8))
      ctx.fillStyle = 'rgba(166, 173, 200, 0.65)'; ctx.font = '9px monospace'
      for (let ch = 0; ch < nChannels; ch += labelEvery) {
        ctx.fillText(`${ch}`, 2, ch * pxPerCh + pxPerCh)
      }

      animFrameRef.current = requestAnimationFrame(render)
    }

    animFrameRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [nChannels, pxPerCh])

  return (
    <div style={{ position: 'relative' }}>
      {/* Demean toggle */}
      <button
        onClick={() => setDemeaned(d => !d)}
        title="Subtract per-channel running mean (10 s EMA) to show relative modulation"
        style={{
          position: 'absolute', top: 4, left: 4, zIndex: 10,
          background: demeaned ? '#89b4fa' : '#313244',
          color:      demeaned ? '#1e1e2e' : '#a6adc8',
          border: '1px solid #45475a', borderRadius: 4,
          padding: '2px 7px', fontSize: 11, cursor: 'pointer', lineHeight: 1.4,
        }}
      >
        Δ mean
      </button>
      <canvas
        ref={canvasRef}
        width={620}
        height={canvasHeight}
        style={{ width: '100%', height: canvasHeight, display: 'block', borderRadius: 6 }}
      />
    </div>
  )
}
