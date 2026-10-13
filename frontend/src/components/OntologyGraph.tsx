import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CONCEPT_TYPES, type Concept, type Ontology, type Relation } from '../api';
import { href, navigate } from '../route';
import { toRef } from '../zones';

// A graph of one zone's ontology: concepts as nodes (colored by type) and
// relationships as arrows between them. Laid out with a small force
// simulation (no library): nodes repel, relationships pull like springs, and
// everything drifts to the center. Drag the background to pan, ⌘/Ctrl-scroll
// or pinch to zoom (plain scrolling still scrolls the page), drag a node to pin it, click a node or arrow to open it. Hovering a
// concept highlights its neighbours and names its relationships.

const humanType = (t: string) => t.replace(/_/g, ' ');

// One fixed hue per concept type, in CONCEPT_TYPES order (validated for
// color-vision deficiency in light and dark; see styles.css --type-*).
const typeVar = (type: string) => `var(--type-${Math.max(0, CONCEPT_TYPES.indexOf(type as never)) + 1})`;

interface Node {
  id: string;
  concept: Concept;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

interface Edge {
  relation: Relation;
  source: Node;
  target: Node;
  // Index among edges joining the same pair, so parallel arrows curve apart.
  lane: number;
}

const radius = (n: Node) => 7 + Math.min(10, Math.sqrt(n.degree) * 2.5);
// Room a node needs sideways, label included (about 6.5px per character).
const footprint = (n: Node) => Math.max(radius(n) + 8, (n.concept.name.length * 6.5) / 2 + 8);

// One step of the simulation; alpha cools toward 0 as the layout settles.
function tick(nodes: Node[], edges: Edge[], alpha: number) {
  const REPEL = 9000;
  const SPRING = 0.04;
  const LENGTH = 150;
  const CENTER = 0.012;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        d2 = 0.5;
      }
      const f = (REPEL * alpha) / d2;
      const d = Math.sqrt(d2);
      a.vx -= (dx / d) * f;
      a.vy -= (dy / d) * f;
      b.vx += (dx / d) * f;
      b.vy += (dy / d) * f;
    }
  }
  for (const e of edges) {
    const dx = e.target.x - e.source.x;
    const dy = e.target.y - e.source.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - LENGTH) * SPRING * alpha;
    e.source.vx += (dx / d) * f;
    e.source.vy += (dy / d) * f;
    e.target.vx -= (dx / d) * f;
    e.target.vy -= (dy / d) * f;
  }
  // Collision: keep labels from overlapping. Labels are wide and short, so
  // nodes side by side need more room than nodes stacked vertically.
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const needX = footprint(a) + footprint(b);
      const needY = radius(a) + radius(b) + 30;
      const overlapX = needX - Math.abs(dx);
      const overlapY = needY - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      // Push apart along the cheaper axis.
      if (overlapX / needX < overlapY / needY) {
        const push = (overlapX / 2) * 0.5 * (dx < 0 ? -1 : 1);
        if (!a.pinned) a.x -= push;
        if (!b.pinned) b.x += push;
      } else {
        const push = (overlapY / 2) * 0.5 * (dy < 0 ? -1 : 1);
        if (!a.pinned) a.y -= push;
        if (!b.pinned) b.y += push;
      }
    }
  }
  for (const n of nodes) {
    if (n.pinned) {
      n.vx = n.vy = 0;
      continue;
    }
    n.vx = (n.vx - n.x * CENTER * alpha) * 0.6;
    n.vy = (n.vy - n.y * CENTER * alpha) * 0.6;
    n.x += n.vx;
    n.y += n.vy;
  }
}

function build(ontology: Ontology): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map<string, Node>();
  const count = ontology.concepts.length;
  ontology.concepts.forEach((c, i) => {
    // Start on a spiral, so the first frames are already spread out.
    const angle = i * 2.4;
    const r = 20 * Math.sqrt(i + 1);
    byId.set(c.id, { id: c.id, concept: c, degree: 0, x: Math.cos(angle) * r, y: Math.sin(angle) * r, vx: 0, vy: 0, pinned: false });
  });
  const lanes = new Map<string, number>();
  const edges: Edge[] = [];
  for (const r of ontology.relations) {
    const source = byId.get(r.from);
    const target = byId.get(r.to);
    if (!source || !target || source === target) continue;
    const pair = [source.id, target.id].sort().join('|');
    const lane = lanes.get(pair) ?? 0;
    lanes.set(pair, lane + 1);
    source.degree++;
    target.degree++;
    edges.push({ relation: r, source, target, lane });
  }
  const nodes = [...byId.values()];
  // Settle most of the way before the first paint; the rest animates.
  for (let i = 0; i < Math.min(400, 120 + count * 3); i++) tick(nodes, edges, Math.max(0.05, 1 - i / 300));
  return { nodes, edges };
}

// The arrow from the edge of one circle to the edge of the other, bowed when
// several relationships join the same two concepts.
function edgePath(e: Edge): { d: string; mid: { x: number; y: number } } {
  const { source: s, target: t } = e;
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = s.x + ux * radius(s);
  const y1 = s.y + uy * radius(s);
  const x2 = t.x - ux * (radius(t) + 4);
  const y2 = t.y - uy * (radius(t) + 4);
  const bow = e.lane === 0 ? 0 : (e.lane % 2 ? 1 : -1) * Math.ceil(e.lane / 2) * 26;
  const cx = (x1 + x2) / 2 - uy * bow;
  const cy = (y1 + y2) / 2 + ux * bow;
  return {
    d: bow ? `M${x1},${y1} Q${cx},${cy} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`,
    mid: bow ? { x: (x1 + 2 * cx + x2) / 4, y: (y1 + 2 * cy + y2) / 4 } : { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
  };
}

type Hover = { kind: 'node'; node: Node } | { kind: 'edge'; edge: Edge } | null;

export function OntologyGraph({ zone, ontology }: { zone: string; ontology: Ontology }) {
  const graph = useMemo(() => build(ontology), [ontology]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [, setFrame] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<Hover>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const alpha = useRef(0.3);
  const drag = useRef<{ node: Node | null; startX: number; startY: number; moved: boolean; view: typeof view } | null>(null);

  const visible = (n: Node) => !hidden.has(n.concept.type);
  const nodes = graph.nodes.filter(visible);
  const edges = graph.edges.filter((e) => visible(e.source) && visible(e.target));
  const types = CONCEPT_TYPES.filter((t) => graph.nodes.some((n) => n.concept.type === t));

  // Animate until the layout cools; re-heated by dragging a node.
  const heat = (to: number) => {
    alpha.current = Math.max(alpha.current, to);
  };
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (alpha.current > 0.02 && !document.hidden) {
        tick(nodes, edges, alpha.current);
        alpha.current *= 0.97;
        setFrame((f) => f + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // nodes/edges are derived from graph + hidden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, hidden]);

  // Fit everything in view once laid out (and when the zone or filter changes).
  const fit = () => {
    const svg = svgRef.current;
    if (!svg || !nodes.length) return;
    const { width, height } = svg.getBoundingClientRect();
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const pad = 70;
    const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
    const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
    const k = Math.min(2, Math.max(0.2, Math.min(width / w, height / h)));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    setView({ x: width / 2 - cx * k, y: height / 2 - cy * k, k });
  };
  useEffect(() => {
    const timer = window.setTimeout(fit, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, hidden]);

  // ⌘/Ctrl-wheel (and trackpad pinch, which arrives as ctrl-wheel) zooms
  // around the cursor; a plain wheel is left to scroll the page.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const k = Math.min(4, Math.max(0.15, v.k * Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0015))));
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const zoomCenter = (v: typeof view, by: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const px = (rect?.width ?? 0) / 2;
    const py = (rect?.height ?? 0) / 2;
    const k = Math.min(4, Math.max(0.15, v.k * by));
    return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
  };

  const toGraph = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };

  function down(e: ReactPointerEvent, node: Node | null) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { node, startX: e.clientX, startY: e.clientY, moved: false, view };
  }

  function move(e: ReactPointerEvent) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 4) d.moved = true;
    if (!d.moved) return;
    if (d.node) {
      const p = toGraph(e.clientX, e.clientY);
      d.node.x = p.x;
      d.node.y = p.y;
      d.node.pinned = true;
      heat(0.3);
    } else {
      setView({ ...d.view, x: d.view.x + e.clientX - d.startX, y: d.view.y + e.clientY - d.startY });
    }
  }

  function up(e: ReactPointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (d?.node && !d.moved) {
      const target = href({ view: 'concept', id: toRef(zone, d.node.id) });
      if (e.metaKey || e.ctrlKey) window.open(target, '_blank');
      else window.location.hash = target;
    }
  }

  const focus = hover?.kind === 'node' ? hover.node : null;
  const neighbours = useMemo(() => {
    if (!focus) return null;
    const ids = new Set([focus.id]);
    for (const e of edges) {
      if (e.source === focus) ids.add(e.target.id);
      if (e.target === focus) ids.add(e.source.id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, graph, hidden]);
  const dimNode = (n: Node) => neighbours !== null && !neighbours.has(n.id);
  const touches = (e: Edge) => focus !== null && (e.source === focus || e.target === focus);
  const dimEdge = (e: Edge) => (focus !== null && !touches(e)) || (hover?.kind === 'edge' && hover.edge !== e);

  if (!graph.nodes.length) {
    return <p className="muted">No concepts in this zone yet.</p>;
  }

  const relationName = (e: Edge) => e.relation.name || humanType(e.relation.type);

  return (
    <div className="ontology-graph" ref={wrapRef}>
      <div className="graph-toolbar">
        <div className="graph-legend" role="group" aria-label="Concept types (click to show or hide)">
          {types.map((t) => {
            const count = graph.nodes.filter((n) => n.concept.type === t).length;
            const off = hidden.has(t);
            return (
              <button
                key={t}
                className={`legend-chip${off ? ' off' : ''}`}
                aria-pressed={!off}
                title={off ? `Show ${t}` : `Hide ${t}`}
                onClick={() =>
                  setHidden((h) => {
                    const next = new Set(h);
                    if (off) next.delete(t);
                    else next.add(t);
                    return next;
                  })
                }
              >
                <span className="legend-dot" style={{ background: typeVar(t) }} />
                {t} <span className="muted">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="graph-actions">
          <span className="muted hint">
            {nodes.length} {nodes.length === 1 ? 'concept' : 'concepts'} · {edges.length}{' '}
            {edges.length === 1 ? 'relationship' : 'relationships'} · ⌘-scroll to zoom
          </span>
          <button onClick={() => setView((v) => zoomCenter(v, 1.25))} aria-label="Zoom in">
            +
          </button>
          <button onClick={() => setView((v) => zoomCenter(v, 0.8))} aria-label="Zoom out">
            −
          </button>
          <button
            onClick={() => {
              for (const n of graph.nodes) n.pinned = false;
              heat(0.6);
              window.setTimeout(fit, 600);
            }}
            title="Unpin dragged concepts and lay the graph out again"
          >
            Re-layout
          </button>
          <button onClick={fit}>Fit</button>
        </div>
      </div>

      <svg
        ref={svgRef}
        className="graph-canvas"
        role="img"
        aria-label={`Graph of ${nodes.length} concepts and ${edges.length} relationships. The list view shows the same information as text.`}
        onPointerDown={(e) => down(e, null)}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={() => {
          setPointer(null);
          setHover(null);
        }}
      >
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className="graph-arrowhead" />
          </marker>
          <marker id="graph-arrow-strong" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className="graph-arrowhead strong" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges.map((e) => {
            const { d } = edgePath(e);
            const strong = touches(e) || (hover?.kind === 'edge' && hover.edge === e);
            return (
              <g key={e.relation.id} className={`graph-edge${dimEdge(e) ? ' dim' : ''}${strong ? ' strong' : ''}`}>
                <path d={d} className="edge-line" markerEnd={`url(#graph-arrow${strong ? '-strong' : ''})`} />
                {/* A wide invisible stroke, so thin arrows are easy to hover. */}
                <path
                  d={d}
                  className="edge-hit"
                  onPointerEnter={() => setHover({ kind: 'edge', edge: e })}
                  onPointerLeave={() => setHover(null)}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={() => navigate({ view: 'relation', id: toRef(zone, e.relation.id) })}
                />
              </g>
            );
          })}
          {/* Relationship names only for the hovered concept's arrows, not on every edge. */}
          {edges.filter((e) => touches(e) || (hover?.kind === 'edge' && hover.edge === e)).map((e) => {
            const { mid } = edgePath(e);
            return (
              <text key={`label:${e.relation.id}`} className="edge-label" x={mid.x} y={mid.y} textAnchor="middle" dy="-4">
                {relationName(e)}
              </text>
            );
          })}
          {nodes.map((n) => (
            <g
              key={n.id}
              className={`graph-node${dimNode(n) ? ' dim' : ''}${focus === n ? ' focus' : ''}`}
              transform={`translate(${n.x},${n.y})`}
              onPointerDown={(e) => down(e, n)}
              onPointerEnter={() => setHover({ kind: 'node', node: n })}
              onPointerLeave={() => setHover(null)}
              tabIndex={0}
              role="link"
              aria-label={`${n.concept.name}, ${n.concept.type}, ${n.degree} relationships`}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate({ view: 'concept', id: toRef(zone, n.id) });
              }}
              onFocus={() => setHover({ kind: 'node', node: n })}
              onBlur={() => setHover(null)}
            >
              <circle r={radius(n) + 6} className="node-hit" />
              <circle r={radius(n)} className="node-dot" style={{ fill: typeVar(n.concept.type) }} />
              {n.pinned && <circle r={2.5} className="node-pin" />}
              <text className="node-label" y={radius(n) + 13} textAnchor="middle">
                {n.concept.name}
              </text>
            </g>
          ))}
        </g>
      </svg>

      {hover && pointer && (
        <div
          className="graph-tooltip"
          style={{
            left: Math.min(pointer.x + 14, (wrapRef.current?.clientWidth ?? 0) - 280),
            top: pointer.y + 14,
          }}
        >
          {hover.kind === 'node' ? (
            <>
              <strong>{hover.node.concept.name}</strong>
              <span className="tooltip-type">
                <span className="legend-dot" style={{ background: typeVar(hover.node.concept.type) }} />
                {hover.node.concept.type} · {hover.node.degree} {hover.node.degree === 1 ? 'relationship' : 'relationships'}
              </span>
              {hover.node.concept.definition && <span>{hover.node.concept.definition}</span>}
              {hover.node.concept.aliases.length > 0 && (
                <span className="muted">Also called {hover.node.concept.aliases.join(', ')}</span>
              )}
              <span className="muted hint">Click to open · drag to move</span>
            </>
          ) : (
            <>
              <strong>{hover.edge.relation.name || `${hover.edge.source.concept.name} ${humanType(hover.edge.relation.type)} ${hover.edge.target.concept.name}`}</strong>
              {hover.edge.relation.name && (
                <span>
                  {hover.edge.source.concept.name} {humanType(hover.edge.relation.type)} {hover.edge.target.concept.name}
                </span>
              )}
              {hover.edge.relation.description && <span>{hover.edge.relation.description}</span>}
              <span className="muted hint">Click to open</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
