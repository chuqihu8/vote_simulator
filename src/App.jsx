import { useState, useEffect, useRef, useCallback } from "react";

// ─── RNG ──────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Layout ───────────────────────────────────────────────────────────────────
const PROP_VALS = [0.2, 0.5, 0.8];
const EDGE_VALS = [0.1, 0.2, 0.3];

function layoutNodes(n, seed) {
  const rng = mulberry32(seed + 77);
  const cx = 700, cy = 530, r = 560;
  return Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2 + rng() * 0.15;
    const dist = r * (0.5 + rng() * 0.5);
    return { x: cx + dist * Math.cos(angle), y: cy + dist * Math.sin(angle) };
  });
}

// ─── Build edges from node params ─────────────────────────────────────────────
// edges: [ { from, to, w } ] — each arrow is a separate directed edge
// adjMap[i][j] = weight of influence j has on i (i.e. when j votes, i's propensity rises by adjMap[i][j])
function buildNetwork(nodeParams, edgeList) {
  const n = nodeParams.length;
  const adjMap = Array.from({ length: n }, () => ({}));
  edgeList.forEach(e => {
    adjMap[e.to][e.from] = e.w;   // from votes → to gains w influence
  });
  return adjMap;
}

// ─── Auto-generate edge list from node params ─────────────────────────────────
function autoEdges(nodeParams, seed) {
  const n = nodeParams.length;
  const rng = mulberry32(seed + 42);
  const edgeMap = {};
  const defaultDeg = 2;

  for (let i = 0; i < n; i++) {
    let attempts = 0;
    while (
      Object.keys(edgeMap).filter(k => k.startsWith(`${i}-`) || k.endsWith(`-${i}`)).length < defaultDeg
      && attempts < 300
    ) {
      attempts++;
      const j = Math.floor(rng() * n);
      if (j === i) continue;
      const key = `${Math.min(i, j)}-${Math.max(i, j)}`;
      if (edgeMap[key]) continue;
      const fromNode = Math.min(i, j);
      const toNode = Math.max(i, j);
      edgeMap[key] = {
        from: fromNode,
        to: toNode,
        w: EDGE_VALS[Math.floor(rng() * 3)],
      };
    }
  }
  // Expand each pair into two individual directed arrows
  return Object.values(edgeMap).flatMap(e => [
    { from: e.from, to: e.to, w: e.w },
    { from: e.to, to: e.from, w: EDGE_VALS[Math.floor(Math.random() * 3)] },
  ]);
}

// ─── Simulation ───────────────────────────────────────────────────────────────
// Rules:
//  1. Each day, unvoted nodes receive a ONE-TIME influence boost from neighbors
//     who voted EXACTLY the previous day (votedDay === day - 1).
//     Once that boost is applied, it's baked into the propensity permanently.
//  2. Draw a random number 0–1. If draw < propensity → VOTE.
//  3. Once voted, a node stays voted forever.
function runSimulation(nodeParams, adjMap, days, threshold, simSeed, forcedFlip) {
  const n = nodeParams.length;
  const rng = mulberry32(simSeed);
  const draws = Array.from({ length: n }, () =>
    Array.from({ length: days }, () => rng())
  );

  const history = [];
  let state = nodeParams.map(np => ({
    name: np.name,
    propensity: np.propensity,
    voted: false,
    votedDay: null,
    influenceReceived: 0,
    draw: null,
  }));
  history.push(state.map(s => ({ ...s })));

  let passed = false, passedDay = null;

  for (let day = 1; day <= days; day++) {
    const prev = state;
    const next = prev.map(s => ({ ...s, influenceReceived: 0, draw: null }));

    // Forced flip for counterfactual
    if (forcedFlip && forcedFlip.day === day && !next[forcedFlip.node].voted) {
      next[forcedFlip.node] = { ...next[forcedFlip.node], voted: true, votedDay: day, propensity: 1, draw: 0 };
    }

    for (let i = 0; i < n; i++) {
      const draw = draws[i][day - 1];

      let inf = 0;
      for (const [jStr, w] of Object.entries(adjMap[i] || {})) {
        const j = Number(jStr);
        if (prev[j].voted && prev[j].votedDay === day - 1) inf += w;
      }
      const newP = Math.min(1, prev[i].propensity + inf);

      if (next[i].voted) {
        next[i] = { ...next[i], name: prev[i].name, propensity: newP, influenceReceived: inf, draw };
        continue;
      }

      next[i] = { ...next[i], name: prev[i].name, propensity: newP, influenceReceived: inf, draw };

      // Forced vote day override
      const forced = nodeParams[i]?.forceVoteDay;
      if (forced === "never") {
        // never votes
      } else if (forced && Number(forced) === day) {
        next[i] = { ...next[i], voted: true, votedDay: day };
      } else if (!forced && draw < newP) {
        next[i] = { ...next[i], voted: true, votedDay: day };
      }
    }

    state = next;
    history.push(state.map(s => ({ ...s })));
    if (!passed && next.filter(s => s.voted).length >= threshold) {
      passed = true; passedDay = day;
    }
  }

  return { history, passed, passedDay, draws, finalVotes: state.filter(s => s.voted).length };
}

// ─── Person figure ────────────────────────────────────────────────────────────
function PersonFigure({ x, y, propensity, influenceReceived = 0, voted, isSelected, isCF, showDefault, nodeId, onClick }) {
  // showDefault: flat grey, no thermometer fill
  if (showDefault) {
    // uniform grey, nothing special
  }
  // Body: blue shades by propensity until voted (red), selected (bright blue), CF (amber)
  // Low propensity = light blue, high propensity = dark blue
  const blueLit = Math.round(88 - propensity * 45);  // 88% (light) → 43% (dark)
  const blueSat = Math.round(40 + propensity * 40);   // 40% → 80%
  const bodyColor = voted ? "#22c55e" : isSelected ? "#1d4ed8" : isCF ? "#f59e0b" : `hsl(215,${blueSat}%,${blueLit}%)`;
  const strokeC   = voted ? "#15803d" : isSelected ? "#1e3a8a" : isCF ? "#b45309" : `hsl(215,${blueSat}%,${blueLit - 15}%)`;
  const textC = "#1e293b";
  // Thermometer fill: darkens with propensity (blue range), red when voted (also darkens)
  const thermFillColor = voted
    ? "#22c55e"
    : `hsl(215,${blueSat}%,${blueLit - 10}%)`;

  // peg-doll geometry (centred at 0,0 = head centre)
  const headR = 17;
  const shoulderY = headR + 2;
  const bodyH = 50, topW = 19, botW = 48;
  const hw1 = topW / 2, hw2 = botW / 2;
  const bodyPath = `M${-hw1},${shoulderY} L${hw1},${shoulderY} L${hw2},${shoulderY + bodyH} L${-hw2},${shoulderY + bodyH} Z`;

  // thermometer geometry (right side of figure)
  const thermX = hw2 + 16;
  const thermTop = -headR;
  const thermH = shoulderY + bodyH - thermTop;
  const thermW = 18;
  const thermR = thermW / 2;
  const fillH = thermH * propensity;

  return (
    <g transform={`translate(${x},${y})`} onClick={onClick} style={{ cursor: "pointer" }}>
      {/* Selection / CF ring */}
      {isSelected && <circle r={hw2 + 6} fill="none" stroke="#2563eb" strokeWidth="1.8" strokeDasharray="4 3" opacity={0.7} />}
      {isCF && <circle r={hw2 + 8} fill="#f59e0b14" stroke="#f59e0b" strokeWidth="1.8" />}

      {/* ── Peg-doll body ── */}
      {/* Body fill */}
      <path d={bodyPath} fill={bodyColor} stroke={strokeC} strokeWidth="1.8" strokeLinejoin="round" />
      {/* Subtle stripe texture */}
      {[0.25, 0.5, 0.75].map(t => (
        <line key={t}
          x1={-hw2 + (hw2 - hw1) * (1 - t)} y1={shoulderY + bodyH * t}
          x2={hw2 - (hw2 - hw1) * (1 - t)}  y2={shoulderY + bodyH * t}
          stroke={strokeC} strokeWidth="0.6" opacity="0.25" />
      ))}
      {/* Neck */}
      <rect x="-3" y={shoulderY - 4} width="6" height="6" fill={bodyColor} stroke={strokeC} strokeWidth="1.2" />
      {/* Head */}
      <circle cy={0} r={headR} fill={bodyColor} stroke={strokeC} strokeWidth="1.8" />

      {/* ── Thermometer ── */}
      {!showDefault && <>
      {/* Track */}
      <rect x={thermX - thermR} y={thermTop} width={thermW} height={thermH} rx={thermR} fill="#e2e8f0" stroke="#cbd5e1" strokeWidth="0.8" />
      {/* Base fill */}
      {propensity > 0 && (
        <rect x={thermX - thermR} y={thermTop + thermH - fillH} width={thermW} height={fillH}
          rx={thermR} fill={thermFillColor} opacity="0.9" />
      )}
      </>}
      {/* Influence boost — no separate highlight, fill just rises */}


      {/* Name below */}
      <text y={shoulderY + bodyH + 32} textAnchor="middle" dominantBaseline="middle" fontSize="36" fill="#1e293b" fontWeight="700" fontFamily="'Georgia','Times New Roman',serif" style={{ pointerEvents: "none" }}>{nodeId}</text>

      {/* Checkmark over head when voted */}
      {voted && (
        <text x={0} y={-headR - 8} textAnchor="middle" fontSize="32" fill="#15803d" fontWeight="900"
          fontFamily="sans-serif" style={{ pointerEvents: "none" }}>✓</text>
      )}
    </g>
  );
}

// ─── Mini person for setup page ──────────────────────────────────────────────
function MiniPerson({ propensity, size = 32 }) {
  const blueLit = Math.round(88 - propensity * 45);
  const blueSat = Math.round(40 + propensity * 40);
  const body = `hsl(215,${blueSat}%,${blueLit}%)`;
  const stroke = `hsl(215,${blueSat}%,${blueLit - 15}%)`;
  const text = propensity > 0.6 ? "white" : "#1e3a8a";
  const s = size / 32; // scale factor
  return (
    <svg width={size} height={size * 1.35} viewBox="-16 -16 32 44" style={{ overflow: "visible", flexShrink: 0 }}>
      {/* Legs */}
      <line x1="-3.5" y1="16" x2="-6" y2="27" stroke={stroke} strokeWidth={2.2/s} strokeLinecap="round" />
      <line x1="3.5" y1="16" x2="6" y2="27" stroke={stroke} strokeWidth={2.2/s} strokeLinecap="round" />
      {/* Arms */}
      <line x1="-2" y1="5" x2="-10" y2="13" stroke={stroke} strokeWidth={2.2/s} strokeLinecap="round" />
      <line x1="2" y1="5" x2="10" y2="13" stroke={stroke} strokeWidth={2.2/s} strokeLinecap="round" />
      {/* Torso */}
      <rect x="-4.5" y="0" width="9" height="16" rx="2.5" fill={body} stroke={stroke} strokeWidth={1.5/s} />
      {/* Head */}
      <circle cy="-8" r="7" fill={body} stroke={stroke} strokeWidth={1.8/s} />
    </svg>
  );
}

// ─── Network graph ────────────────────────────────────────────────────────────
function NetworkGraph({ positions, edges, state, nextDayState, frozenPropensity, selectedNode, onSelectNode, onSelectEdge, cfNode, showWeights, showDefault, onHoverEdge, hoveredKey, highlightEdgeIdx }) {
  return (
    <svg viewBox="0 0 1400 1060" style={{ width: "100%", height: "100%" }}>
      <defs>
        {[["94a3b8","#94a3b8"],["e85d42","#22c55e"],["2563eb","#2563eb"],["1d4ed8","#1d4ed8"],["60a5fa","#60a5fa"]].map(([id,col]) => (
          <marker key={id} id={`arr-${id}`} markerWidth="4" markerHeight="4" refX="0" refY="2" orient="auto">
            <path d="M0,0.5 L3.5,2 L0,3.5 Z" fill={col} />
          </marker>
        ))}
      </defs>
      {edges.map((e, ei) => {
        const selInv = selectedNode === e.from || selectedNode === e.to;
        const isHighlightedEdge = highlightEdgeIdx === ei;

        // Check if a reverse arrow exists — if so, offset both to opposite sides
        const hasReverse = edges.some((o, oi) => oi !== ei && o.from === e.to && o.to === e.from);
        // For offsetting: if reverse exists, always put this arrow on the +perp side
        // (the reverse arrow will naturally be on -perp side since its direction is flipped)
        const LANE = hasReverse ? 18 : 0;

        const p1 = positions[e.from], p2 = positions[e.to];
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len, uy = dy / len;
        const perpX = -uy, perpY = ux;

        const sw = e.w <= 0.1 ? 5 : e.w <= 0.2 ? 8 : 13;
        const arrowLen = sw * 4;

        // Figure geometry (must match PersonFigure):
        // headR=14, shoulderY=16, bodyH=42, botW=40, thermX=hw2+5=25, thermW=4
        // Visual bounds from anchor (head centre):
        //   left:  -hw2 = -20
        //   right: thermX + thermW/2 = 27   (thermometer sticks right)
        //   top:   -headR = -14
        //   bottom: shoulderY + bodyH + 14 = 72  (pill below)
        // For clearance from the anchor point in direction (ux,uy):
        // project the four corners and take the max distance
        const corners = [[-24,-17],[49,-17],[49,80],[-24,80]];
        const projDist = (node) => {
          const np = positions[node];
          // direction from this node outward
          const ddx = positions[e.to].x - positions[e.from].x;
          const ddy = positions[e.to].y - positions[e.from].y;
          const dl = Math.sqrt(ddx*ddx+ddy*ddy)||1;
          const uux = (node===e.from?1:-1)*ddx/dl;
          const uuy = (node===e.from?1:-1)*ddy/dl;
          return Math.max(...corners.map(([cx,cy]) => cx*uux + cy*uuy)) + 18;
        };
        const NR_src = Math.max(projDist(e.from), 14);
        const NR_tgt = Math.max(projDist(e.to), 14);

        const sx = p1.x + ux * NR_src, sy = p1.y + uy * NR_src;
        const ex2 = p2.x - ux * (NR_tgt + arrowLen) + perpX * LANE, ey2 = p2.y - uy * (NR_tgt + arrowLen) + perpY * LANE;

        const voted = state[e.from].voted;
        const isHov = hoveredKey === `${ei}`;
        const col = isHighlightedEdge ? "#1d4ed8" : isHov ? "#60a5fa" : selInv ? "#2563eb" : "#94a3b8";
        const opacity = isHighlightedEdge ? 1 : isHov ? 0.95 : selInv ? 0.85 : 0.5;
        const midX = (sx + ex2) / 2, midY = (sy + ey2) / 2;
        const markerId = col.replace('#','');

        return (
          <g key={ei}
            onMouseEnter={() => onHoverEdge(`${ei}`, { edgeIdx: ei, from: e.from, to: e.to, w: e.w })}
            onMouseLeave={() => onHoverEdge(null, null)}
            onClick={() => onSelectEdge(ei)}
            style={{ cursor: "pointer" }}>
            <line x1={sx} y1={sy} x2={ex2} y2={ey2} stroke="transparent" strokeWidth={sw + 12} />
            <line x1={sx} y1={sy} x2={ex2} y2={ey2}
              stroke={col} strokeWidth={sw} strokeLinecap="butt"
              opacity={opacity}
              markerEnd={`url(#arr-${markerId})`}
            />
            {isHighlightedEdge && (
              <text x={midX + perpX * (sw / 2 + 7)} y={midY + perpY * (sw / 2 + 7)}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="8" fill={isHighlightedEdge ? "#1d4ed8" : "#64748b"}
                fontWeight={isHighlightedEdge ? "700" : "400"}
                fontFamily="'DM Mono',monospace">{e.w.toFixed(2)}</text>
            )}
          </g>
        );
      })}

      {positions.map((pos, i) => (
        <PersonFigure key={i} x={pos.x} y={pos.y}
          propensity={showDefault ? 0.5 : state[i].voted ? (frozenPropensity?.[i] ?? state[i].propensity) : nextDayState ? nextDayState[i].propensity : state[i].propensity}
          influenceReceived={showDefault ? 0 : nextDayState ? (nextDayState[i].influenceReceived ?? 0) : 0}
          voted={showDefault ? false : state[i].voted}
          isSelected={!showDefault && selectedNode === i}
          isCF={!showDefault && cfNode === i}
          showDefault={showDefault}
          nodeId={state[i].name || i}
          onClick={() => onSelectNode(i)}
        />
      ))}
    </svg>
  );
}

// ─── Mini components ──────────────────────────────────────────────────────────
const mono = { fontFamily: "'DM Mono',monospace" };
const SH = ({ children }) => <div style={{ ...mono, fontSize: 9, color: "#94a3b8", letterSpacing: "0.12em", marginBottom: 7 }}>{children}</div>;
const Divider = () => <div style={{ height: 1, background: "#f1f5f9", margin: "12px 0" }} />;
const Card = ({ children, style = {} }) => <div style={{ background: "white", border: "1.5px solid #e2e8f0", borderRadius: 9, ...style }}>{children}</div>;

function NumSlider({ label, value, min, max, step = 0.01, onChange, color = "#2563eb", onMouseUp, onTouchEnd }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ ...mono, fontSize: 10, color: "#64748b" }}>{label}</span>
        <span style={{ ...mono, fontSize: 10, fontWeight: 700, color: "#1e293b" }}>
          {typeof value === "number" && step < 1 ? value.toFixed(2) : value}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        onMouseUp={onMouseUp}
        onTouchEnd={onTouchEnd}
        style={{ width: "100%", accentColor: color }} />
    </div>
  );
}

function PropBar({ value, max = 1, color = "#2563eb", h = 5 }) {
  return (
    <div style={{ height: h, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${Math.min(100, (value / max) * 100)}%`, background: color, borderRadius: 99, transition: "width 0.2s" }} />
    </div>
  );
}

// Default node params factory
function makeNodes(n, seed = 42) {
  const rng = mulberry32(seed);
  const NAME_POOL = ["Alex","Sam","Kai","River","Jordan","Casey","Quinn","Reese","Sage","Blake","Avery","Morgan","Jamie","Rowan","Taylor","Drew","Finley","Hayden","Parker","Robin","Skyler","Eden","Ash","Arlo","Remy","Nova","Wren","Emery","Peyton","Shiloh","Elliot","Sasha","Briar","Cleo","August","Fern","Juno","Reed","Atlas","Cruz","Orion","Sloane","Devin","Flynn","Rio","Noor","Indigo","Marlowe","Lennox","Vesper"];
  // Shuffle by seed, take first n
  const nameArr = [...NAME_POOL];
  for (let i = nameArr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [nameArr[i], nameArr[j]] = [nameArr[j], nameArr[i]];
  }
  const names = nameArr.slice(0, n);
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: names[i] || String(i),
    propensity: PROP_VALS[Math.floor(rng() * 3)],
    forceVoteDay: null,
    influence: Math.round((0.10 + rng() * 0.25) * 100) / 100,
  }));
}

// ─── Setup graph preview ─────────────────────────────────────────────────────
function SetupGraph({ nodes, edges, selectedNodeIdx, onSelectNode }) {
  const n = nodes.length;
  // Lay out nodes in a circle
  const cx = 200, cy = 200, r = 150;
  const positions = nodes.map((_, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

  return (
    <svg viewBox="0 0 400 400" style={{ width: "100%", height: "100%" }}>
      <defs>
        <marker id="sg-arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,1 L6,3.5 L0,6 Z" fill="#94a3b8" />
        </marker>
        <marker id="sg-arr-sel" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,1 L6,3.5 L0,6 Z" fill="#2563eb" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((e, ei) => {
        const p1 = positions[e.from], p2 = positions[e.to];
        if (!p1 || !p2) return null;
        const isSel = selectedNodeIdx === e.from || selectedNodeIdx === e.to;
        {
          const p1s = positions[e.from], p2s = positions[e.to];
          const dx = p2s.x - p1s.x, dy = p2s.y - p1s.y;
          const len = Math.sqrt(dx*dx + dy*dy) || 1;
          const ux = dx/len, uy = dy/len;
          const px = -uy * 3, py = ux * 3;
          const NR = 18;
          const sx = p1s.x + ux*NR + px, sy = p1s.y + uy*NR + py;
          const ex = p2s.x - ux*(NR+6) + px, ey = p2s.y - uy*(NR+6) + py;
          const col = isSel ? "#2563eb" : "#94a3b8";
          const sw = 1.5;
          return (
            <line key={ei}
              x1={sx} y1={sy} x2={ex} y2={ey}
              stroke={col} strokeWidth={sw}
              opacity={isSel ? 0.8 : 0.35}
              markerEnd={isSel ? "url(#sg-arr-sel)" : "url(#sg-arr)"}
            />
          );
        }
      })}

      {/* Nodes — peg-doll matching main sim */}
      {nodes.map((nd, i) => {
        const pos = positions[i];
        if (!pos) return null;
        const p = nd.propensity;
        const blueLit = Math.round(88 - p * 45);
        const blueSat = Math.round(40 + p * 40);
        const body = `hsl(215,${blueSat}%,${blueLit}%)`;
        const stroke = `hsl(215,${blueSat}%,${blueLit - 15}%)`;
        const textC = "#1e293b";
        const isSel = selectedNodeIdx === i;
        // peg-doll geometry (scaled down ~0.55x for preview)
        const hR=8, sY=hR+1, bH=24, tW=9, bW=22, hw1=tW/2, hw2=bW/2;
        const bPath = `M${-hw1},${sY} L${hw1},${sY} L${hw2},${sY+bH} L${-hw2},${sY+bH} Z`;
        const thermX=hw2+3, thermTop=-hR, thermH=sY+bH-thermTop, tW2=3, tR=1.5;
        const fillH=thermH*p;
        const thermFill=`hsl(215,${blueSat}%,${blueLit-10}%)`;
        return (
          <g key={i} transform={`translate(${pos.x},${pos.y})`}
            onClick={() => onSelectNode(isSel ? null : i)}
            style={{ cursor: "pointer" }}>
            {isSel && <circle r={hw2+6} fill="none" stroke="#2563eb" strokeWidth="1.5" strokeDasharray="4 3" opacity={0.7} />}
            {/* Peg-doll body */}
            <path d={bPath} fill={body} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />
            <rect x="-2" y={sY-3} width="4" height="4" fill={body} stroke={stroke} strokeWidth="1" />
            <circle cy={0} r={hR} fill={body} stroke={stroke} strokeWidth="1.2" />
            {/* Thermometer */}
            <rect x={thermX-tR} y={thermTop} width={tW2} height={thermH} rx={tR} fill="#e2e8f0" stroke="#cbd5e1" strokeWidth="0.6" />
            {p > 0 && <rect x={thermX-tR} y={thermTop+thermH-fillH} width={tW2} height={fillH} rx={tR} fill={thermFill} opacity="0.9" />}
            {/* Name pill */}
            <rect x={-hw2} y={sY+bH+2} width={bW} height={11} rx="3" fill="white" stroke="#1e293b" strokeWidth="0.8" style={{ pointerEvents:"none" }} />
            <text y={sY+bH+8} textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="#1e293b" fontWeight="700" fontFamily="'DM Mono',monospace" style={{ pointerEvents:"none" }}>{nd.name || i}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── SETUP PAGE ───────────────────────────────────────────────────────────────
function SetupPage({ setupNodes, setupEdges, setupNodeCount, handleSetupNodeCount, handleSetupNodeField,
  addSetupEdge, removeSetupEdge, handleSetupEdgeField, setupFrom, setSetupFrom, setupTo, setSetupTo,
  globalConfig, setGlobalConfig, simResult, onCancel, onLaunch }) {

  const [tab, setTab] = useState("nodes");
  const [selectedNodeIdx, setSelectedNodeIdx] = useState(null);
  const [leftW, setLeftW] = useState(260);
  const [midW, setMidW] = useState(null); // null = flex:1
  const [rightW, setRightW] = useState(360);
  const draggingDivider = useRef(null); // "left" | "right"
  const dragStartX = useRef(0);
  const dragStartW = useRef(0);
  const thresholdBarRef = useRef(null);
  const draggingThreshold = useRef(false);
  const n = setupNodes.length;
  const threshold = globalConfig.threshold;
  const mono = { fontFamily: "'DM Mono',monospace" };

  const likelyVoters = setupNodes.filter(nd => nd.propensity > 0.5).length;
  const willPass = threshold <= likelyVoters;

  const handleThresholdDrag = (clientX) => {
    const bar = thresholdBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const val = Math.max(1, Math.min(n, Math.round(1 + pct * (n - 1))));
    setGlobalConfig(g => ({ ...g, threshold: val }));
  };

  const sortedNodes = [...setupNodes].map((nd, i) => ({ ...nd, origIdx: i })).sort((a, b) => b.propensity - a.propensity);

  const passColor = "#22c55e";
  const failColor = "#dc2626";
  const stateColor = willPass ? passColor : failColor;
  const stateBg = willPass ? "#f0fdf4" : "#fef2f2";
  const stateBorder = willPass ? "#dcfce7" : "#dcfce7";

  const onDividerMouseDown = (which, e) => {
    draggingDivider.current = which;
    dragStartX.current = e.clientX;
    dragStartW.current = which === "left" ? leftW : rightW;
    e.preventDefault();
  };

  const onDividerMouseMove = (e) => {
    if (!draggingDivider.current) return;
    const dx = e.clientX - dragStartX.current;
    if (draggingDivider.current === "left") {
      setLeftW(Math.max(180, Math.min(420, dragStartW.current + dx)));
    } else {
      setRightW(Math.max(200, Math.min(480, dragStartW.current - dx)));
    }
  };

  const onDividerMouseUp = () => { draggingDivider.current = null; };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "#f1f5f9", display: "flex", flexDirection: "column", overflow: "hidden", userSelect: draggingDivider.current ? "none" : "auto" }}
      onMouseMove={onDividerMouseMove}
      onMouseUp={onDividerMouseUp}
      onMouseLeave={onDividerMouseUp}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,600;0,700;1,300&family=DM+Mono:wght@400;500&display=swap');
        .sp-node-row { transition: background 0.1s; border-radius: 8px; }
        .sp-node-row:hover { background: #f1f5f9; }
        .sp-range { -webkit-appearance: none; appearance: none; height: 5px; border-radius: 99px; outline: none; cursor: pointer; width: 100%; }
        .sp-range::-webkit-slider-thumb { -webkit-appearance: none; width: 17px; height: 17px; border-radius: 50%; cursor: grab; border: 2.5px solid white; box-shadow: 0 0 0 1.5px #2563eb, 0 2px 6px #2563eb44; background: #2563eb; }
        .sp-tab { font-family: 'DM Mono',monospace; font-size: 11px; padding: 8px 16px; border: none; cursor: pointer; border-radius: 6px; transition: all 0.15s; font-weight: 500; letter-spacing: 0.04em; }
        .sp-tab-on { background: #2563eb; color: white; }
        .sp-tab-off { background: transparent; color: #94a3b8; }
        .sp-tab-off:hover { color: #475569; }
        .sp-input { font-family: 'DM Mono',monospace; font-size: 13px; font-weight: 600; background: white; border: 1.5px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; color: #1e293b; outline: none; text-align: center; }
        .sp-input:focus { border-color: #93c5fd; background: #eff6ff; }
        .sp-select { font-family: 'DM Mono',monospace; font-size: 12px; font-weight: 600; background: white; border: 1.5px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; color: #1e293b; outline: none; }
        .sp-select:focus { border-color: #93c5fd; }
        .sp-scrollbar::-webkit-scrollbar { width: 4px; }
        .sp-scrollbar::-webkit-scrollbar-track { background: #f8fafc; }
        .sp-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
      `}</style>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", padding: "14px 28px", borderBottom: "1.5px solid #e2e8f0", background: "white", flexShrink: 0 }}>
        <div>
          <div style={{ fontFamily: "'Fraunces',serif", fontSize: 20, fontWeight: 700, color: "#1e293b", letterSpacing: "-0.02em" }}>
            Network Voting Simulator
          </div>
          <div style={{ ...mono, fontSize: 10, color: "#94a3b8", marginTop: 2 }}>configure your network, then run</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {simResult && (
            <button className="sp-tab sp-tab-off" onClick={onCancel} style={{ border: "1.5px solid #e2e8f0" }}>← back to results</button>
          )}
          <button onClick={onLaunch}
            style={{ fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 700, background: "#2563eb", color: "white", border: "none", borderRadius: 8, padding: "10px 28px", cursor: "pointer", letterSpacing: "0.04em", boxShadow: "0 2px 8px #2563eb44" }}>
            ▶ RUN SIMULATION
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* LEFT: threshold + settings */}
        <div className="sp-scrollbar" style={{ width: leftW, borderRight: "none", background: "white", display: "flex", flexDirection: "column", padding: "24px 20px", overflowY: "auto", flexShrink: 0 }}>

          {/* Big threshold display */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ ...mono, fontSize: 9, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.12em", marginBottom: 14 }}>VOTE THRESHOLD</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 72, fontWeight: 700, lineHeight: 1, color: stateColor, transition: "color 0.25s" }}>
                {threshold}
              </div>
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 22, color: "#cbd5e1" }}>/ {n}</div>
            </div>
            <div style={{ marginBottom: 20 }} />

            {/* Drag bar */}
            <div
              ref={thresholdBarRef}
              style={{ position: "relative", height: 52, cursor: "ew-resize", userSelect: "none", marginBottom: 6 }}
              onMouseDown={e => { draggingThreshold.current = true; handleThresholdDrag(e.clientX); }}
              onMouseMove={e => { if (draggingThreshold.current) handleThresholdDrag(e.clientX); }}
              onMouseUp={() => { draggingThreshold.current = false; }}
              onMouseLeave={() => { draggingThreshold.current = false; }}
              onTouchStart={e => { draggingThreshold.current = true; handleThresholdDrag(e.touches[0].clientX); e.preventDefault(); }}
              onTouchMove={e => { if (draggingThreshold.current) { handleThresholdDrag(e.touches[0].clientX); e.preventDefault(); } }}
              onTouchEnd={() => { draggingThreshold.current = false; }}
            >
              {/* Track bg */}
              <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 8, transform: "translateY(-50%)", background: "#f1f5f9", borderRadius: 99, border: "1px solid #e2e8f0" }}>
                <div style={{ height: "100%", width: `${n > 1 ? ((threshold - 1) / (n - 1)) * 100 : 100}%`, background: stateColor, borderRadius: 99, transition: "background 0.25s, width 0.1s" }} />
              </div>
              {/* Tick dots */}
              {Array.from({ length: n }, (_, i) => (
                <div key={i} style={{
                  position: "absolute", top: "50%",
                  left: `${n > 1 ? (i / (n - 1)) * 100 : 0}%`,
                  transform: "translate(-50%, -50%)",
                  width: 8, height: 8, borderRadius: "50%",
                  background: i < threshold ? stateColor : "white",
                  border: `1.5px solid ${i < threshold ? stateColor : "#cbd5e1"}`,
                  transition: "all 0.15s", zIndex: 2,
                }} />
              ))}
              {/* Handle */}
              <div style={{
                position: "absolute", top: "50%",
                left: `${n > 1 ? ((threshold - 1) / (n - 1)) * 100 : 0}%`,
                transform: "translate(-50%, -50%)",
                width: 28, height: 28, borderRadius: "50%",
                background: stateColor,
                border: "3px solid white",
                boxShadow: `0 0 0 2px ${stateColor}44, 0 4px 12px ${stateColor}44`,
                zIndex: 3, display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.25s, box-shadow 0.25s",
              }}>
                <span style={{ ...mono, fontSize: 10, fontWeight: 700, color: "white" }}>{threshold}</span>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", ...mono, fontSize: 9, color: "#cbd5e1" }}>
              <span>1</span><span style={{ color: "#94a3b8" }}>← drag to set →</span><span>{n}</span>
            </div>
          </div>

          {/* Settings */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ ...mono, fontSize: 9, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.12em", marginBottom: 14 }}>SETTINGS</div>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 6 }}>NODES</div>
                <input className="sp-input" type="number" min={2} max={25} value={setupNodeCount}
                  onChange={e => handleSetupNodeCount(Number(e.target.value))} style={{ width: "100%" }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 6 }}>DAYS</div>
                <input className="sp-input" type="number" min={1} max={30} value={globalConfig.days}
                  onChange={e => setGlobalConfig(g => ({ ...g, days: Number(e.target.value) }))} style={{ width: "100%" }} />
              </div>
            </div>
          </div>

          {/* Node overview bubbles */}
          <div>
            <div style={{ ...mono, fontSize: 9, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.12em", marginBottom: 12 }}>PROPENSITY OVERVIEW</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {sortedNodes.map((nd) => {
                const bl = Math.round(88 - nd.propensity * 45), bs = Math.round(40 + nd.propensity * 40);
                const tc = nd.propensity > 0.6 ? "white" : "#1e3a8a";
                return (
                  <div key={nd.origIdx} title={`${nd.name || nd.origIdx}: p=${nd.propensity.toFixed(2)}`}
                    style={{ width: 38, height: 38, borderRadius: 8,
                      background: `hsl(215,${bs}%,${bl}%)`,
                      border: `1.5px solid hsl(215,${bs}%,${bl - 15}%)`,
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ ...mono, fontSize: 8, color: "#1e293b" }}>{nd.name || nd.origIdx}</div>
                    <div style={{ ...mono, fontSize: 10, fontWeight: 700, color: "#1e293b" }}>{(nd.propensity * 100).toFixed(0)}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ ...mono, fontSize: 9, color: "#cbd5e1", marginTop: 8 }}>sorted high → low · edit in Nodes tab</div>
          </div>
        </div>

        {/* Divider left */}
        <div onMouseDown={e => onDividerMouseDown("left", e)}
          style={{ width: 5, background: "transparent", cursor: "col-resize", flexShrink: 0, borderRight: "1.5px solid #e2e8f0", transition: "background 0.15s" }}
          onMouseEnter={e => e.currentTarget.style.background = "#dbeafe"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"} />

        {/* MIDDLE: node/edge tables */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 4, padding: "14px 24px 0", borderBottom: "1.5px solid #e2e8f0", background: "#fafafa", flexShrink: 0 }}>
            {[["nodes", `Nodes (${setupNodes.length})`], ["edges", `Edges (${setupEdges.length})`]].map(([id, lbl]) => (
              <button key={id} className={`sp-tab ${tab === id ? "sp-tab-on" : "sp-tab-off"}`} onClick={() => setTab(id)}>{lbl}</button>
            ))}
          </div>

          <div className="sp-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "20px 24px", background: "#fafafa" }}>

            {/* NODES */}
            {tab === "nodes" && (
              <div>
                <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 14 }}>
                  Propensity = daily probability of voting. Drag the slider or type a value (0.01 – 0.99).
                </div>
                {setupNodes.map((nd, i) => {
                  const _bl = Math.round(88 - nd.propensity * 45), _bs = Math.round(40 + nd.propensity * 40);
                  return (
                    <div key={i} className="sp-node-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 8px", marginBottom: 2 }}>
                      <div style={{ width: 44, display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, gap: 1 }}>
                        <MiniPerson propensity={nd.propensity} size={28} />
                        <span style={{ ...mono, fontSize: 11, fontWeight: 700, color: "#1e293b", minWidth: 20 }}>{nd.name || i}</span>
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[0.2, 0.5, 0.8].map(v => (
                          <button key={v} onClick={() => handleSetupNodeField(i, "propensity", v)}
                            style={{ ...mono, fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, cursor: "pointer", border: nd.propensity === v ? "2px solid #2563eb" : "1.5px solid #e2e8f0", background: nd.propensity === v ? "#eff6ff" : "white", color: nd.propensity === v ? "#2563eb" : "#64748b" }}>{v}</button>
                        ))}
                      </div>
                      <div style={{ width: 34, ...mono, fontSize: 11, fontWeight: 700, color: "#1e293b", textAlign: "right" }}>{(nd.propensity * 100).toFixed(0)}%</div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* EDGES */}
            {tab === "edges" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "#f0fdf4", border: "1.5px solid #bbf7d0", borderRadius: 10, marginBottom: 18 }}>
                  <span style={{ ...mono, fontSize: 9, color: "#166534", fontWeight: 700, letterSpacing: "0.1em" }}>ADD</span>
                  <select className="sp-select" value={setupFrom} onChange={e => setSetupFrom(Number(e.target.value))}>
                    {setupNodes.map((nd, i) => <option key={i} value={i}>{nd.name || i}</option>)}
                  </select>
                  <span style={{ ...mono, fontSize: 12, color: "#94a3b8" }}>↔</span>
                  <select className="sp-select" value={setupTo} onChange={e => setSetupTo(Number(e.target.value))}>
                    {setupNodes.map((nd, i) => <option key={i} value={i}>{nd.name || i}</option>)}
                  </select>
                  <button onClick={() => addSetupEdge(setupFrom, setupTo)}
                    disabled={setupFrom === setupTo || setupEdges.some(e => e.from === setupFrom && e.to === setupTo)}
                    style={{ ...mono, fontSize: 11, fontWeight: 700, background: "#22c55e", color: "white", border: "none", borderRadius: 6, padding: "7px 14px", cursor: "pointer",
                      opacity: (setupFrom === setupTo || setupEdges.some(e => e.from === setupFrom && e.to === setupTo)) ? 0.4 : 1 }}>
                    + add arrow
                  </button>
                </div>
                {setupEdges.length === 0 ? (
                  <div style={{ ...mono, fontSize: 12, color: "#94a3b8", textAlign: "center", padding: "40px 0" }}>No edges yet.</div>
                ) : setupEdges.map((e, idx) => (
                  <div key={idx} style={{ display: "grid", gridTemplateColumns: "110px 1fr 1fr 32px", alignItems: "center", gap: 14, padding: "14px 8px", borderBottom: "1px solid #e2e8f0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ background: "#dbeafe", color: "#2563eb", padding: "3px 9px", borderRadius: 5, fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 700 }}>{setupNodes[e.from]?.name ?? e.from}</span>
                      <span style={{ color: "#cbd5e1", fontFamily: "'DM Mono',monospace" }}>→</span>
                      <span style={{ background: "#dbeafe", color: "#2563eb", padding: "3px 9px", borderRadius: 5, fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 700 }}>{setupNodes[e.to]?.name ?? e.to}</span>
                    </div>
                    <div>
                      <div style={{ ...mono, fontSize: 9, color: "#2563eb", marginBottom: 5 }}>{setupNodes[e.from]?.name ?? e.from} → {setupNodes[e.to]?.name ?? e.to}: {e.w.toFixed(2)}</div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[0.1, 0.2, 0.3].map(v => (
                          <button key={v} onClick={() => handleSetupEdgeField(idx, "w", v)}
                            style={{ ...mono, fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, cursor: "pointer", border: e.w === v ? "2px solid #2563eb" : "1.5px solid #e2e8f0", background: e.w === v ? "#eff6ff" : "white", color: e.w === v ? "#2563eb" : "#64748b" }}>{v}</button>
                        ))}
                      </div>
                      <input type="range" className="sp-range" min={0} max={0.6} step={0.01} value={e.w} style={{display:"none"}}
                        onChange={ev => handleSetupEdgeField(idx, "w", Math.min(0.6, Math.max(0, Number(ev.target.value))))}
                        style={{ background: `linear-gradient(to right, #2563eb ${(e.w/0.6)*100}%, #e2e8f0 ${(e.w/0.6)*100}%)` }} />
                    </div>
                    <button onClick={() => removeSetupEdge(idx)}
                      style={{ ...mono, fontSize: 18, background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", lineHeight: 1 }}
                      onMouseEnter={ev => ev.target.style.color = "#22c55e"}
                      onMouseLeave={ev => ev.target.style.color = "#cbd5e1"}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Divider right */}
        <div onMouseDown={e => onDividerMouseDown("right", e)}
          style={{ width: 5, background: "transparent", cursor: "col-resize", flexShrink: 0, borderLeft: "1.5px solid #e2e8f0", transition: "background 0.15s" }}
          onMouseEnter={e => e.currentTarget.style.background = "#dbeafe"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"} />

        {/* RIGHT: network graph preview */}
        <div style={{ width: rightW, background: "#f8fafc", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          <div style={{ padding: "12px 16px 10px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.12em" }}>NETWORK PREVIEW</span>
            {selectedNodeIdx !== null && <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, color: "#2563eb" }}>· {setupNodes[selectedNodeIdx]?.name ?? selectedNodeIdx} selected</span>}
          </div>
          <div style={{ flex: 1 }}>
            <SetupGraph nodes={setupNodes} edges={setupEdges} selectedNodeIdx={selectedNodeIdx} onSelectNode={setSelectedNodeIdx} />
          </div>
          <div style={{ padding: "8px 16px 10px", borderTop: "1px solid #e2e8f0" }}>
            <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, color: "#cbd5e1" }}>click a person to highlight connections</span>
          </div>
        </div>

      </div>
    </div>
  );
}


// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [nodeCount, setNodeCount] = useState(10);
  const [nodeParams, setNodeParams] = useState(() => makeNodes(10));
  const [edges, setEdges] = useState([]);
  const [positions, setPositions] = useState([]);
  const [adjMap, setAdjMap] = useState([]);
  const [globalConfig, setGlobalConfig] = useState({ days: 7, threshold: 6, simSeed: 42 });
  const [targetOutcome, setTargetOutcome] = useState(null);
  const [keyAgents, setKeyAgents] = useState(new Set()); // indices of agents to highlight in trial

  const toggleKeyAgent = (i) => {
    setKeyAgents(prev => {
      const next = new Set(prev);
      if (next.has(i)) { next.delete(i); }
      else if (next.size < 7) { next.add(i); }
      return next;
    });
  }; // null = no target, "never" = never pass, 1..N = pass on day N
  const [networkSeed, setNetworkSeed] = useState(42);
  const [simResult, setSimResult] = useState(null);
  const [cfResult, setCfResult] = useState(null);
  const [currentDay, setCurrentDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdgeIdx, setSelectedEdgeIdx] = useState(null); // graph highlight only
  const [expandedEdgeIdx, setExpandedEdgeIdx] = useState(null); // panel expansion only
  const [draggingEdgeIdx, setDraggingEdgeIdx] = useState(null);
  const [addEdgeFrom, setAddEdgeFrom] = useState(0);
  const [addEdgeTo, setAddEdgeTo] = useState(1);
  const [cfNode, setCfNode] = useState(null);
  const [cfDay, setCfDay] = useState(1);
  const [showCf, setShowCf] = useState(false);
  const [showWeights, setShowWeights] = useState(true);
  const [showDefault, setShowDefault] = useState(false); // grey figures, no bars
  const [hovKey, setHovKey] = useState(null);
  const [hovInfo, setHovInfo] = useState(null);
  const [panel, setPanel] = useState("nodes"); // nodes | edges | log | cf
  const playRef = useRef(null);
  const [simLeftW, setSimLeftW] = useState(250);
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 });
  const graphPanning = useRef(false);
  const graphPanStart = useRef({ x: 0, y: 0 });
  const graphPanOrigin = useRef({ x: 0, y: 0 });
  const graphContainerRef = useRef(null);
  const [simRightW, setSimRightW] = useState(240);
  const simDragging = useRef(null); // "left" | "right"
  const simDragStartX = useRef(0);
  const simDragStartW = useRef(0);

  const [showSetup, setShowSetup] = useState(true);
  const [setupNodes, setSetupNodes] = useState(() => makeNodes(10));
  const [setupEdges, setSetupEdges] = useState([]);
  const [setupNodeCount, setSetupNodeCount] = useState(10);
  const [setupTab, setSetupTab] = useState("nodes"); // nodes | edges

  // Generate network
  const regenerate = useCallback((params, nSeed) => {
    const pos = layoutNodes(params.length, nSeed);
    const newEdges = autoEdges(params, nSeed);
    const am = buildNetwork(params, newEdges);
    setPositions(pos);
    setEdges(newEdges);
    setAdjMap(am);
    return { newEdges, am };
  }, []);

  const runSim = useCallback((params, am, gcfg, forcedFlip = null, seed = null) => {
    // Use a truly random seed each time (not the fixed simSeed) so draws vary every run
    const useSeed = seed ?? (Date.now() ^ Math.floor(Math.random() * 0xffffffff));
    return runSimulation(params, am, gcfg.days, gcfg.threshold, useSeed, forcedFlip);
  }, []);

  // Store the last sim seed so CF can reuse the exact same draws
  const lastSimSeedRef = useRef(42);

  const runSimFresh = useCallback((params, am, gcfg) => {
    const seed = Date.now() ^ Math.floor(Math.random() * 0xffffffff);
    lastSimSeedRef.current = seed;
    return runSimulation(params, am, gcfg.days, gcfg.threshold, seed, null);
  }, []);

  const fullRebuild = useCallback(() => {
    setSetupNodes([...nodeParams]);
    setSetupEdges([...edges]);
    setSetupNodeCount(nodeCount);
    setSetupTab("nodes");
    setShowSetup(true);
  }, [nodeParams, edges, nodeCount]);

  // Re-run sim only (keep edges), fresh draws
  const reRunSim = useCallback((params = nodeParams, am = adjMap, gcfg = globalConfig) => {
    const r = runSimFresh(params, am, gcfg);
    setSimResult(r);
    setCfResult(null);
    setCurrentDay(0);
    setPlaying(false);
    setShowCf(false);
    clearInterval(playRef.current);
  }, [nodeParams, adjMap, globalConfig, runSimFresh]);

  const randomizeSim = useCallback(() => {
    const n = nodeParams.length;
    const days = globalConfig.days;
    const MAX_TRIES = 500;

    const matchesTarget = (r) => {
      if (targetOutcome === null) return true;
      if (targetOutcome === "never") return !r.passed;
      return r.passed && r.passedDay === Number(targetOutcome);
    };

    let bestParams, bestEdges, bestResult;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) + attempt * 1337);

      const NAME_POOL2 = ["Alex","Sam","Kai","River","Jordan","Casey","Quinn","Reese","Sage","Blake","Avery","Morgan","Jamie","Rowan","Taylor","Drew","Finley","Hayden","Parker","Robin","Skyler","Eden","Ash","Arlo","Remy","Nova","Wren","Emery","Peyton","Shiloh","Elliot","Sasha","Briar","Cleo","August","Fern","Juno","Reed","Atlas","Cruz","Orion","Sloane","Devin","Flynn","Rio","Noor","Indigo","Marlowe","Lennox","Vesper"];
      const nameArr2 = [...NAME_POOL2];
      for (let i = nameArr2.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [nameArr2[i], nameArr2[j]] = [nameArr2[j], nameArr2[i]];
      }

      const tryParams = nodeParams.map((p, i) => ({
        ...p,
        name: nameArr2[i] || String(i),
        propensity: PROP_VALS[Math.floor(rng() * 3)]
      }));
      const tryEdges = edges.map(e => ({
        ...e,
        w: EDGE_VALS[Math.floor(rng() * 3)]
      }));
      const am = buildNetwork(tryParams, tryEdges);
      const r = runSimulation(tryParams, am, days, globalConfig.threshold, Date.now() ^ (attempt * 999), null);

      if (!bestResult) { bestParams = tryParams; bestEdges = tryEdges; bestResult = r; }
      if (matchesTarget(r)) { bestParams = tryParams; bestEdges = tryEdges; bestResult = r; break; }
    }

    const am = buildNetwork(bestParams, bestEdges);
    setNodeParams(bestParams);
    setEdges(bestEdges);
    setAdjMap(am);
    const r = runSimFresh(bestParams, am, globalConfig);
    setSimResult(r);
    setCfResult(null);
    setCurrentDay(0);
  }, [nodeParams, edges, globalConfig, targetOutcome, runSimFresh]);

  const launchSim = useCallback((params, edgeList, gcfg) => {
    const pos = layoutNodes(params.length, networkSeed);
    const am = buildNetwork(params, edgeList);
    setPositions(pos);
    setNodeParams(params);
    setEdges(edgeList);
    setAdjMap(am);
    setNodeCount(params.length);
    const r = runSimFresh(params, am, gcfg);
    setSimResult(r);
    setCfResult(null);
    setCurrentDay(0);
    setPlaying(false);
    setShowCf(false);
    setShowSetup(false);
    clearInterval(playRef.current);
  }, [networkSeed, runSimFresh]);

  useEffect(() => {
    // Pre-populate setup edges for initial load
    const initNodes = makeNodes(10);
    const initEdges = autoEdges(initNodes, 42);
    setSetupNodes(initNodes);
    setSetupEdges(initEdges);
    setSetupNodeCount(10);
  }, []);

  // Setup modal helpers
  const handleSetupNodeCount = (n) => {
    const clamped = Math.max(2, Math.min(25, n));
    setSetupNodeCount(clamped);
    const current = setupNodes.length;
    if (clamped > current) {
      const rng = mulberry32(Date.now());
      const usedNames = new Set(setupNodes.map(n => n.name));
      const NAME_POOL4 = ["Alex","Sam","Kai","River","Jordan","Casey","Quinn","Reese","Sage","Blake","Avery","Morgan","Jamie","Rowan","Taylor","Drew","Finley","Hayden","Parker","Robin","Skyler","Eden","Ash","Arlo","Remy","Nova","Wren","Emery","Peyton","Shiloh","Elliot","Sasha","Briar","Cleo","August","Fern","Juno","Reed","Atlas","Cruz","Orion","Sloane","Devin","Flynn","Rio","Noor","Indigo","Marlowe","Lennox","Vesper"];
      const availNames = NAME_POOL4.filter(l => !usedNames.has(l));
      const extras = Array.from({ length: clamped - current }, (_, i) => ({
        id: current + i,
        name: availNames[i] || String(current + i),
        propensity: PROP_VALS[Math.floor(rng() * 3)],
      }));
      setSetupNodes([...setupNodes, ...extras]);
    } else {
      setSetupNodes(setupNodes.slice(0, clamped));
      setSetupEdges(setupEdges.filter(e => e.from < clamped && e.to < clamped));
    }
  };

  const handleSetupNodeField = (i, field, val) => {
    setSetupNodes(setupNodes.map((n, idx) => idx === i ? { ...n, [field]: val } : n));
  };

  const addSetupEdge = (from, to) => {
    if (from === to) return;
    if (setupEdges.some(e => e.from === from && e.to === to)) return;
    setSetupEdges([...setupEdges, { from, to, w: 0.20 }]);
  };

  const removeSetupEdge = (idx) => setSetupEdges(setupEdges.filter((_, i) => i !== idx));

  const handleSetupEdgeField = (idx, field, val) => {
    setSetupEdges(setupEdges.map((e, i) => i === idx ? { ...e, [field]: Number(val) } : e));
  };

  // Setup edge add picker state
  const [setupFrom, setSetupFrom] = useState(0);
  const [setupTo, setSetupTo] = useState(1);
  const syncEdges = (newEdges) => {
    const am = buildNetwork(nodeParams, newEdges);
    setEdges(newEdges);
    setAdjMap(am);
    const r = runSimFresh(nodeParams, am, globalConfig);
    setSimResult(r); setCfResult(null); setCurrentDay(0);
  };

  const updateEdge = (idx, field, val) => {
    const ne = edges.map((e, i) => i === idx ? { ...e, [field]: val } : e);
    syncEdges(ne);
  };

  const updateNode = (i, field, val) => {
    const np = nodeParams.map((n, idx) => idx === i ? { ...n, [field]: val } : n);
    setNodeParams(np);
    // Keep edges as-is, just rerun sim with new propensity
    const am = buildNetwork(np, edges);
    setAdjMap(am);
    const r = runSimFresh(np, am, globalConfig);
    setSimResult(r); setCfResult(null); setCurrentDay(0);
  };

  const handleNodeCount = (n) => {
    setNodeCount(n);
    const params = makeNodes(n, networkSeed);
    setNodeParams(params);
    setSelectedNode(null);
    const pos = layoutNodes(n, networkSeed);
    const ne = autoEdges(params, networkSeed);
    const am = buildNetwork(params, ne);
    setPositions(pos); setEdges(ne); setAdjMap(am);
    const r = runSimFresh(params, am, globalConfig);
    setSimResult(r); setCfResult(null); setCurrentDay(0);
  };

  const addEdge = () => {
    const from = addEdgeFrom, to = addEdgeTo;
    if (from === to) return;
    if (edges.some(e => e.from === from && e.to === to)) return; // exact direction already exists
    const ne = [...edges, { from, to, w: 0.20 }];
    syncEdges(ne);
  };

  const removeEdge = (idx) => {
    const ne = edges.filter((_, i) => i !== idx);
    setExpandedEdgeIdx(null);
    syncEdges(ne);
  };

  const togglePlay = () => {
    if (playing) { clearInterval(playRef.current); setPlaying(false); return; }
    setPlaying(true);
    playRef.current = setInterval(() => {
      setCurrentDay(d => {
        if (d >= globalConfig.days) { clearInterval(playRef.current); setPlaying(false); return d; }
        return d + 1;
      });
    }, 700);
  };
  useEffect(() => () => clearInterval(playRef.current), []);

  const handleSelectNode = (i) => {
    setSelectedNode(i === selectedNode ? null : i);
    if (i !== selectedNode) { setPanel("nodes"); setSelectedEdgeIdx(null); }
  };

  const handleHoverEdge = (key, info) => {
    setHovKey(key);
    setHovInfo(info);
  };

  const runCF = () => {
    if (cfNode === null) return;
    // Reuse the SAME seed as the baseline so draws are identical — only propensities differ
    const r = runSimulation(nodeParams, adjMap, globalConfig.days, globalConfig.threshold, lastSimSeedRef.current, { node: cfNode, day: cfDay });
    setCfResult(r); setShowCf(true); setCurrentDay(0);
  };

  const activeResult = showCf && cfResult ? cfResult : simResult;
  const displayState = activeResult?.history[currentDay];
  // Thermometer shows propensity from next day so the boost appears one day early
  const nextDayState = activeResult?.history[Math.min(currentDay + 1, globalConfig.days)];
  // For voted agents freeze bar at propensity on the day they voted
  const frozenPropensity = displayState ? displayState.map((s, i) =>
    s.voted ? (activeResult?.history[s.votedDay]?.[i]?.propensity ?? s.propensity) : null
  ) : null;
  const currentVotes = displayState?.filter(s => s.voted).length ?? 0;
  const passed = activeResult?.passed;
  const passedDay = activeResult?.passedDay;

  // CSV export with full draw log
  const snapshotSVG = (dayNum, highlightIndices = null, votesCount = 0, threshold = 0) => {
    const container = graphContainerRef.current;
    if (!container) return null;
    const svg = container.querySelector("svg");
    if (!svg) return null;
    const rect = container.getBoundingClientRect();
    const W = Math.round(rect.width) || 800;
    const H = Math.round(rect.height) || 590;
    // Get SVG viewBox to find actual content bounds
    const vb = svg.getAttribute("viewBox");
    let vx=0,vy=0,vw=W,vh=H;
    if(vb){ const p=vb.split(" ").map(Number); vx=p[0];vy=p[1];vw=p[2];vh=p[3]; }
    // Add padding around content
    const pad = 40;
    const padTop = 160;
    const clone = svg.cloneNode(true);
    clone.setAttribute("viewBox", `${vx-pad} ${vy-padTop} ${vw+pad*2} ${vh+padTop+pad}`);
    clone.setAttribute("width", vw+pad*2);
    clone.setAttribute("height", vh+padTop+pad);
    const bg = document.createElementNS("http://www.w3.org/2000/svg","rect");
    bg.setAttribute("x", vx-pad); bg.setAttribute("y", vy-padTop);
    bg.setAttribute("width", vw+pad*2); bg.setAttribute("height", vh+padTop+pad);
    bg.setAttribute("fill", "white");
    clone.insertBefore(bg, clone.firstChild);
    // Light yellow circle behind key agents
    if (highlightIndices && highlightIndices.size > 0) {
      highlightIndices.forEach(i => {
        const pos = positions[i];
        if (!pos) return;
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", pos.x + 4);
        circle.setAttribute("cy", pos.y + 35);
        circle.setAttribute("r", "90");
        circle.setAttribute("fill", "#fed7aa");
        circle.setAttribute("opacity", "0.85");
        clone.insertBefore(circle, clone.firstChild.nextSibling);
      });
    }
    // Header: Day on first row, Votes on second row, both flush left
    const label = document.createElementNS("http://www.w3.org/2000/svg","text");
    const headerY = vy - padTop * 0.65;
    const votesY = headerY + 58;
    // Day — flush left
    label.setAttribute("x", vx + pad); label.setAttribute("y", headerY);
    label.setAttribute("text-anchor", "start");
    label.setAttribute("font-size", "48"); label.setAttribute("font-weight", "700");
    label.setAttribute("font-family", "Georgia,Times New Roman,serif"); label.setAttribute("fill", "#000000");
    label.textContent = `Day ${dayNum}`;
    clone.appendChild(label);
    // Votes — two stacked lines flush left
    if (threshold > 0) {
      const line1 = document.createElementNS("http://www.w3.org/2000/svg","text");
      line1.setAttribute("x", vx + pad);
      line1.setAttribute("y", votesY);
      line1.setAttribute("font-size", "40"); line1.setAttribute("font-weight", "700");
      line1.setAttribute("font-family", "Georgia,Times New Roman,serif");
      line1.setAttribute("fill", "#000000");
      line1.textContent = `Signatures acquired: ${votesCount}`;
      clone.appendChild(line1);

      const line2 = document.createElementNS("http://www.w3.org/2000/svg","text");
      line2.setAttribute("x", vx + pad);
      line2.setAttribute("y", votesY + 50);
      line2.setAttribute("font-size", "40"); line2.setAttribute("font-weight", "700");
      line2.setAttribute("font-family", "Georgia,Times New Roman,serif");
      line2.setAttribute("fill", "#1e293b");
      line2.textContent = `Signatures needed: ${threshold}`;
      clone.appendChild(line2);
    }
    return new XMLSerializer().serializeToString(clone);
  };

  const [snapModal, setSnapModal] = useState(null); // { dataUrl, day }

  const openSnapshot = () => {
    const vCount = activeResult?.history[currentDay]?.filter(s => s.voted).length ?? 0;
    const svgStr = snapshotSVG(currentDay, null, vCount, globalConfig.threshold);
    if (!svgStr) return;
    const img = new window.Image();
    const encoded = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 900;
      canvas.height = img.naturalHeight || 600;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      setSnapModal({ dataUrl: canvas.toDataURL("image/png"), day: currentDay });
    };
    img.onerror = () => {
      // fallback: show SVG directly
      setSnapModal({ dataUrl: encoded, day: currentDay, isSvg: true });
    };
    img.src = encoded;
  };

  const exportCSV = () => {
    if (!simResult) return;
    const { history } = simResult;
    const days = globalConfig.days;
    const n = nodeParams.length;

    // Build columns: for each day show propensity, influence received, draw, voted this day
    const cols = ["Node", "Init_Propensity", "Edges"];
    for (let d = 0; d <= days; d++) cols.push(`D${d}_propensity`);
    for (let d = 1; d <= days; d++) cols.push(`D${d}_influence_received`);
    for (let d = 1; d <= days; d++) cols.push(`D${d}_draw`);
    for (let d = 1; d <= days; d++) cols.push(`D${d}_result`);
    cols.push("Final_voted", "Voted_on_day");

    const rows = [cols.join(",")];
    for (let i = 0; i < n; i++) {
      const edgeCount = edges.filter(e => e.from === i || e.to === i).length;
      const row = [i, nodeParams[i].propensity.toFixed(3), edgeCount];
      for (let d = 0; d <= days; d++) row.push(history[d][i].propensity.toFixed(4));
      for (let d = 1; d <= days; d++) row.push((history[d][i].influenceReceived ?? 0).toFixed(4));
      for (let d = 1; d <= days; d++) row.push(history[d][i].draw != null ? history[d][i].draw.toFixed(4) : "already_voted");
      for (let d = 1; d <= days; d++) {
        const hs = history[d][i];
        if (hs.votedDay !== null && hs.votedDay < d) { row.push("already_voted"); }
        else if (hs.draw != null) { row.push(hs.draw < hs.propensity ? "VOTED" : `skip(${hs.draw.toFixed(3)}>=${hs.propensity.toFixed(3)})`); }
        else row.push("");
      }
      const fin = history[days][i];
      row.push(fin.voted ? "YES" : "NO", fin.votedDay ?? "never");
      rows.push(row.join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "voting_sim_draws.csv"; a.click();
  };

  const [trialRunning, setTrialRunning] = useState(false);
  const [trialProgress, setTrialProgress] = useState(null); // { day, total }

  const svgToPng = (svgStr) => new Promise(resolve => {
    const img = new window.Image();
    const encoded = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 1400;
      canvas.height = img.naturalHeight || 900;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(null);
    img.src = encoded;
  });

  const runTrial = async () => {
    if (!simResult) return;
    setTrialRunning(true);
    const days = globalConfig.days;
    const pngsClean = [];
    const pngsHighlight = [];
    const hasHighlight = keyAgents.size > 0;

    for (let d = 0; d <= days; d++) {
      setCurrentDay(d);
      setTrialProgress({ day: d, total: days });
      await new Promise(r => setTimeout(r, 220));

      const vCount = activeResult ? activeResult.history[d]?.filter(s => s.voted).length ?? 0 : 0;
      // Clean version
      const svgClean = snapshotSVG(d, null, vCount, globalConfig.days > 0 ? globalConfig.threshold : 0);
      if (svgClean) {
        const dataUrl = await svgToPng(svgClean);
        if (dataUrl) pngsClean.push({ day: d, dataUrl });
      }

      // Highlighted version
      if (hasHighlight) {
        const svgHL = snapshotSVG(d, keyAgents, vCount, globalConfig.threshold);
        if (svgHL) {
          const dataUrl = await svgToPng(svgHL);
          if (dataUrl) pngsHighlight.push({ day: d, dataUrl });
        }
      }
    }

    const jsonStr = JSON.stringify(buildJSON(simResult, nodeParams, edges, globalConfig, lastSimSeedRef.current), null, 2);
    const seed = lastSimSeedRef.current;

    setTrialRunning(false);
    setTrialProgress(null);

    try {
      if (!window.JSZip) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const JSZip = window.JSZip;
      const zip = new JSZip();
      zip.file("sim_result.json", jsonStr);

      // Clean snapshots
      const cleanFolder = zip.folder("snapshots_clean");
      pngsClean.forEach(({ day, dataUrl }) => {
        cleanFolder.file(`day${String(day).padStart(2,"0")}.png`, dataUrl.split(",")[1], { base64: true });
      });

      // Highlighted snapshots (only if key agents selected)
      if (hasHighlight) {
        const hlFolder = zip.folder("snapshots_highlighted");
        pngsHighlight.forEach(({ day, dataUrl }) => {
          hlFolder.file(`day${String(day).padStart(2,"0")}.png`, dataUrl.split(",")[1], { base64: true });
        });
        // Also save a key_agents.txt
        const names = [...keyAgents].map(i => nodeParams[i]?.name ?? i).join(", ");
        zip.file("key_agents.txt", `Key agents highlighted: ${names}\nNode indices: ${[...keyAgents].join(", ")}`);
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `trial_seed${seed}.zip`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      // Offer to save to history
      const keyNames = [...keyAgents].map(i => nodeParams[i]?.name ?? i);
      setPendingTrialSave({ seed, jsonStr, pngsClean, pngsHighlight: hasHighlight ? pngsHighlight : [], keyAgentNames: keyNames });
    } catch(e) {
      setTrialModal({ pngs: pngsClean, jsonStr, seed });
    }
  };

  const [trialModal, setTrialModal] = useState(null);
  const [pendingTrialSave, setPendingTrialSave] = useState(null);
  const [trialHistory, setTrialHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("votewave_trials") || "[]"); } catch { return []; }
  });
  const [showTrialHistory, setShowTrialHistory] = useState(false);

  const saveTrialToHistory = (seed, jsonStr, pngsClean, pngsHighlight, keyAgentNames) => {
    const entry = {
      id: Date.now(),
      seed,
      date: new Date().toLocaleString(),
      days: globalConfig.days,
      threshold: globalConfig.threshold,
      nodes: nodeParams.length,
      jsonStr,
      pngsClean,
      pngsHighlight: pngsHighlight || [],
      keyAgentNames: keyAgentNames || [],
      // Full editable state
      savedNodeParams: JSON.parse(JSON.stringify(nodeParams)),
      savedEdges: JSON.parse(JSON.stringify(edges)),
      savedGlobalConfig: { ...globalConfig },
      savedKeyAgents: [...keyAgents],
    };
    setTrialHistory(prev => {
      const next = [entry, ...prev].slice(0, 20); // keep last 20
      try { localStorage.setItem("votewave_trials", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const loadTrialState = (entry) => {
    if (!entry.savedNodeParams) { alert("This trial has no saved state — re-run it to save an editable version."); return; }
    setNodeParams(entry.savedNodeParams);
    setEdges(entry.savedEdges);
    setGlobalConfig(entry.savedGlobalConfig);
    const am = buildNetwork(entry.savedNodeParams, entry.savedEdges);
    setAdjMap(am);
    setPositions(layoutNodes(entry.savedNodeParams.length, networkSeed));
    setKeyAgents(new Set(entry.savedKeyAgents || []));
    const r = runSimFresh(entry.savedNodeParams, am, entry.savedGlobalConfig);
    setSimResult(r);
    setCfResult(null);
    setCurrentDay(0);
    setShowTrialHistory(false);
  };

  const redownloadTrial = async (entry) => {
    try {
      if (!window.JSZip) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const zip = new window.JSZip();
      zip.file("sim_result.json", entry.jsonStr);
      const cleanFolder = zip.folder("snapshots_clean");
      entry.pngsClean.forEach(({ day, dataUrl }) => {
        cleanFolder.file(`day${String(day).padStart(2,"0")}.png`, dataUrl.split(",")[1], { base64: true });
      });
      if (entry.pngsHighlight.length > 0) {
        const hlFolder = zip.folder("snapshots_highlighted");
        entry.pngsHighlight.forEach(({ day, dataUrl }) => {
          hlFolder.file(`day${String(day).padStart(2,"0")}.png`, dataUrl.split(",")[1], { base64: true });
        });
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `trial_seed${entry.seed}.zip`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch(e) { alert("Download failed: " + e.message); }
  };

  const buildJSON = (result, params, edgeList, gcfg, seed) => {
    if (!result) return null;
    const { history } = result;
    const days = gcfg.days;
    const n = params.length;

    // spec
    const agents = params.map((p, i) => ({ name: p.name || String(i), base_threshold: parseFloat(p.propensity.toFixed(4)) }));
    const nameOf = i => (params[i] && params[i].name) ? params[i].name : (history[0][i] && history[0][i].name) ? history[0][i].name : String(i);
    const influence = {};
    edgeList.forEach(e => {
      const src = nameOf(e.from);
      if (!influence[src]) influence[src] = {};
      influence[src][nameOf(e.to)] = parseFloat(e.w.toFixed(4));
    });

    // day_voted
    const day_voted = {};
    for (let i = 0; i < n; i++) {
      const fin = history[days][i];
      if (fin.voted) day_voted[nameOf(i)] = fin.votedDay;
    }

    // days array
    const daysArr = [];
    for (let d = 1; d <= days; d++) {
      const thresholds_start = {};
      const random_draws = {};
      for (let i = 0; i < n; i++) {
        const s = history[d][i];
        thresholds_start[nameOf(i)] = parseFloat(s.propensity.toFixed(4));
        random_draws[nameOf(i)] = s.draw !== null ? parseFloat(s.draw.toFixed(4)) : null;
      }
      daysArr.push({ day: d, thresholds_start, random_draws });
    }

    return {
      spec: { agents, influence, n_days: days, pass_threshold: gcfg.threshold / n },
      seed,
      day_voted,
      days: daysArr,
    };
  };

  const [jsonModal, setJsonModal] = useState(null);

  const exportJSON = (result, params, edgeList, gcfg, seed) => {
    const data = buildJSON(result, params, edgeList, gcfg, seed);
    if (!data) return;
    const jsonStr = JSON.stringify(data, null, 2);
    setJsonModal(jsonStr);
    try {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'sim_result.json';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch(e) { /* modal fallback */ }
  };

  const onSimDividerDown = (which, e) => {
    simDragging.current = which;
    simDragStartX.current = e.clientX;
    simDragStartW.current = which === "left" ? simLeftW : simRightW;
    e.preventDefault();
  };
  const onSimDividerMove = (e) => {
    if (!simDragging.current) return;
    const dx = e.clientX - simDragStartX.current;
    if (simDragging.current === "left") setSimLeftW(Math.max(180, Math.min(480, simDragStartW.current + dx)));
    else setSimRightW(Math.max(160, Math.min(480, simDragStartW.current - dx)));
  };
  const onSimDividerUp = () => { simDragging.current = null; };

  const C = {
    blue: "#2563eb", coral: "#22c55e", amber: "#f59e0b",
    green: "#22c55e", red: "#dc2626", slate: "#64748b",
    border: "#e2e8f0", bg: "#f8fafc", white: "#fff", text: "#1e293b",
  };

  const selNodeData = selectedNode !== null && displayState ? displayState[selectedNode] : null;
  const selNodeParams = selectedNode !== null ? nodeParams[selectedNode] : null;
  const selEdge = expandedEdgeIdx !== null ? edges[expandedEdgeIdx] : null;

  // Edges connected to selected node
  const connectedEdges = selectedNode !== null
    ? edges.map((e, i) => ({ ...e, idx: i, role: e.from === selectedNode ? "out" : e.to === selectedNode ? "in" : null })).filter(e => e.role)
    : [];

  return (
    <div style={{ height: "100vh", background: C.bg, fontFamily: "'Fraunces',Georgia,serif", color: C.text, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@300;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { -webkit-appearance: none; appearance: none; background: #e2e8f0; border-radius: 99px; height: 4px; outline: none; width: 100%; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #2563eb; cursor: pointer; border: 2px solid white; box-shadow: 0 1px 3px #2563eb44; }
        .btn { font-family: 'DM Mono',monospace; font-size: 11px; cursor: pointer; border-radius: 6px; border: none; padding: 6px 12px; transition: all 0.12s; font-weight: 500; letter-spacing: 0.03em; }
        .btn-blue { background: #2563eb; color: white; } .btn-blue:hover { background: #1d4ed8; }
        .btn-ghost { background: white; color: #475569; border: 1.5px solid #e2e8f0; } .btn-ghost:hover { border-color: #94a3b8; }
        .btn-amber { background: #fef3c7; color: #92400e; border: 1.5px solid #fcd34d; } .btn-amber:hover { background: #fde68a; }
        .btn-active { background: #2563eb; color: white; border: 1.5px solid #2563eb; }
        .btn-green { background: #dcfce7; color: #166534; border: 1.5px solid #86efac; } .btn-green:hover { background: #bbf7d0; }
        .tab { font-family: 'DM Mono',monospace; font-size: 10px; cursor: pointer; padding: 5px 10px; border: none; background: transparent; color: #94a3b8; transition: all 0.12s; white-space: nowrap; }
        .tab.on { color: #1e293b; font-weight: 700; border-bottom: 2px solid #2563eb; }
        .tab:hover:not(.on) { color: #475569; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #f8fafc; } ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        input[type=number] { font-family: 'DM Mono',monospace; font-size: 12px; font-weight: 600; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 5px; padding: 5px 7px; color: #1e293b; outline: none; width: 100%; }
        input[type=number]:focus { border-color: #93c5fd; }
        .setup-cell input { font-family: 'DM Mono',monospace; font-size: 12px; font-weight: 600; background: white; border: 1.5px solid #e2e8f0; border-radius: 5px; padding: 5px 8px; color: #1e293b; outline: none; width: 100%; text-align: center; }
        .setup-cell input:focus { border-color: #93c5fd; background: #eff6ff; }
        .setup-row:hover { background: #f8fafc; }
      `}</style>

      {/* ── SETUP PAGE ── */}
      {showSetup && <SetupPage
        setupNodes={setupNodes} setSetupNodes={setSetupNodes}
        setupEdges={setupEdges} setSetupEdges={setSetupEdges}
        setupNodeCount={setupNodeCount}
        handleSetupNodeCount={handleSetupNodeCount}
        handleSetupNodeField={handleSetupNodeField}
        addSetupEdge={addSetupEdge} removeSetupEdge={removeSetupEdge} handleSetupEdgeField={handleSetupEdgeField}
        setupFrom={setupFrom} setSetupFrom={setSetupFrom}
        setupTo={setupTo} setSetupTo={setSetupTo}
        globalConfig={globalConfig} setGlobalConfig={setGlobalConfig}
        simResult={simResult}
        onCancel={() => setShowSetup(false)}
        onLaunch={() => launchSim(setupNodes, setupEdges, globalConfig)}
      />}

      {/* ── Header ── */}
      {/* ── Header ── */}
      <header style={{ background: C.white, borderBottom: `1.5px solid ${C.border}`, padding: "10px 18px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>Network Voting Simulator</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {showCf && cfResult && <span style={{ ...mono, background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d", padding: "2px 8px", borderRadius: 99, fontSize: 9 }}>★ CF</span>}
          {activeResult && (
            <div style={{ padding: "5px 12px", borderRadius: 7, background: passed ? "#dcfce7" : "#f0fdf4", border: `1.5px solid ${passed ? "#4ade80" : "#fca5a5"}` }}>
              <div style={{ ...mono, fontSize: 10, fontWeight: 700, color: passed ? "#166534" : "#991b1b" }}>
                {passed ? `✓ PASSED · day ${passedDay}` : "✗ FAILED"}
              </div>
            </div>
          )}
          <button className="btn btn-blue" onClick={() => reRunSim()}>▶ Run again</button>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ ...mono, fontSize: 9, color: "#94a3b8" }}>target</span>
            <select value={targetOutcome ?? ""} onChange={e => setTargetOutcome(e.target.value === "" ? null : e.target.value)}
              style={{ ...mono, fontSize: 10, padding: "4px 6px", borderRadius: 6, border: "1.5px solid #e2e8f0", background: "white", color: "#1e293b", cursor: "pointer" }}>
              <option value="">any</option>
              {Array.from({ length: globalConfig.days }, (_, i) => (
                <option key={i+1} value={i+1}>pass day {i+1}</option>
              ))}
              <option value="never">never pass</option>
            </select>
          </div>
          <button className="btn btn-ghost" onClick={randomizeSim} title="Randomize to match target outcome">🎲 Randomize</button>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, color: "#94a3b8" }}>key agents</span>
            <div style={{ display: "flex", gap: 2 }}>
              {nodeParams.map((np, i) => (
                <button key={i} onClick={() => toggleKeyAgent(i)}
                  style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, fontWeight: 700, padding: "3px 7px", borderRadius: 5, cursor: "pointer",
                    border: keyAgents.has(i) ? "2px solid #f59e0b" : "1.5px solid #e2e8f0",
                    background: keyAgents.has(i) ? "#fef3c7" : "white",
                    color: keyAgents.has(i) ? "#b45309" : "#94a3b8" }}>{np.name || i}</button>
              ))}
            </div>
          </div>
          <button className="btn btn-green" onClick={runTrial} disabled={trialRunning} style={{ minWidth: 80 }}>{trialRunning && trialProgress ? `📸 ${trialProgress.day}/${trialProgress.total}` : "📸 Trial"}</button>
          <button className="btn btn-ghost" onClick={fullRebuild}>⚙ Setup</button>
          <button className="btn btn-green" onClick={exportCSV}>↓ CSV</button>
          <button className="btn btn-green" onClick={() => exportJSON(simResult, nodeParams, edges, globalConfig, lastSimSeedRef.current)}>↓ JSON</button>
          <button className="btn btn-green" onClick={async () => {
            if (!simResult) return;
            const days = globalConfig.days;
            const pngsClean = [];
            const pngsHL = [];
            const hasHL = keyAgents.size > 0;
            for (let d = 0; d <= days; d++) {
              setCurrentDay(d);
              await new Promise(r => setTimeout(r, 180));
              const vCount = activeResult?.history[d]?.filter(s => s.voted).length ?? 0;
              const svgClean = snapshotSVG(d, null, vCount, globalConfig.threshold);
              if (svgClean) { const du = await svgToPng(svgClean); if (du) pngsClean.push({ day: d, dataUrl: du }); }
              if (hasHL) {
                const svgHL = snapshotSVG(d, keyAgents, vCount, globalConfig.threshold);
                if (svgHL) { const du = await svgToPng(svgHL); if (du) pngsHL.push({ day: d, dataUrl: du }); }
              }
            }
            const jsonStr = JSON.stringify(buildJSON(simResult, nodeParams, edges, globalConfig, lastSimSeedRef.current), null, 2);
            const seed = lastSimSeedRef.current;
            if (!window.JSZip) {
              await new Promise((res, rej) => {
                const s = document.createElement("script");
                s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
                s.onload = res; s.onerror = rej;
                document.head.appendChild(s);
              });
            }
            const zip = new window.JSZip();
            zip.file("sim_result.json", jsonStr);
            const cleanFolder = zip.folder("snapshots_clean");
            pngsClean.forEach(({ day, dataUrl }) => {
              cleanFolder.file(`day${String(day).padStart(2,"0")}.png`, dataUrl.split(",")[1], { base64: true });
            });
            if (hasHL) {
              const hlFolder = zip.folder("snapshots_highlighted");
              pngsHL.forEach(({ day, dataUrl }) => {
                hlFolder.file(`day${String(day).padStart(2,"0")}.png`, dataUrl.split(",")[1], { base64: true });
              });
              const keyNames = [...keyAgents].map(i => nodeParams[i]?.name ?? i).join(", ");
              zip.file("key_agents.txt", `Key agents: ${keyNames}`);
            }
            const blob = await zip.generateAsync({ type: "blob" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = `sim_seed${seed}.zip`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          }}>↓ ZIP</button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", userSelect: simDragging.current ? "none" : "auto" }}
        onMouseMove={onSimDividerMove} onMouseUp={onSimDividerUp} onMouseLeave={onSimDividerUp}>

        {/* ══ LEFT PANEL ══ */}
        <aside style={{ width: simLeftW, background: C.white, borderRight: "none", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          {/* Global sim controls - always visible */}
          <div style={{ padding: "12px 14px", borderBottom: `1.5px solid ${C.border}`, flexShrink: 0 }}>
            <SH>SIMULATION</SH>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 3 }}>NODES</div>
                <input type="number" min={3} max={25} value={nodeCount} onChange={e => handleNodeCount(Number(e.target.value))} />
              </div>
              <div>
                <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 3 }}>DAYS</div>
                <input type="number" min={1} max={20} value={globalConfig.days}
                  onChange={e => { const v = { ...globalConfig, days: Number(e.target.value) }; setGlobalConfig(v); reRunSim(nodeParams, adjMap, v); }} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 3 }}>VOTE THRESHOLD (# of votes to pass)</div>
                <input type="number" min={1} max={nodeCount} value={globalConfig.threshold}
                  onChange={e => { const v = { ...globalConfig, threshold: Number(e.target.value) }; setGlobalConfig(v); reRunSim(nodeParams, adjMap, v); }} />
              </div>
            </div>
            <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginTop: 8 }}>Each run uses fresh random draws. Click ↺ Rebuild for a new run.</div>
          </div>

          {/* Panel tabs */}
          <div style={{ display: "flex", borderBottom: `1.5px solid ${C.border}`, padding: "6px 10px 0", flexShrink: 0, gap: 2 }}>
            {[["nodes", "Nodes"], ["edges", "Edges"], ["ctrl", "Control"], ["log", "Draw Log"], ["cf", "CF"]].map(([id, lbl]) => (
              <button key={id} className={`tab ${panel === id ? "on" : ""}`} onClick={() => setPanel(id)}>
                {lbl}
                {id === "nodes" && selectedNode !== null && <span style={{ marginLeft: 3, background: C.blue, color: "white", borderRadius: 99, padding: "0 4px", fontSize: 8 }}>{nodeParams[selectedNode]?.name ?? selectedNode}</span>}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "12px 13px" }}>

            {/* ── NODES PANEL ── */}
            {panel === "nodes" && (
              <div>
                <div style={{ ...mono, fontSize: 10, color: "#94a3b8", marginBottom: 10, lineHeight: 1.5 }}>
                  Click a person on the graph to edit their propensity. Add/remove edges in the Edges tab.
                </div>
                {nodeParams.map((np, i) => {
                  const isSel = selectedNode === i;
                  const ds = displayState?.[i];
                  const propHue = 210 - np.propensity * 80;
                  const edgeCount = edges.filter(e => e.from === i || e.to === i).length;
                  return (
                    <div key={i} style={{ background: isSel ? "#eff6ff" : "#fafafa", border: `1.5px solid ${isSel ? "#bfdbfe" : C.border}`, borderRadius: 8, padding: "9px 11px", marginBottom: 7, cursor: "pointer" }}
                      onClick={() => handleSelectNode(i)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isSel ? 11 : 0 }}>
                        <div style={{ width: 24, height: 24, borderRadius: "50%", background: ds?.voted ? C.coral : `hsl(${propHue},65%,65%)`, border: `2px solid ${isSel ? C.blue : C.border}`, display: "flex", alignItems: "center", justifyContent: "center", ...mono, fontSize: 10, fontWeight: 700, color: "#1e293b", flexShrink: 0 }}>{i}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", gap: 6 }}>
                            <span style={{ ...mono, fontSize: 10, color: "#94a3b8" }}>p={np.propensity.toFixed(2)}</span>
                            <span style={{ ...mono, fontSize: 10, color: "#94a3b8" }}>{edgeCount} edge{edgeCount !== 1 ? "s" : ""}</span>
                          </div>
                          <PropBar value={np.propensity} color={`hsl(${propHue},65%,55%)`} h={4} />
                        </div>
                        {ds?.voted && <span style={{ ...mono, fontSize: 9, background: C.coral, color: "white", padding: "1px 5px", borderRadius: 99 }}>✓d{ds.votedDay}</span>}
                      </div>

                      {isSel && (
                        <div onClick={e => e.stopPropagation()}>
                          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                            <span style={{ ...mono, fontSize: 9, color: "#94a3b8", marginRight: 4 }}>propensity</span>
                            {[0.2, 0.5, 0.8].map(v => (
                              <button key={v} onClick={() => { const p=[...nodeParams]; p[i]={...p[i],propensity:v}; setNodeParams(p); const am=buildNetwork(p,edges); setAdjMap(am); reRunSim(p,am,globalConfig); }}
                                style={{ ...mono, fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 6, cursor: "pointer", border: np.propensity===v?"2px solid #f59e0b":"1.5px solid #e2e8f0", background: np.propensity===v?"#fffbeb":"white", color: np.propensity===v?"#b45309":"#64748b" }}>{v}</button>
                            ))}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                            <span style={{ ...mono, fontSize: 9, color: "#94a3b8" }}>force vote day</span>
                            <select value={np.forceVoteDay ?? ""} onChange={e => { const p=[...nodeParams]; p[i]={...p[i],forceVoteDay:e.target.value||null}; setNodeParams(p); const am=buildNetwork(p,edges); setAdjMap(am); reRunSim(p,am,globalConfig); }}
                              style={{ ...mono, fontSize: 10, padding: "3px 6px", borderRadius: 6, border: np.forceVoteDay ? "2px solid #7c3aed" : "1.5px solid #e2e8f0", background: np.forceVoteDay ? "#f5f3ff" : "white", color: np.forceVoteDay ? "#7c3aed" : "#1e293b", cursor: "pointer" }}>
                              <option value="">random</option>
                              {Array.from({ length: globalConfig.days }, (_, d) => (
                                <option key={d+1} value={d+1}>day {d+1}</option>
                              ))}
                              <option value="never">never</option>
                            </select>
                          </div>
                          <NumSlider label="initial propensity" value={np.propensity} min={0.01} max={0.99} step={0.01} color="#f59e0b" style={{display:"none"}}
                            onChange={v => updateNode(i, "propensity", v)} />

                          {/* Visual propensity gauge */}
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 3 }}>
                              <span>0</span><span style={{ color: C.blue }}>p = {np.propensity.toFixed(2)}</span><span>1</span>
                            </div>
                            <div style={{ height: 10, background: "#f1f5f9", borderRadius: 99, position: "relative", overflow: "hidden" }}>
                              <div style={{ position: "absolute", left: 0, height: "100%", width: `${np.propensity * 100}%`, background: `hsl(${propHue},65%,72%)`, borderRadius: "99px 0 0 99px" }} />
                              <div style={{ position: "absolute", top: 0, height: "100%", width: 2, background: C.coral, left: `${np.propensity * 100}%`, transform: "translateX(-50%)" }} />
                            </div>
                            <div style={{ ...mono, fontSize: 9, color: "#64748b", marginTop: 6, lineHeight: 1.6 }}>
                              Each day: draw a number 0–1<br/>
                              <span style={{ color: C.coral, fontWeight: 700 }}>draw &lt; {np.propensity.toFixed(2)}</span> (blue zone) → <strong>VOTE</strong><br/>
                              draw ≥ {np.propensity.toFixed(2)} → skip this day
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── EDGES PANEL ── */}
            {panel === "edges" && (
              <div>
                {/* Add edge */}
                <div style={{ background: "#f0fdf4", border: "1.5px solid #bbf7d0", borderRadius: 8, padding: "10px 11px", marginBottom: 12 }}>
                  <div style={{ ...mono, fontSize: 9, color: "#166534", fontWeight: 700, marginBottom: 8 }}>ADD EDGE</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <select value={addEdgeFrom} onChange={e => setAddEdgeFrom(Number(e.target.value))}
                      style={{ flex: 1, ...mono, fontSize: 11, fontWeight: 600, background: "white", border: "1.5px solid #bbf7d0", borderRadius: 5, padding: "5px 7px", color: C.text, outline: "none" }}>
                      {nodeParams.map((nd, i) => <option key={i} value={i}>{nd.name || i}</option>)}
                    </select>
                    <span style={{ ...mono, fontSize: 11, color: "#94a3b8" }}>→</span>
                    <select value={addEdgeTo} onChange={e => setAddEdgeTo(Number(e.target.value))}
                      style={{ flex: 1, ...mono, fontSize: 11, fontWeight: 600, background: "white", border: "1.5px solid #bbf7d0", borderRadius: 5, padding: "5px 7px", color: C.text, outline: "none" }}>
                      {nodeParams.map((nd, i) => <option key={i} value={i}>{nd.name || i}</option>)}
                    </select>
                  </div>
                  <button className="btn btn-green" style={{ width: "100%", fontSize: 11 }}
                    onClick={addEdge}
                    disabled={addEdgeFrom === addEdgeTo || edges.some(e => e.from === addEdgeFrom && e.to === addEdgeTo)}>
                    {addEdgeFrom === addEdgeTo ? "select two different nodes"
                      : edges.some(e => e.from === addEdgeFrom && e.to === addEdgeTo) ? "arrow already exists"
                      : `+ ${addEdgeFrom} → ${addEdgeTo}`}
                  </button>
                </div>

                {edges.map((e, idx) => {
                  const isSelEdge = expandedEdgeIdx === idx;
                  const fromVoted = displayState?.[e.from]?.voted;
                  const toVoted = displayState?.[e.to]?.voted;
                  return (
                    <div key={idx} style={{ background: isSelEdge ? "#eff6ff" : "#fafafa", border: `1.5px solid ${isSelEdge ? "#bfdbfe" : C.border}`, borderRadius: 8, padding: "10px 11px", marginBottom: 7, cursor: "pointer" }}
                      onClick={() => setExpandedEdgeIdx(isSelEdge ? null : idx)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isSelEdge ? 12 : 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <div style={{ width: 20, height: 20, borderRadius: "50%", background: fromVoted ? C.coral : "#bfdbfe", display: "flex", alignItems: "center", justifyContent: "center", ...mono, fontSize: 9, fontWeight: 700, color: fromVoted ? "white" : C.blue, border: `1.5px solid ${fromVoted ? "#15803d" : "#93c5fd"}` }}>{nodeParams[e.from]?.name ?? e.from}</div>
                          <span style={{ ...mono, fontSize: 10, color: "#94a3b8" }}>→</span>
                          <div style={{ width: 20, height: 20, borderRadius: "50%", background: toVoted ? C.coral : "#bfdbfe", display: "flex", alignItems: "center", justifyContent: "center", ...mono, fontSize: 9, fontWeight: 700, color: toVoted ? "white" : C.blue, border: `1.5px solid ${toVoted ? "#15803d" : "#93c5fd"}` }}>{nodeParams[e.to]?.name ?? e.to}</div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ ...mono, fontSize: 9, color: "#94a3b8" }}>
                            weight: <strong style={{ color: C.blue }}>{e.w.toFixed(2)}</strong>
                          </div>
                        </div>
                        <button onClick={ev => { ev.stopPropagation(); removeEdge(idx); }}
                          style={{ ...mono, fontSize: 12, background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                          title="remove edge">×</button>
                      </div>

                      {isSelEdge && (
                        <div onClick={ev => ev.stopPropagation()}>
                          <div style={{ background: "#eff6ff", borderRadius: 7, padding: "9px 10px" }}>
                            <div style={{ ...mono, fontSize: 9, color: C.blue, fontWeight: 700, marginBottom: 6 }}>
                              {nodeParams[e.from]?.name ?? e.from} → {nodeParams[e.to]?.name ?? e.to} · weight
                            </div>
                            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                              <span style={{ ...mono, fontSize: 9, color: "#94a3b8", marginRight: 4 }}>weight</span>
                              {[0.1, 0.2, 0.3].map(v => (
                                <button key={v} onClick={() => { const ne=edges.map((ed,ei)=>ei===expandedEdgeIdx?{...ed,w:v}:ed); syncEdges(ne); }}
                                  style={{ ...mono, fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 6, cursor: "pointer", border: e.w===v?"2px solid #2563eb":"1.5px solid #e2e8f0", background: e.w===v?"#eff6ff":"white", color: e.w===v?"#2563eb":"#64748b" }}>{v}</button>
                              ))}
                            </div>
                            <NumSlider label={`weight`} value={e.w} min={0} max={0.60} step={0.01} color={C.blue} style={{display:"none"}}
                              onChange={v => { setDraggingEdgeIdx(idx); updateEdge(idx, "w", v); }}
                              onMouseUp={() => setDraggingEdgeIdx(null)}
                              onTouchEnd={() => setDraggingEdgeIdx(null)} />
                            <PropBar value={e.w} max={0.6} color={C.blue} h={5} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── DRAW LOG PANEL ── */}
            {panel === "ctrl" && (
              <div style={{ padding: "4px 0" }}>
                <div style={{ ...mono, fontSize: 10, color: "#94a3b8", marginBottom: 10, lineHeight: 1.5 }}>
                  Full control: set each agent's name, propensity, and exact vote day.
                </div>
                {nodeParams.map((np, i) => {
                  const ds = displayState?.[i];
                  const bl = Math.round(88 - np.propensity * 45), bs = Math.round(40 + np.propensity * 40);
                  return (
                    <div key={i} style={{ marginBottom: 14, padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${ds?.voted ? "#dcfce7" : "#e2e8f0"}`, background: ds?.voted ? "#fef2f2" : "#f8fafc" }}>
                      {/* Name */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", background: ds?.voted ? "#22c55e" : `hsl(215,${bs}%,${bl}%)`, flexShrink: 0 }} />
                        <input value={np.name || ""} onChange={e => {
                          const p = [...nodeParams]; p[i] = { ...p[i], name: e.target.value };
                          setNodeParams(p); const am = buildNetwork(p, edges); setAdjMap(am); reRunSim(p, am, globalConfig);
                        }} style={{ ...mono, fontSize: 13, fontWeight: 700, border: "1.5px solid #e2e8f0", borderRadius: 6, padding: "4px 8px", flex: 1, color: "#1e293b" }} placeholder="Name" />
                        <span style={{ ...mono, fontSize: 9, color: ds?.voted ? "#22c55e" : "#94a3b8", minWidth: 50, textAlign: "right" }}>{ds?.voted ? `voted d${ds.votedDay}` : "not voted"}</span>
                      </div>
                      {/* Propensity */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                        <span style={{ ...mono, fontSize: 9, color: "#94a3b8", width: 70 }}>propensity</span>
                        <div style={{ display: "flex", gap: 4 }}>
                          {[0.2, 0.5, 0.8].map(v => (
                            <button key={v} onClick={() => {
                              const p = [...nodeParams]; p[i] = { ...p[i], propensity: v };
                              setNodeParams(p); const am = buildNetwork(p, edges); setAdjMap(am); reRunSim(p, am, globalConfig);
                            }} style={{ ...mono, fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 6, cursor: "pointer",
                              border: np.propensity === v ? "2px solid #2563eb" : "1.5px solid #e2e8f0",
                              background: np.propensity === v ? "#eff6ff" : "white",
                              color: np.propensity === v ? "#2563eb" : "#64748b" }}>{v}</button>
                          ))}
                        </div>
                      </div>
                      {/* Force vote day */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ ...mono, fontSize: 9, color: "#94a3b8", width: 70 }}>vote day</span>
                        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                          {["random", ...Array.from({ length: globalConfig.days }, (_, d) => String(d + 1)), "never"].map(v => {
                            const cur = np.forceVoteDay ?? "random";
                            const active = cur === v || (v === "random" && !np.forceVoteDay);
                            return (
                              <button key={v} onClick={() => {
                                const p = [...nodeParams]; p[i] = { ...p[i], forceVoteDay: v === "random" ? null : v };
                                setNodeParams(p); const am = buildNetwork(p, edges); setAdjMap(am); reRunSim(p, am, globalConfig);
                              }} style={{ ...mono, fontSize: 10, fontWeight: active ? 700 : 400, padding: "3px 8px", borderRadius: 6, cursor: "pointer",
                                border: active ? "2px solid #7c3aed" : "1.5px solid #e2e8f0",
                                background: active ? "#f5f3ff" : "white",
                                color: active ? "#7c3aed" : "#94a3b8" }}>
                                {v === "random" ? "rnd" : v === "never" ? "✗" : `d${v}`}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {panel === "log" && (
              <div>
                <div style={{ background: "#eff6ff", border: "1.5px solid #bfdbfe", borderRadius: 8, padding: "9px 11px", ...mono, fontSize: 10, color: "#1e40af", lineHeight: 1.6, marginBottom: 10 }}>
                  Each day every unvoted person draws a random number 0–1.<br/>
                  <strong>draw &lt; propensity → VOTE</strong> · draw ≥ propensity → skip.<br/>
                  Voted neighbors add their edge weight to your propensity before you draw.
                </div>

                {simResult && nodeParams.map((np, i) => {
                  const isSel = selectedNode === i;
                  const finalState = simResult.history[globalConfig.days][i];
                  return (
                    <div key={i} style={{ marginBottom: 10, background: isSel ? "#eff6ff" : "#fafafa", border: `1.5px solid ${isSel ? "#bfdbfe" : C.border}`, borderRadius: 8, overflow: "hidden" }}
                      onClick={() => handleSelectNode(i)}>
                      {/* Node header */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", cursor: "pointer" }}>
                        <div style={{ width: 20, height: 20, borderRadius: "50%", background: finalState.voted ? C.coral : C.blue, display: "flex", alignItems: "center", justifyContent: "center", ...mono, fontSize: 9, fontWeight: 700, color: "white", flexShrink: 0 }}>{i}</div>
                        <span style={{ ...mono, fontSize: 10, fontWeight: 700, color: C.text }}>{nodeParams[i]?.name || i}</span>
                        <span style={{ ...mono, fontSize: 9, color: "#94a3b8" }}>p₀={np.propensity.toFixed(2)}</span>
                        {finalState.voted
                          ? <span style={{ ...mono, fontSize: 9, background: C.coral, color: "white", padding: "1px 6px", borderRadius: 99, marginLeft: "auto" }}>✓ voted d{finalState.votedDay}</span>
                          : <span style={{ ...mono, fontSize: 9, color: "#94a3b8", marginLeft: "auto" }}>never voted</span>}
                      </div>

                      {/* Day rows */}
                      <div style={{ borderTop: `1px solid ${C.border}` }}>
                        {/* Column headers */}
                        <div style={{ display: "grid", gridTemplateColumns: "26px 1fr 44px 44px 54px", gap: "0 5px", padding: "4px 10px", background: "#f1f5f9" }}>
                          {["day", "propensity (draw = tick)", "p", "draw", "result"].map(h => (
                            <span key={h} style={{ ...mono, fontSize: 8, color: "#94a3b8", fontWeight: 700 }}>{h}</span>
                          ))}
                        </div>
                        {Array.from({ length: globalConfig.days + 1 }, (_, d) => {
                          const hs = simResult.history[d][i];
                          const didVote = hs.voted && hs.votedDay === d;
                          const isCurrDay = d === currentDay;
                          const drawInVoteZone = d > 0 && hs.draw !== null && hs.draw < hs.propensity;
                          return (
                            <div key={d} style={{ display: "grid", gridTemplateColumns: "26px 1fr 44px 44px 54px", gap: "0 5px", padding: "5px 10px", alignItems: "center", background: isCurrDay ? "#dbeafe20" : didVote ? "#f0fdf425" : "transparent", borderBottom: "1px solid #f8fafc" }}>
                              <span style={{ ...mono, fontSize: 9, color: isCurrDay ? C.blue : "#94a3b8", fontWeight: isCurrDay ? 700 : 400 }}>d{d}</span>

                              {/* Bar: left fill = propensity (vote zone). Tick = where draw landed. */}
                              <div style={{ position: "relative" }}>
                                <div style={{ height: 8, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
                                  {/* propensity fill from left = if draw lands here, vote */}
                                  <div style={{
                                    position: "absolute", left: 0, height: "100%",
                                    width: `${hs.propensity * 100}%`,
                                    background: hs.voted ? `${C.coral}60` : "#bfdbfe",
                                    borderRadius: "99px 0 0 99px",
                                    transition: "width 0.2s",
                                  }} />
                                </div>
                                {/* propensity boundary line */}
                                <div style={{ position: "absolute", top: 0, height: 8, width: 1.5, background: C.blue, left: `${hs.propensity * 100}%`, transform: "translateX(-50%)" }} />
                                {/* draw tick — shows where the random draw actually landed */}
                                {d > 0 && hs.draw !== null && !hs.voted && (
                                  <div style={{
                                    position: "absolute", top: -1, height: 10, width: 2.5,
                                    background: drawInVoteZone ? C.coral : "#64748b",
                                    borderRadius: 2, left: `${hs.draw * 100}%`,
                                    transform: "translateX(-50%)", zIndex: 2,
                                  }} />
                                )}
                                {/* influence received */}
                                {d > 0 && hs.influenceReceived > 0.001 && (
                                  <div style={{ ...mono, fontSize: 7, color: "#22c55e", marginTop: 1 }}>
                                    +{hs.influenceReceived.toFixed(2)} influence
                                  </div>
                                )}
                              </div>

                              {/* propensity value */}
                              <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: hs.voted ? C.coral : C.text, textAlign: "right" }}>
                                {hs.propensity.toFixed(2)}
                              </span>

                              {/* draw value */}
                              <span style={{ ...mono, fontSize: 9, fontWeight: didVote ? 700 : 400, color: d > 0 && hs.draw !== null ? (didVote ? C.coral : "#475569") : "#d1d5db", textAlign: "right" }}>
                                {d > 0 && hs.draw !== null ? hs.draw.toFixed(2) : "—"}
                              </span>

                              {/* decision */}
                              <span style={{ ...mono, fontSize: 8, textAlign: "right" }}>
                                {d === 0
                                  ? <span style={{ color: "#94a3b8" }}>start</span>
                                  : hs.voted && hs.votedDay === d
                                    ? <span style={{ color: C.coral, fontWeight: 700 }}>✓ VOTED</span>
                                    : hs.voted
                                      ? <span style={{ color: "#94a3b8" }}>—</span>
                                      : d > 0 && hs.draw !== null
                                        ? <span style={{ color: "#94a3b8" }}>{hs.draw.toFixed(2)} ≥ {hs.propensity.toFixed(2)}</span>
                                        : null}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginTop: 6, lineHeight: 1.6 }}>
                  Blue bar = propensity (vote zone) · Vertical tick = where draw landed · Votes when draw &lt; p
                </div>
              </div>
            )}

            {/* ── CF PANEL ── */}
            {panel === "cf" && (
              <div>
                <div style={{ background: "#fef9ee", border: "1.5px solid #fde68a", borderRadius: 8, padding: "9px 11px", ...mono, fontSize: 10, color: "#92400e", lineHeight: 1.6, marginBottom: 12 }}>
                  Force a node to vote on a chosen day with all random draws held fixed. Watch how the influence cascade changes.
                </div>
                <SH>FORCE FLIP</SH>
                <Card style={{ padding: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <div>
                      <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 3 }}>NODE</div>
                      <input type="number" min={0} max={nodeCount - 1} value={cfNode ?? 0} onChange={e => setCfNode(Number(e.target.value))} />
                    </div>
                    <div>
                      <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginBottom: 3 }}>DAY</div>
                      <input type="number" min={1} max={globalConfig.days} value={cfDay} onChange={e => setCfDay(Number(e.target.value))} />
                    </div>
                  </div>
                  {selectedNode !== null && <button className="btn btn-ghost" style={{ width: "100%", marginBottom: 8, fontSize: 10 }} onClick={() => setCfNode(selectedNode)}>Use selected ({selectedNode})</button>}
                  <button className="btn btn-amber" style={{ width: "100%" }} onClick={runCF}>★ Run counterfactual</button>
                </Card>
                {cfResult && simResult && (
                  <div style={{ marginTop: 12 }}>
                    <SH>COMPARISON</SH>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      {[["BASELINE", simResult], ["CF", cfResult]].map(([lbl, r]) => (
                        <Card key={lbl} style={{ padding: "9px 11px", border: `1.5px solid ${r.passed ? "#4ade80" : "#fca5a5"}`, background: r.passed ? "#f0fdf4" : "#fff5f5" }}>
                          <div style={{ ...mono, fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>{lbl}</div>
                          <div style={{ ...mono, fontSize: 12, fontWeight: 700, color: r.passed ? C.green : C.red }}>{r.passed ? `✓ day ${r.passedDay}` : "✗ failed"}</div>
                          <div style={{ ...mono, fontSize: 10, color: "#64748b" }}>{r.finalVotes} votes</div>
                        </Card>
                      ))}
                    </div>
                    {simResult.passed !== cfResult.passed && (
                      <div style={{ marginTop: 8, padding: "8px 11px", background: "#fef3c7", border: "1.5px solid #fcd34d", borderRadius: 8, ...mono, fontSize: 10, color: "#92400e", fontWeight: 700 }}>
                        ★ Outcome changed!
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                      <button className={`btn ${!showCf ? "btn-active" : "btn-ghost"}`} style={{ flex: 1 }} onClick={() => setShowCf(false)}>Baseline</button>
                      <button className={`btn ${showCf ? "btn-amber" : "btn-ghost"}`} style={{ flex: 1 }} onClick={() => setShowCf(true)}>★ CF</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
        <div onMouseDown={e => onSimDividerDown("left", e)}
          style={{ width: 5, cursor: "col-resize", flexShrink: 0, borderRight: `1.5px solid ${C.border}`, background: "transparent", transition: "background 0.15s", zIndex: 1 }}
          onMouseEnter={e => e.currentTarget.style.background = "#dbeafe"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"} />

        {/* ══ CENTER GRAPH ══ */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", background: C.bg, minWidth: 0 }}>
          {/* Playback bar */}
          <div style={{ padding: "8px 14px", background: C.white, borderBottom: `1.5px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <button className={`btn ${playing ? "btn-ghost" : "btn-blue"}`} onClick={togglePlay} style={{ minWidth: 60 }}>{playing ? "⏸" : "▶ play"}</button>
            <button className="btn btn-ghost" onClick={() => { clearInterval(playRef.current); setPlaying(false); setCurrentDay(0); }}>↩</button>
            <input type="range" min={0} max={globalConfig.days} value={currentDay} style={{ flex: 1 }}
              onChange={e => { clearInterval(playRef.current); setPlaying(false); setCurrentDay(Number(e.target.value)); }} />
            <span style={{ ...mono, fontSize: 12, fontWeight: 700, minWidth: 68 }}>Day {currentDay}/{globalConfig.days}</span>
            <button className={`btn btn-ghost ${showWeights ? "btn-active" : ""}`} onClick={() => setShowWeights(w => !w)} style={{ fontSize: 10 }}>
              {showWeights ? "✓ weights" : "weights"}
            </button>
            {cfResult && <>
              <button className={`btn ${!showCf ? "btn-active" : "btn-ghost"}`} onClick={() => setShowCf(false)}>base</button>
              <button className={`btn ${showCf ? "btn-amber" : "btn-ghost"}`} onClick={() => setShowCf(true)}>★ cf</button>
            </>}
            <button className="btn btn-ghost" onClick={openSnapshot} title="Screenshot current day" style={{ fontSize: 14, padding: "4px 8px" }}>📷</button>
          <button className={`btn ${showDefault ? "btn-blue" : "btn-ghost"}`} onClick={() => setShowDefault(v => !v)} title="Toggle default view (grey, no bars)" style={{ fontSize: 11 }}>{showDefault ? "● default" : "○ default"}</button>
          <button className="btn btn-ghost" onClick={() => setShowTrialHistory(v => !v)} style={{ fontSize: 11 }}>📋 History {trialHistory.length > 0 ? `(${trialHistory.length})` : ""}</button>
          </div>

          {/* Graph */}
          <div ref={graphContainerRef} style={{ flex: 1, position: "relative", overflow: "hidden" }}
            onWheel={e => {
              e.preventDefault();
              const factor = e.deltaY < 0 ? 1.1 : 0.91;
              setGraphZoom(z => Math.max(0.3, Math.min(4, z * factor)));
            }}
            onMouseDown={e => {
              if (e.button !== 1 && !e.altKey) return;
              graphPanning.current = true;
              graphPanStart.current = { x: e.clientX, y: e.clientY };
              graphPanOrigin.current = { ...graphPan };
              e.preventDefault();
            }}
            onMouseMove={e => {
              if (!graphPanning.current) return;
              setGraphPan({ x: graphPanOrigin.current.x + e.clientX - graphPanStart.current.x, y: graphPanOrigin.current.y + e.clientY - graphPanStart.current.y });
            }}
            onMouseUp={() => { graphPanning.current = false; }}
            onMouseLeave={() => { graphPanning.current = false; }}
          >
            {/* Zoom controls */}
            <div style={{ position: "absolute", bottom: 12, right: 12, display: "flex", flexDirection: "column", gap: 4, zIndex: 10 }}>
              <button onClick={() => setGraphZoom(z => Math.min(4, z * 1.2))}
                style={{ width: 28, height: 28, border: `1.5px solid ${C.border}`, borderRadius: 6, background: C.white, cursor: "pointer", ...mono, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px #0001" }}>+</button>
              <button onClick={() => setGraphZoom(z => Math.max(0.3, z * 0.83))}
                style={{ width: 28, height: 28, border: `1.5px solid ${C.border}`, borderRadius: 6, background: C.white, cursor: "pointer", ...mono, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px #0001" }}>−</button>
              <button onClick={() => { setGraphZoom(1); setGraphPan({ x: 0, y: 0 }); }}
                style={{ width: 28, height: 28, border: `1.5px solid ${C.border}`, borderRadius: 6, background: C.white, cursor: "pointer", ...mono, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px #0001", color: "#64748b" }}>fit</button>
            </div>
            {displayState && positions.length > 0 && (
              <div style={{ width: "100%", height: "100%", transform: `translate(${graphPan.x}px, ${graphPan.y}px) scale(${graphZoom})`, transformOrigin: "center center", transition: graphPanning.current ? "none" : "transform 0.05s" }}>
              <NetworkGraph
                positions={positions} edges={edges} state={displayState} nextDayState={nextDayState}
                selectedNode={selectedNode} onSelectNode={handleSelectNode}
                onSelectEdge={ei => setSelectedEdgeIdx(ei === selectedEdgeIdx ? null : ei)}
                cfNode={showCf ? cfNode : null}
                showWeights={showWeights}
                showDefault={showDefault}
                frozenPropensity={frozenPropensity}
                hoveredKey={hovKey}
                highlightEdgeIdx={draggingEdgeIdx ?? expandedEdgeIdx ?? selectedEdgeIdx}
                onHoverEdge={handleHoverEdge}
              />
              </div>
            )}
            {hovInfo && (
              <div style={{ position: "absolute", bottom: 44, left: "50%", transform: "translateX(-50%)", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "6px 14px", ...mono, fontSize: 11, boxShadow: "0 2px 10px #0000001a", pointerEvents: "none", whiteSpace: "nowrap" }}>
                <strong style={{ color: C.blue }}>{nodeParams[hovInfo.from]?.name ?? hovInfo.from}</strong>
                <span style={{ color: "#94a3b8", margin: "0 6px" }}>→</span>
                <strong style={{ color: C.blue }}>{nodeParams[hovInfo.to]?.name ?? hovInfo.to}</strong>
                <span style={{ color: "#94a3b8", margin: "0 6px" }}>·</span>
                weight <strong>{hovInfo.w.toFixed(2)}</strong>
                <span style={{ color: "#94a3b8", marginLeft: 10, fontSize: 9 }}>click Edges tab to edit</span>
              </div>
            )}
            <div style={{ position: "absolute", bottom: 10, left: 14, ...mono, fontSize: 9, color: "#94a3b8" }}>
              Click person · Dashed ring = propensity arc · Hover edge to inspect · Arrow = influence direction
            </div>
          </div>
        </main>

        <div onMouseDown={e => onSimDividerDown("right", e)}
          style={{ width: 5, cursor: "col-resize", flexShrink: 0, borderLeft: `1.5px solid ${C.border}`, background: "transparent", transition: "background 0.15s", zIndex: 1 }}
          onMouseEnter={e => e.currentTarget.style.background = "#dbeafe"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"} />

        {/* ══ RIGHT PANEL — Stats ══ */}
        <aside style={{ width: simRightW, background: C.white, borderLeft: "none", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          <div style={{ padding: "10px 13px", borderBottom: `1.5px solid ${C.border}`, flexShrink: 0 }}>
            <SH>DAY {currentDay} · RESULTS</SH>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
              <Card style={{ padding: "8px 10px" }}>
                <div style={{ ...mono, fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>VOTES</div>
                <div style={{ fontFamily: "'Fraunces'", fontSize: 22, fontWeight: 700, color: C.coral }}>{currentVotes}</div>
              </Card>
              <Card style={{ padding: "8px 10px" }}>
                <div style={{ ...mono, fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>NEED</div>
                <div style={{ fontFamily: "'Fraunces'", fontSize: 22, fontWeight: 700, color: "#94a3b8" }}>{globalConfig.threshold}</div>
              </Card>
            </div>
            <div style={{ marginTop: 7 }}>
              <PropBar value={currentVotes} max={nodeCount} color={currentVotes >= globalConfig.threshold ? C.green : C.coral} h={7} />
              <div style={{ ...mono, fontSize: 9, color: "#64748b", marginTop: 4 }}>{((currentVotes / nodeCount) * 100).toFixed(0)}% · {nodeCount - currentVotes} remaining</div>
            </div>
          </div>

          {/* All nodes propensity list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "10px 13px" }}>
            <SH>ALL NODES · p @ day {currentDay}</SH>
            <Card style={{ padding: "7px 9px", marginBottom: 12 }}>
              {displayState && [...displayState].map((s, i) => ({ ...s, i })).sort((a, b) => b.propensity - a.propensity).map(s => {
                const hue = 210 - s.propensity * 80;
                return (
                  <div key={s.i} onClick={() => handleSelectNode(s.i)}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 3px", borderRadius: 4, cursor: "pointer", background: selectedNode === s.i ? "#eff6ff" : "transparent", marginBottom: 2 }}>
                    <span style={{ ...mono, fontSize: 9, color: "#94a3b8", minWidth: 16 }}>{s.name || s.i}</span>
                    <div style={{ flex: 1, position: "relative", height: 6, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${s.propensity * 100}%`, background: s.voted ? C.coral : `hsl(215,${Math.round(40+s.propensity*40)}%,${Math.round(88-s.propensity*45)-10}%)`, borderRadius: 99 }} />
                    </div>
                    <span style={{ ...mono, fontSize: 9, fontWeight: 700, minWidth: 40, textAlign: "right", color: s.voted ? C.coral : C.text }}>
                      {s.voted ? `✓d${s.votedDay}` : s.propensity.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </Card>

            {/* Vote progression sparkline */}
            <SH>VOTE PROGRESSION</SH>
            <Card style={{ padding: 10, marginBottom: 12 }}>
              {(() => {
                const W = 200, H = 55, days = globalConfig.days;
                const px = d => (d / days) * (W - 14) + 7;
                const py = v => H - 5 - (v / nodeCount) * (H - 12);
                const thY = py(globalConfig.threshold);
                const bv = simResult ? Array.from({ length: days + 1 }, (_, d) => simResult.history[d].filter(s => s.voted).length) : [];
                const cv = cfResult ? Array.from({ length: days + 1 }, (_, d) => cfResult.history[d].filter(s => s.voted).length) : null;
                const toPath = arr => arr.map((v, d) => `${d === 0 ? "M" : "L"}${px(d)},${py(v)}`).join(" ");
                return (
                  <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
                    <rect x={0} y={thY} width={W} height={H - thY} fill="#16a34a08" />
                    <line x1={0} y1={thY} x2={W} y2={thY} stroke="#22c55e" strokeWidth="1" strokeDasharray="4 3" opacity={0.4} />
                    {bv.length > 1 && <>
                      <path d={toPath(bv) + ` L${px(days)},${H} L${px(0)},${H} Z`} fill="#2563eb0d" />
                      <path d={toPath(bv)} fill="none" stroke="#2563eb" strokeWidth="1.8" strokeLinejoin="round" />
                    </>}
                    {cv && <path d={toPath(cv)} fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeDasharray="5 3" strokeLinejoin="round" />}
                    <line x1={px(currentDay)} y1={0} x2={px(currentDay)} y2={H} stroke="#64748b" strokeWidth="1" strokeDasharray="2 2" opacity={0.5} />
                    <text x={7} y={H - 1} fontSize="7" fill="#94a3b8" fontFamily="'DM Mono',monospace">0</text>
                    <text x={W - 7} y={H - 1} fontSize="7" fill="#94a3b8" fontFamily="'DM Mono',monospace" textAnchor="end">d{days}</text>
                  </svg>
                );
              })()}
              <div style={{ display: "flex", gap: 10, marginTop: 5 }}>
                {[["#2563eb", "baseline"], ...(cfResult ? [["#f59e0b", "cf"]] : []), ["#22c55e", "threshold"]].map(([col, lbl]) => (
                  <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <div style={{ width: 10, height: 2, background: col, opacity: lbl === "threshold" ? 0.4 : 1 }} />
                    <span style={{ ...mono, fontSize: 8, color: "#64748b" }}>{lbl}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Selected node quick info */}
            {selectedNode !== null && selNodeData && selNodeParams && (
              <>
                <SH>NODE {nodeParams[selectedNode]?.name ?? selectedNode} DETAIL</SH>
                <Card style={{ padding: "9px 11px" }}>
                  {/* Person figure preview */}
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                    <svg viewBox="-35 -38 70 90" width={130} height={130} style={{ overflow: "visible" }}>
                      <PersonFigure x={0} y={0}
                        propensity={selNodeData.propensity}
                        voted={selNodeData.voted ? selNodeData.votedDay : false}
                        isSelected={false}
                        isCF={false}
                        nodeId={selectedNode}
                        onClick={() => {}}
                      />
                    </svg>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                    {[["init p", selNodeParams.propensity.toFixed(2), "#f59e0b"], ["curr p", selNodeData.propensity.toFixed(2), C.blue], ["edges", connectedEdges.length, "#22c55e"]].map(([k, v, c]) => (
                      <div key={k} style={{ background: "#f8fafc", borderRadius: 5, padding: "5px 7px" }}>
                        <div style={{ ...mono, fontSize: 7, color: "#94a3b8", marginBottom: 1 }}>{k}</div>
                        <div style={{ ...mono, fontSize: 12, fontWeight: 700, color: c }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ ...mono, fontSize: 9, color: selNodeData.voted ? C.coral : C.slate, fontWeight: selNodeData.voted ? 700 : 400 }}>
                    {selNodeData.voted ? `✓ Voted on day ${selNodeData.votedDay}` : `Pending · propensity = ${selNodeData.propensity.toFixed(2)}`}
                  </div>
                  {selNodeData.draw !== null && !selNodeData.voted && (
                    <div style={{ ...mono, fontSize: 9, color: "#64748b", marginTop: 4 }}>
                      Day {currentDay} draw: {selNodeData.draw.toFixed(2)} {selNodeData.draw < selNodeData.propensity ? "< p → voted!" : `≥ ${selNodeData.propensity.toFixed(2)} → skip`}
                    </div>
                  )}
                </Card>
              </>
            )}
          </div>
        </aside>
      </div>

      {/* ── Screenshot modal ── */}
      {jsonModal && (
        <div onClick={() => setJsonModal(null)} style={{ position: "fixed", inset: 0, zIndex: 200, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "white", borderRadius: 12, padding: 20, boxShadow: "0 8px 40px #0004", width: "min(700px, 90vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 700, color: "#2563eb" }}>sim_result.json</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: "#94a3b8" }}>Select all → Cmd+C to copy, then paste into a .json file</span>
                <button onClick={() => setJsonModal(null)} style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#f1f5f9", border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}>✕</button>
              </div>
            </div>
            <textarea readOnly value={jsonModal}
              onClick={e => e.target.select()}
              onFocus={e => e.target.select()}
              style={{ flex: 1, minHeight: 420, fontFamily: "'DM Mono',monospace", fontSize: 11, border: "1.5px solid #e2e8f0", borderRadius: 8, padding: 12, resize: "vertical", color: "#1e293b", background: "#f8fafc", outline: "none", cursor: "text" }} />
          </div>
        </div>
      )}
      {showTrialHistory && (
        <div onClick={() => setShowTrialHistory(false)} style={{ position: "fixed", inset: 0, zIndex: 200, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "white", borderRadius: 12, padding: 20, boxShadow: "0 8px 40px #0004", width: "min(700px, 95vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 700, color: "#2563eb" }}>Trial History ({trialHistory.length})</span>
              <div style={{ display: "flex", gap: 8 }}>
                {trialHistory.length > 0 && <button onClick={() => { setTrialHistory([]); localStorage.removeItem("votewave_trials"); }} style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, background: "#f0fdf4", color: "#b91c1c", border: "none", padding: "5px 12px", borderRadius: 6, cursor: "pointer" }}>Clear all</button>}
                <button onClick={() => setShowTrialHistory(false)} style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#f1f5f9", border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}>✕</button>
              </div>
            </div>
            <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
              {trialHistory.length === 0 && <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 12, color: "#94a3b8", padding: "20px 0", textAlign: "center" }}>No trials saved yet. Run a trial to save it here.</div>}
              {trialHistory.map(entry => (
                <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 8, border: "1.5px solid #e2e8f0", background: "#f8fafc" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, fontWeight: 700, color: "#1e293b" }}>Seed {entry.seed} · {entry.nodes} agents · {entry.days} days · threshold {entry.threshold}</div>
                    <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: "#64748b", marginTop: 2 }}>{entry.date}{entry.keyAgentNames?.length > 0 ? ` · highlighted: ${entry.keyAgentNames.join(", ")}` : ""}</div>
                  </div>
                  <div style={{ display: "flex", gap: 4, overflowX: "auto", maxWidth: 200, flexShrink: 0 }}>
                    {entry.pngsClean.slice(0, 4).map(({ day, dataUrl }) => (
                      <img key={day} src={dataUrl} alt={`Day ${day}`} style={{ height: 40, borderRadius: 4, border: "1px solid #e2e8f0", flexShrink: 0 }} />
                    ))}
                  </div>
                  <button onClick={() => loadTrialState(entry)} style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#22c55e", color: "white", border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer", flexShrink: 0 }}>✎ Edit</button>
                  <button onClick={() => redownloadTrial(entry)} style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#2563eb", color: "white", border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer", flexShrink: 0 }}>↓ ZIP</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {pendingTrialSave && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 300, background: "white", borderRadius: 10, padding: "14px 20px", boxShadow: "0 4px 24px #0003", display: "flex", alignItems: "center", gap: 14, border: "1.5px solid #e2e8f0" }}>
          <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 12, color: "#1e293b" }}>Save trial to history?</span>
          <button onClick={() => { saveTrialToHistory(pendingTrialSave.seed, pendingTrialSave.jsonStr, pendingTrialSave.pngsClean, pendingTrialSave.pngsHighlight, pendingTrialSave.keyAgentNames); setPendingTrialSave(null); }}
            style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#2563eb", color: "white", border: "none", padding: "6px 16px", borderRadius: 6, cursor: "pointer" }}>Save</button>
          <button onClick={() => setPendingTrialSave(null)}
            style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#f1f5f9", color: "#64748b", border: "none", padding: "6px 16px", borderRadius: 6, cursor: "pointer" }}>Don't save</button>
        </div>
      )}
      {trialModal && (
        <div onClick={() => setTrialModal(null)} style={{ position: "fixed", inset: 0, zIndex: 200, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "white", borderRadius: 12, padding: 20, boxShadow: "0 8px 40px #0004", width: "min(900px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 700, color: "#2563eb" }}>Trial — {trialModal.pngs.length} snapshots · seed {trialModal.seed}</span>
              <button onClick={() => setTrialModal(null)} style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#f1f5f9", border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}>✕ close</button>
            </div>

            {/* Screenshot grid */}
            <div style={{ display: "flex", gap: 8, overflowX: "auto", flexShrink: 0, paddingBottom: 4 }}>
              {trialModal.pngs.map(({ day, dataUrl }) => (
                <div key={day} style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <img src={dataUrl} alt={`Day ${day}`} style={{ height: 120, borderRadius: 6, border: "1.5px solid #e2e8f0", cursor: "pointer" }}
                    onClick={() => setSnapModal({ dataUrl, day })} />
                  <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, color: "#64748b" }}>Day {day}</span>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
              <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: "#94a3b8", alignSelf: "center" }}>Click any image to enlarge · right-click → Save Image As</span>
            </div>

            {/* JSON section */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minHeight: 0 }}>
              <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: "#64748b" }}>JSON — click to select all, then Cmd+C</div>
              <textarea readOnly value={trialModal.jsonStr}
                onClick={e => e.target.select()} onFocus={e => e.target.select()}
                style={{ flex: 1, minHeight: 180, fontFamily: "'DM Mono',monospace", fontSize: 10, border: "1.5px solid #e2e8f0", borderRadius: 8, padding: 10, resize: "none", color: "#1e293b", background: "#f8fafc", outline: "none" }} />
            </div>
          </div>
        </div>
      )}
      {snapModal && (
        <div onClick={() => setSnapModal(null)} style={{ position: "fixed", inset: 0, zIndex: 200, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "white", borderRadius: 12, padding: 20, boxShadow: "0 8px 40px #0004", maxWidth: "90vw", maxHeight: "90vh", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}>
              <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 700, color: "#2563eb" }}>Day {snapModal.day} snapshot</span>
              <div style={{ display: "flex", gap: 8 }}>
                <a href={snapModal.dataUrl} download={`network-day${String(snapModal.day).padStart(2,"0")}.png`}
                  style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#2563eb", color: "white", padding: "6px 14px", borderRadius: 6, textDecoration: "none", cursor: "pointer" }}>
                  ↓ Download PNG
                </a>
                <button onClick={() => setSnapModal(null)} style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, background: "#f1f5f9", border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}>✕ close</button>
              </div>
            </div>
            <img src={snapModal.dataUrl} alt={`Day ${snapModal.day}`} style={{ maxWidth: "80vw", maxHeight: "70vh", borderRadius: 8, border: "1.5px solid #e2e8f0", objectFit: "contain" }} />
            <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: "#94a3b8" }}>
              Right-click image → "Save Image As" to save · or use ↓ Download PNG
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
