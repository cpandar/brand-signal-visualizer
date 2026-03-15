import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DataBatch,
  GraphTopology,
  InboundJsonMsg,
  LatencyUpdate,
  OutboundMsg,
  StreamManifest,
  parseDataMessage,
} from '../types'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

interface UseWebSocketReturn {
  status:                 ConnectionStatus
  manifest:               StreamManifest
  topology:               GraphTopology | null
  topologyLoading:        boolean
  latency:                LatencyUpdate | null
  send:                   (msg: OutboundMsg) => void
  requestGraph:           () => void
  subscribeGraphLatency:  () => void
  unsubscribeGraphLatency: () => void
  /** Register a handler for incoming data batches for a specific stream+field */
  onData: (stream: string, field: string, handler: (batch: DataBatch) => void) => () => void
}

const WS_URL = `ws://${window.location.host}/ws`
const RECONNECT_DELAY_MS = 2000

export function useWebSocket(): UseWebSocketReturn {
  const [status,          setStatus]          = useState<ConnectionStatus>('connecting')
  const [manifest,        setManifest]        = useState<StreamManifest>({})
  const [topology,        setTopology]        = useState<GraphTopology | null>(null)
  const [topologyLoading, setTopologyLoading] = useState(false)
  const [latency,         setLatency]         = useState<LatencyUpdate | null>(null)

  const wsRef           = useRef<WebSocket | null>(null)
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dataHandlers    = useRef<Map<string, Set<(b: DataBatch) => void>>>(new Map())

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      console.info('[WS] Connected to', WS_URL)
      setStatus('connected')
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
    }

    ws.onclose = () => {
      console.warn('[WS] Disconnected — reconnecting in', RECONNECT_DELAY_MS, 'ms')
      setStatus('disconnected')
      setTopologyLoading(false)
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
    }

    ws.onerror = (ev) => {
      console.error('[WS] Error:', ev)
      ws.close()
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as InboundJsonMsg
          if (msg.type === 'manifest') {
            console.info('[WS] Manifest received —', Object.keys(msg.streams).length, 'streams')
            setManifest(msg.streams)
          } else if (msg.type === 'graph_topology') {
            console.info('[WS] Graph topology received —',
              msg.nodes.length, 'nodes,', msg.edges.length, 'edges')
            setTopology({ nodes: msg.nodes, edges: msg.edges, streams: msg.streams })
            setTopologyLoading(false)
          } else if (msg.type === 'latency_update') {
            setLatency(msg)
          }
        } catch (err) {
          console.warn('[WS] Failed to parse JSON message:', err, ev.data)
        }
      } else if (ev.data instanceof ArrayBuffer) {
        const batch = parseDataMessage(ev.data)
        if (batch) {
          const key = `${batch.stream}/${batch.field}`
          const handlers = dataHandlers.current.get(key)
          if (handlers && handlers.size > 0) {
            handlers.forEach(h => h(batch))
          } else {
            console.warn('[WS] Binary frame received for', key, 'but no handlers registered')
          }
        } else {
          console.error('[WS] Binary frame received but parseDataMessage returned null',
            '— buffer size:', ev.data.byteLength)
        }
      }
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((msg: OutboundMsg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const requestGraph = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setTopologyLoading(true)
      wsRef.current.send(JSON.stringify({ type: 'get_graph' }))
    }
  }, [])

  const subscribeGraphLatency = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe_graph_latency' }))
    }
  }, [])

  const unsubscribeGraphLatency = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'unsubscribe_graph_latency' }))
    }
  }, [])

  const onData = useCallback(
    (stream: string, field: string, handler: (b: DataBatch) => void) => {
      const key = `${stream}/${field}`
      if (!dataHandlers.current.has(key)) {
        dataHandlers.current.set(key, new Set())
      }
      dataHandlers.current.get(key)!.add(handler)
      return () => {
        dataHandlers.current.get(key)?.delete(handler)
      }
    },
    []
  )

  return {
    status, manifest, topology, topologyLoading, latency,
    send, requestGraph, subscribeGraphLatency, unsubscribeGraphLatency, onData,
  }
}
