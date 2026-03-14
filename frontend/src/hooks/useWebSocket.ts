import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DataBatch,
  InboundJsonMsg,
  OutboundMsg,
  StreamManifest,
  parseDataMessage,
} from '../types'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

interface UseWebSocketReturn {
  status: ConnectionStatus
  manifest: StreamManifest
  send: (msg: OutboundMsg) => void
  /** Register a handler for incoming data batches for a specific stream+field */
  onData: (stream: string, field: string, handler: (batch: DataBatch) => void) => () => void
}

const WS_URL = `ws://${window.location.host}/ws`
const RECONNECT_DELAY_MS = 2000

export function useWebSocket(): UseWebSocketReturn {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [manifest, setManifest] = useState<StreamManifest>({})
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // data handlers: key = "stream/field"
  const dataHandlers = useRef<Map<string, Set<(b: DataBatch) => void>>>(new Map())

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
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
    }

    ws.onerror = (ev) => {
      console.error('[WS] Error:', ev)
      ws.close()
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // JSON control message
        try {
          const msg = JSON.parse(ev.data) as InboundJsonMsg
          if (msg.type === 'manifest') {
            console.info('[WS] Manifest received —', Object.keys(msg.streams).length, 'streams')
            setManifest(msg.streams)
          }
        } catch (err) {
          console.warn('[WS] Failed to parse JSON message:', err, ev.data)
        }
      } else if (ev.data instanceof ArrayBuffer) {
        // Binary data message
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

  return { status, manifest, send, onData }
}
