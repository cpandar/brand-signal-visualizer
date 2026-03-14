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
      setStatus('connected')
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
    }

    ws.onclose = () => {
      setStatus('disconnected')
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
    }

    ws.onerror = () => {
      ws.close()
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // JSON control message
        try {
          const msg = JSON.parse(ev.data) as InboundJsonMsg
          if (msg.type === 'manifest') {
            setManifest(msg.streams)
          }
        } catch {
          console.warn('Failed to parse JSON message', ev.data)
        }
      } else if (ev.data instanceof ArrayBuffer) {
        // Binary data message
        const batch = parseDataMessage(ev.data)
        if (batch) {
          const key = `${batch.stream}/${batch.field}`
          const handlers = dataHandlers.current.get(key)
          if (handlers) {
            handlers.forEach(h => h(batch))
          }
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
