// ---------------------------------------------------------------------------
// Stream manifest types (received from backend as JSON)
// ---------------------------------------------------------------------------

export type ViewerType = 'timeseries' | 'raster' | 'heatmap' | 'scatter' | 'gauge'
export type DType = 'int8' | 'int16' | 'float32' | 'float64'

export interface StreamFieldHints {
  viewer?: ViewerType
  channel_labels?: string[]
  y_label?: string
  x_label?: string
}

export interface StreamFieldInfo {
  dtype: DType
  n_channels: number
  approx_rate_hz: number
  suggested_viewer: ViewerType
  hints: StreamFieldHints
}

export interface StreamManifest {
  [streamName: string]: {
    [fieldName: string]: StreamFieldInfo
  }
}

// ---------------------------------------------------------------------------
// Binary data message (decoded from ArrayBuffer)
// ---------------------------------------------------------------------------

export type SampleArray = Int8Array | Int16Array | Float32Array | Float64Array

export interface DataBatch {
  stream: string
  field: string
  dtypeTag: number       // 0=int8 1=int16 2=float32 3=float64
  nChannels: number
  nSamples: number
  timestamps: number[]   // seconds (converted from Redis ms IDs)
  data: SampleArray      // shape: [n_channels * n_samples], channels-first row-major
}

// Convenience: get a single channel's samples as a typed array slice
export function channelSlice(batch: DataBatch, ch: number): SampleArray {
  const start = ch * batch.nSamples
  const end = start + batch.nSamples
  return batch.data.slice(start, end) as SampleArray
}

// ---------------------------------------------------------------------------
// Viewer instance state
// ---------------------------------------------------------------------------

export interface ViewerConfig {
  id: string           // unique ID for React key
  stream: string
  field: string
  viewerType: ViewerType
  fieldInfo: StreamFieldInfo
}

// ---------------------------------------------------------------------------
// WebSocket message types sent TO backend
// ---------------------------------------------------------------------------

export interface GetManifestMsg { type: 'get_manifest' }
export interface SubscribeMsg   { type: 'subscribe';   stream: string; field: string }
export interface UnsubscribeMsg { type: 'unsubscribe'; stream: string; field: string }

export interface GetGraphMsg    { type: 'get_graph' }
export type OutboundMsg = GetManifestMsg | SubscribeMsg | UnsubscribeMsg | GetGraphMsg

// ---------------------------------------------------------------------------
// WebSocket message types received FROM backend
// ---------------------------------------------------------------------------

export interface ManifestMsg {
  type: 'manifest'
  streams: StreamManifest
}
export interface SubscribedMsg {
  type: 'subscribed'
  stream: string
  field: string
}

export interface GraphTopologyMsg extends GraphTopology { type: 'graph_topology' }
export type InboundJsonMsg = ManifestMsg | SubscribedMsg | GraphTopologyMsg

// ---------------------------------------------------------------------------
// Dtype helpers
// ---------------------------------------------------------------------------

const DTYPE_TAG_MAP: Record<number, DType> = {
  0: 'int8', 1: 'int16', 2: 'float32', 3: 'float64'
}

export function dtypeFromTag(tag: number): DType {
  return DTYPE_TAG_MAP[tag] ?? 'int8'
}

export function makeTypedArray(dtypeTag: number, buffer: ArrayBuffer, byteOffset: number, length: number): SampleArray {
  switch (dtypeTag) {
    case 0: return new Int8Array(buffer, byteOffset, length)
    case 1: return new Int16Array(buffer, byteOffset, length)
    case 2: return new Float32Array(buffer, byteOffset, length)
    case 3: return new Float64Array(buffer, byteOffset, length)
    default: return new Int8Array(buffer, byteOffset, length)
  }
}

// ---------------------------------------------------------------------------
// Binary message parser
// ---------------------------------------------------------------------------

export function parseDataMessage(buffer: ArrayBuffer): DataBatch | null {
  try {
    const view = new DataView(buffer)
    let offset = 0

    const msgType = view.getUint8(offset++)
    if (msgType !== 0x01) return null

    const streamLen = view.getUint8(offset++)
    const stream = new TextDecoder().decode(new Uint8Array(buffer, offset, streamLen))
    offset += streamLen

    const fieldLen = view.getUint8(offset++)
    const field = new TextDecoder().decode(new Uint8Array(buffer, offset, fieldLen))
    offset += fieldLen

    const dtypeTag = view.getUint8(offset++)
    const nChannels = view.getUint32(offset, true); offset += 4
    const nSamples = view.getUint32(offset, true);  offset += 4

    // Timestamps: n_samples * uint64 (read as two uint32 to avoid BigInt)
    const timestamps: number[] = []
    for (let i = 0; i < nSamples; i++) {
      const lo = view.getUint32(offset, true)
      const hi = view.getUint32(offset + 4, true)
      timestamps.push((hi * 0x100000000 + lo) / 1000.0) // ms → seconds
      offset += 8
    }

    // Slice to a new aligned ArrayBuffer — TypedArrays (Float32, Int16) require
    // byte offset to be a multiple of their element size, which is not guaranteed
    // at this offset in the original buffer.
    const itemSize = [1, 2, 4, 8][dtypeTag] ?? 1
    const byteLen = nChannels * nSamples * itemSize
    const dataSlice = buffer.slice(offset, offset + byteLen)
    const data = makeTypedArray(dtypeTag, dataSlice, 0, nChannels * nSamples)

    return { stream, field, dtypeTag, nChannels, nSamples, timestamps, data }
  } catch (err) {
    console.error('[parseDataMessage] Failed to parse binary frame:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Graph topology types
// ---------------------------------------------------------------------------

export interface GraphNode {
  nickname:     string
  name:         string
  module:       string
  machine:      string   // hostname/IP of the machine running this node; '' = local
  run_priority: number
  in_streams:   string[]
  out_streams:  string[]
  parameters:   Record<string, unknown>
}

export interface GraphEdge {
  from:   string
  to:     string
  stream: string
}

export interface GraphTopology {
  nodes:   GraphNode[]
  edges:   GraphEdge[]
  streams: StreamManifest
}
