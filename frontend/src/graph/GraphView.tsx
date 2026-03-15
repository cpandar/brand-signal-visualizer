import { useMemo } from 'react'
import { GraphEdge, GraphNode, GraphTopology } from '../types'

// Layout constants
const NODE_W       = 200
const NODE_H       = 68
const LAYER_STRIDE = 300   // horizontal distance between layer centres
const V_STRIDE     = 96    // vertical distance between nodes in the same layer
const MARGIN       = 32

interface NodePos { x: number; y: number }

interface LayoutResult {
  positions: Map<string, NodePos>
  svgWidth:  number
  svgHeight: number
}

function computeLayout(nodes: GraphNode[], edges: GraphEdge[]): LayoutResult {
  if (nodes.length === 0) {
    return { positions: new Map(), svgWidth: 200, svgHeight: 100 }
  }

  const nicknames = nodes.map(n => n.nickname)

  // 1. Build adjacency and in-degree for topological sort
  const adj      = new Map<string, string[]>(nicknames.map(n => [n, []]))
  const inDegree = new Map<string, number>(nicknames.map(n => [n, 0]))

  for (const e of edges) {
    if (adj.has(e.from) && adj.has(e.to)) {
      adj.get(e.from)!.push(e.to)
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
    }
  }

  // 2. Kahn's topological sort
  const queue = nicknames.filter(n => (inDegree.get(n) ?? 0) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const n = queue.shift()!
    order.push(n)
    for (const next of adj.get(n) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  // Append any nodes not reached (back-edges / cycles)
  for (const n of nicknames) {
    if (!order.includes(n)) order.push(n)
  }

  // 3. Layer assignment: critical path depth
  const layer = new Map<string, number>(nicknames.map(n => [n, 0]))
  for (const n of order) {
    for (const next of adj.get(n) ?? []) {
      const newL = (layer.get(n) ?? 0) + 1
      if (newL > (layer.get(next) ?? 0)) layer.set(next, newL)
    }
  }

  // 4. Group nodes by layer
  const layers = new Map<number, string[]>()
  for (const n of nicknames) {
    const l = layer.get(n) ?? 0
    if (!layers.has(l)) layers.set(l, [])
    layers.get(l)!.push(n)
  }

  // 5. Single-pass barycentric within-layer ordering to reduce crossings
  const sortedLayerNums = [...layers.keys()].sort((a, b) => a - b)
  for (let li = 1; li < sortedLayerNums.length; li++) {
    const layerNodes = layers.get(sortedLayerNums[li])!
    const prevLayer  = layers.get(sortedLayerNums[li - 1])!
    const prevIdx    = new Map(prevLayer.map((n, i) => [n, i]))

    // Build reverse edges for barycentric
    const revAdj = new Map<string, string[]>(nicknames.map(n => [n, []]))
    for (const e of edges) {
      revAdj.get(e.to)?.push(e.from)
    }

    layerNodes.sort((a, b) => {
      const avgPos = (n: string) => {
        const preds = revAdj.get(n)?.filter(p => prevIdx.has(p)) ?? []
        if (preds.length === 0) return 0
        return preds.reduce((s, p) => s + (prevIdx.get(p) ?? 0), 0) / preds.length
      }
      return avgPos(a) - avgPos(b)
    })
  }

  // 6. Assign pixel coordinates — center each layer vertically
  const maxLayerSize = Math.max(...[...layers.values()].map(l => l.length))
  const totalH       = maxLayerSize * V_STRIDE
  const positions    = new Map<string, NodePos>()

  for (const [l, layerNodes] of layers.entries()) {
    const x       = l * LAYER_STRIDE + MARGIN
    const offsetY = Math.round((totalH - layerNodes.length * V_STRIDE) / 2)
    layerNodes.forEach((n, i) => {
      positions.set(n, { x, y: offsetY + i * V_STRIDE + MARGIN })
    })
  }

  const maxLayer  = Math.max(...[...layer.values()])
  const svgWidth  = (maxLayer + 1) * LAYER_STRIDE + MARGIN * 2 + NODE_W
  const svgHeight = totalH + MARGIN * 2

  return { positions, svgWidth, svgHeight }
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

function EdgePath({
  from, to, label, positions, highlight,
}: {
  from: string; to: string; label: string
  positions: Map<string, NodePos>; highlight: boolean
}) {
  const a = positions.get(from)
  const b = positions.get(to)
  if (!a || !b) return null

  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2
  const x2 = b.x,          y2 = b.y + NODE_H / 2
  const cpX = Math.max(40, (x2 - x1) / 2)
  const d = `M${x1},${y1} C${x1 + cpX},${y1} ${x2 - cpX},${y2} ${x2},${y2}`

  const midX = (x1 + x2) / 2
  const midY = (y1 + y2) / 2

  const color = highlight ? '#89b4fa' : '#45475a'

  return (
    <g>
      <defs>
        <marker id={`arrow-${from}-${to}`} markerWidth="8" markerHeight="8"
          refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill={color} />
        </marker>
      </defs>
      <path d={d} fill="none" stroke={color} strokeWidth={highlight ? 2 : 1.5}
        markerEnd={`url(#arrow-${from}-${to})`} />
      {/* Stream name label */}
      <rect x={midX - 36} y={midY - 8} width={72} height={14}
        rx={3} fill="#181825" opacity={0.85} />
      <text x={midX} y={midY + 4} textAnchor="middle"
        fontSize={9} fill={highlight ? '#89b4fa' : '#6c7086'}
        fontFamily="monospace">
        {label.length > 14 ? label.slice(0, 13) + '…' : label}
      </text>
    </g>
  )
}

// ---------------------------------------------------------------------------
// Node box
// ---------------------------------------------------------------------------

function NodeBox({
  node, pos, selected, onClick,
}: {
  node: GraphNode; pos: NodePos; selected: boolean; onClick: () => void
}) {
  const priority = node.run_priority ?? 0
  const priorityColor = priority >= 90 ? '#f38ba8' : priority >= 50 ? '#f9e2af' : '#a6e3a1'
  const moduleShort = node.module.split('/').pop() ?? node.module
  const machine = node.machine || 'local'
  const machineColor = node.machine ? '#89dceb' : '#585b70'  // cyan if remote, dim if local

  return (
    <g onClick={onClick} style={{ cursor: 'pointer' }}>
      {/* Shadow */}
      <rect x={pos.x + 3} y={pos.y + 3} width={NODE_W} height={NODE_H}
        rx={7} fill="#000" opacity={0.25} />
      {/* Body */}
      <rect x={pos.x} y={pos.y} width={NODE_W} height={NODE_H}
        rx={7}
        fill={selected ? '#2a2a3e' : '#1e1e2e'}
        stroke={selected ? '#89b4fa' : '#45475a'}
        strokeWidth={selected ? 2 : 1} />
      {/* Priority stripe */}
      <rect x={pos.x} y={pos.y} width={5} height={NODE_H}
        rx={3} fill={priorityColor} opacity={0.7} />
      {/* Nickname */}
      <text x={pos.x + 14} y={pos.y + 22} fontSize={13} fontWeight={600}
        fill="#cdd6f4" fontFamily="system-ui, sans-serif">
        {node.nickname.length > 22 ? node.nickname.slice(0, 21) + '…' : node.nickname}
      </text>
      {/* Module */}
      <text x={pos.x + 14} y={pos.y + 38} fontSize={10}
        fill="#6c7086" fontFamily="monospace">
        {moduleShort.length > 24 ? moduleShort.slice(0, 23) + '…' : moduleShort}
      </text>
      {/* Machine */}
      <text x={pos.x + 14} y={pos.y + 54} fontSize={9}
        fill={machineColor} fontFamily="monospace" fontStyle="italic">
        {machine.length > 24 ? machine.slice(0, 23) + '…' : machine}
      </text>
      {/* Priority badge */}
      <text x={pos.x + NODE_W - 8} y={pos.y + 16} fontSize={9} textAnchor="end"
        fill={priorityColor} fontFamily="monospace">
        p{priority}
      </text>
      {/* I/O port dots */}
      {node.in_streams.length  > 0 &&
        <circle cx={pos.x} cy={pos.y + NODE_H / 2} r={4} fill="#45475a" stroke="#6c7086" strokeWidth={1} />}
      {node.out_streams.length > 0 &&
        <circle cx={pos.x + NODE_W} cy={pos.y + NODE_H / 2} r={4} fill="#45475a" stroke="#6c7086" strokeWidth={1} />}
    </g>
  )
}

// ---------------------------------------------------------------------------
// GraphView
// ---------------------------------------------------------------------------

interface Props {
  topology:       GraphTopology
  selectedNode:   string | null
  onSelectNode:   (nickname: string) => void
}

export function GraphView({ topology, selectedNode, onSelectNode }: Props) {
  const { positions, svgWidth, svgHeight } = useMemo(
    () => computeLayout(topology.nodes, topology.edges),
    [topology]
  )

  if (topology.nodes.length === 0) {
    return (
      <div style={{ padding: 40, color: '#6c7086', fontSize: 14 }}>
        No nodes found in supergraph_stream. Is the graph running?
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
      <svg width={svgWidth} height={svgHeight}
        style={{ display: 'block', background: '#11111b' }}>

        {/* Edges (drawn first, behind nodes) */}
        {topology.edges.map((e, i) => (
          <EdgePath
            key={i}
            from={e.from} to={e.to} label={e.stream}
            positions={positions}
            highlight={selectedNode === e.from || selectedNode === e.to}
          />
        ))}

        {/* Nodes */}
        {topology.nodes.map(node => {
          const pos = positions.get(node.nickname)
          if (!pos) return null
          return (
            <NodeBox
              key={node.nickname}
              node={node}
              pos={pos}
              selected={selectedNode === node.nickname}
              onClick={() => onSelectNode(node.nickname)}
            />
          )
        })}
      </svg>
    </div>
  )
}
