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
function layoutNodes(n, seed) {
  const rng = mulberry32(seed + 77);
  const cx = 400, cy = 295, r = 215;
  return Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2 + rng() * 0.15;
    const dist = r * (0.5 + rng() * 0.5);
    return { x: cx + dist * Math.cos(angle), y: cy + dist * Math.sin(angle) };
  });
}

// ─── Build edges from node params ─────────────────────────────────────────────
// edges: [ { from, to, wFT (from→to), wTF (to→from) } ]
// adjMap[i][j] = weight of influence j has on i (i.e. when j votes, i's propensity rises by adjMap[i][j])
function buildNetwork(nodeParams, edgeList) {
  const n = nodeParams.length;
  const adjMap = Array.from({ length: n }, () => ({}));
  edgeList.forEach(e => {
    adjMap[e.to][e.from] = e.wFT;   // from votes → to gains wFT influence
    adjMap[e.from][e.to] = e.wTF;   // to votes   → from gains wTF influence
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
        wFT: Math.round((0.08 + rng() * 0.32) * 100) / 100,
        wTF: Math.round((0.08 + rng() * 0.32) * 100) / 100,
      };
    }
  }
  return Object.values(edgeMap);
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
      if (next[i].voted) continue;

      // ONE-TIME influence: only from neighbors who voted EXACTLY yesterday
      // (votedDay === day - 1). This boost was not included in yesterday's propensity,
      // so it gets added now and becomes a permanent part of propensity going forward.
      let inf = 0;
      for (const [jStr, w] of Object.entries(adjMap[i] || {})) {
        const j = Number(jStr);
        if (prev[j].voted && prev[j].votedDay === day - 1) inf += w;
      }

      // Propensity grows permanently by the influence received (capped at 1)
      const newP = Math.min(1, prev[i].propensity + inf);

      const draw = draws[i][day - 1];
      next[i] = { ...next[i], propensity: newP, influenceReceived: inf, draw };
      if (draw < newP) {
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
function PersonFigure({ x, y, propensity, voted, isSelected, isCF, nodeId, onClick }) {
  const hue = 210 - propensity * 80;
  const sat = 60 + propensity * 30;
  const lit = 72 - propensity * 32;
  const bodyColor = voted ? "#e85d42" : isSelected ? "#2563eb" : isCF ? "#f59e0b" : `hsl(${hue},${sat}%,${lit}%)`;
  const strokeC = voted ? "#b83222" : isSelected ? "#1741b0" : isCF ? "#b45309" : `hsl(${hue},${sat}%,${lit - 18}%)`;
  const textC = (voted || isSelected || propensity > 0.55) ? "white" : "#1e293b";

  // propensity ring (arc)
  const ringR = 22;
  const circ = 2 * Math.PI * ringR;
  const dash = circ * propensity;

  return (
    <g transform={`translate(${x},${y})`} onClick={onClick} style={{ cursor: "pointer" }}>
      {/* Selection / CF ring */}
      {isSelected && <circle r={26} fill="none" stroke="#2563eb" strokeWidth="2" strokeDasharray="5 3" opacity={0.6} />}
      {isCF && <circle r={28} fill="#f59e0b18" stroke="#f59e0b" strokeWidth="2" />}

      {/* Propensity arc (starts top, clockwise) */}
      {!voted && (
        <circle r={ringR} fill="none"
          stroke={`hsl(${hue},${sat}%,${lit - 10}%)`}
          strokeWidth="3.5" opacity={0.45}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ * 0.25}
          transform="rotate(-90)"
        />
      )}

      {/* Legs */}
      <line x1="-3.5" y1="16" x2="-6" y2="27" stroke={strokeC} strokeWidth="2.2" strokeLinecap="round" />
      <line x1="3.5" y1="16" x2="6" y2="27" stroke={strokeC} strokeWidth="2.2" strokeLinecap="round" />
      {/* Arms */}
      <line x1="-2" y1="5" x2="-10" y2="13" stroke={strokeC} strokeWidth="2.2" strokeLinecap="round" />
      <line x1="2" y1="5" x2="10" y2="13" stroke={strokeC} strokeWidth="2.2" strokeLinecap="round" />
      {/* Torso */}
      <rect x="-4.5" y="0" width="9" height="16" rx="2.5" fill={bodyColor} stroke={strokeC} strokeWidth="1.5" />
      {/* Head */}
      <circle cy="-8" r="7" fill={bodyColor} stroke={strokeC} strokeWidth="1.8" />
      {/* ID */}
      <text y="-7.5" textAnchor="middle" dominantBaseline="middle" fontSize="6" fill={textC} fontWeight="700" fontFamily="'DM Mono',monospace" style={{ pointerEvents: "none" }}>{nodeId}</text>

      {/* Propensity label */}
      <text y="35" textAnchor="middle" fontSize="6" fill={voted ? "#e85d42" : "#475569"} fontWeight="600" fontFamily="'DM Mono',monospace" style={{ pointerEvents: "none" }}>
        {voted ? `✓d${voted}` : `p=${propensity.toFixed(2)}`}
      </text>

      {/* "I VOTED" badge */}
      {voted && (
        <g transform="translate(10,-16)">
          <line x1="-2" y1="0" x2="-2" y2="9" stroke="#b83222" strokeWidth="1.2" />
          <rect x="0" y="-5" width="24" height="11" rx="2" fill="#e85d42" stroke="#b83222" strokeWidth="0.8" />
          <text x="12" y="0.5" textAnchor="middle" dominantBaseline="middle" fontSize="5" fill="white" fontWeight="700" fontFamily="'DM Mono',monospace" style={{ pointerEvents: "none" }}>✓ VOTED</text>
        </g>
      )}
    </g>
  );
}

// ─── Network graph ────────────────────────────────────────────────────────────
function NetworkGraph({ positions, edges, state, selectedNode, onSelectNode, onSelectEdge, cfNode, showWeights, onHoverEdge, hoveredKey, highlightEdgeIdx }) {
  return (
    <svg viewBox="0 0 800 590" style={{ width: "100%", height: "100%" }}>
      <defs>
        {[["arr", "#94a3b8"], ["arrV", "#e85d42"], ["arrS", "#2563eb"], ["arrH", "#1d4ed8"]].map(([id, col]) => (
          <marker key={id} id={id} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,1 L6,3.5 L0,6 Z" fill={col} />
          </marker>
        ))}
      </defs>

      {edges.map((e, ei) => {
        const selInv = selectedNode === e.from || selectedNode === e.to;
        const isHighlightedEdge = highlightEdgeIdx === ei;
        return [
          { from: e.from, to: e.to, w: e.wFT, off: 4, key: `${ei}-ft` },
          { from: e.to, to: e.from, w: e.wTF, off: -4, key: `${ei}-tf` },
        ].map(({ from, to, w, off, key }) => {
          const p1 = positions[from], p2 = positions[to];
          const dx = p2.x - p1.x, dy = p2.y - p1.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux = dx / len, uy = dy / len;
          const px = -uy * off, py = ux * off;
          const NR = 24;
          const sx = p1.x + ux * NR + px, sy = p1.y + uy * NR + py;
          const ex = p2.x - ux * (NR + 7) + px, ey = p2.y - uy * (NR + 7) + py;
          const voted = state[from].voted;
          const isHov = hoveredKey === key;
          const isActive = isHighlightedEdge;
          const col = isActive ? "#1d4ed8" : isHov ? "#93c5fd" : voted ? "#e85d42" : selInv ? "#2563eb" : "#94a3b8";
          const sw = showWeights ? 0.8 + w * 6 : isActive || selInv ? 2 : isHov ? 1.5 : 1;
          const marker = isActive ? "url(#arrH)" : voted ? "url(#arrV)" : selInv ? "url(#arrS)" : "url(#arr)";
          return (
            <g key={key}
              onMouseEnter={() => onHoverEdge(key, { edgeIdx: ei, from, to, w })}
              onMouseLeave={() => onHoverEdge(null, null)}
              onClick={() => onSelectEdge(ei)}>
              <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="transparent" strokeWidth={14} style={{ cursor: "pointer" }} />
              <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={col} strokeWidth={sw} opacity={isActive || selInv ? 1 : isHov ? 0.7 : 0.4} markerEnd={marker} />
              {(showWeights || isActive) && (
                <text x={(sx + ex) / 2} y={(sy + ey) / 2 - 5} textAnchor="middle" fontSize="8" fill={isActive ? "#1d4ed8" : "#64748b"} fontWeight={isActive ? "700" : "400"} fontFamily="'DM Mono',monospace">{w.toFixed(2)}</text>
              )}
            </g>
          );
        });
      })}

      {positions.map((pos, i) => (
        <PersonFigure key={i} x={pos.x} y={pos.y}
          propensity={state[i].propensity}
          voted={state[i].voted}
          isSelected={selectedNode === i}
          isCF={cfNode === i}
          nodeId={i}
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
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    propensity: Math.round((0.25 + rng() * 0.50) * 100) / 100,
    influence: Math.round((0.10 + rng() * 0.25) * 100) / 100,
  }));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [nodeCount, setNodeCount] = useState(10);
  const [nodeParams, setNodeParams] = useState(() => makeNodes(10));
  const [edges, setEdges] = useState([]);
  const [positions, setPositions] = useState([]);
  const [adjMap, setAdjMap] = useState([]);
  const [globalConfig, setGlobalConfig] = useState({ days: 7, threshold: 6, simSeed: 42 });
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
  const [hovKey, setHovKey] = useState(null);
  const [hovInfo, setHovInfo] = useState(null);
  const [panel, setPanel] = useState("nodes"); // nodes | edges | log | cf
  const playRef = useRef(null);

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
      const extras = Array.from({ length: clamped - current }, (_, i) => ({
        id: current + i,
        propensity: Math.round((0.25 + rng() * 0.50) * 100) / 100,
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
    const f = Math.min(from, to), t = Math.max(from, to);
    if (f === t) return;
    if (setupEdges.some(e => e.from === f && e.to === t)) return;
    setSetupEdges([...setupEdges, { from: f, to: t, wFT: 0.20, wTF: 0.20 }]);
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
    const from = Math.min(addEdgeFrom, addEdgeTo);
    const to = Math.max(addEdgeFrom, addEdgeTo);
    if (from === to) return;
    if (edges.some(e => e.from === from && e.to === to)) return; // already exists
    const ne = [...edges, { from, to, wFT: 0.20, wTF: 0.20 }];
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
  const currentVotes = displayState?.filter(s => s.voted).length ?? 0;
  const passed = activeResult?.passed;
  const passedDay = activeResult?.passedDay;

  // CSV export with full draw log
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

  const C = {
    blue: "#2563eb", coral: "#e85d42", amber: "#f59e0b",
    green: "#16a34a", red: "#dc2626", slate: "#64748b",
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

      {/* ── SETUP MODAL ── */}
      {showSetup && (
        <div style={{ position: "fixed", inset: 0, background: "#0008", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: C.white, borderRadius: 14, boxShadow: "0 20px 60px #0003", width: 680, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Modal header */}
            <div style={{ padding: "18px 22px 0", borderBottom: `1.5px solid ${C.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Network Setup</div>
                  <div style={{ ...mono, fontSize: 10, color: "#94a3b8", marginTop: 2 }}>configure nodes and connections before running</div>
                </div>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ ...mono, fontSize: 10, color: "#64748b" }}>Nodes:</span>
                    <input type="number" min={2} max={25} value={setupNodeCount}
                      onChange={e => handleSetupNodeCount(Number(e.target.value))}
                      style={{ width: 56, textAlign: "center" }} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ ...mono, fontSize: 10, color: "#64748b" }}>Days:</span>
                    <input type="number" min={1} max={20} value={globalConfig.days}
                      onChange={e => setGlobalConfig(g => ({ ...g, days: Number(e.target.value) }))}
                      style={{ width: 52, textAlign: "center" }} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ ...mono, fontSize: 10, color: "#64748b" }}>Threshold:</span>
                    <input type="number" min={1} max={setupNodeCount} value={globalConfig.threshold}
                      onChange={e => setGlobalConfig(g => ({ ...g, threshold: Number(e.target.value) }))}
                      style={{ width: 52, textAlign: "center" }} />
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 2 }}>
                {[["nodes", `Nodes (${setupNodes.length})`], ["edges", `Edges (${setupEdges.length})`]].map(([id, lbl]) => (
                  <button key={id} className={`tab ${setupTab === id ? "on" : ""}`} onClick={() => setSetupTab(id)}>{lbl}</button>
                ))}
              </div>
            </div>

            {/* Modal body */}
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px" }}>

              {/* NODES TABLE */}
              {setupTab === "nodes" && (
                <div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                        {["Node", "Initial Propensity (0–1)", ""].map(h => (
                          <th key={h} style={{ ...mono, fontSize: 9, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.1em", padding: "0 8px 10px", textAlign: h === "Node" ? "center" : "left" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {setupNodes.map((n, i) => {
                        const propHue = 210 - n.propensity * 80;
                        return (
                          <tr key={i} className="setup-row" style={{ borderBottom: `1px solid ${C.border}` }}>
                            <td style={{ padding: "8px", textAlign: "center", width: 50 }}>
                              <div style={{ width: 26, height: 26, borderRadius: "50%", background: `hsl(${propHue},65%,65%)`, display: "flex", alignItems: "center", justifyContent: "center", ...mono, fontSize: 11, fontWeight: 700, color: "white", margin: "0 auto" }}>{i}</div>
                            </td>
                            <td className="setup-cell" style={{ padding: "8px 6px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <input type="number" min={0.01} max={0.99} step={0.01}
                                  value={n.propensity}
                                  onChange={e => handleSetupNodeField(i, "propensity", Math.min(0.99, Math.max(0.01, Number(e.target.value))))}
                                  style={{ width: 72 }} />
                                {/* Inline visual bar */}
                                <div style={{ flex: 1, height: 8, background: "#f1f5f9", borderRadius: 99, overflow: "hidden", position: "relative" }}>
                                  <div style={{ height: "100%", width: `${n.propensity * 100}%`, background: `hsl(${propHue},65%,65%)`, borderRadius: 99 }} />
                                </div>
                                <span style={{ ...mono, fontSize: 10, color: "#64748b", minWidth: 36 }}>{(n.propensity * 100).toFixed(0)}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginTop: 12, lineHeight: 1.6 }}>
                    Propensity = probability of voting each day (if draw &lt; p → vote). Higher = more likely to vote early.
                  </div>
                </div>
              )}

              {/* EDGES TABLE */}
              {setupTab === "edges" && (
                <div>
                  {/* Add edge row */}
                  <div style={{ background: "#f0fdf4", border: "1.5px solid #bbf7d0", borderRadius: 8, padding: "12px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ ...mono, fontSize: 10, color: "#166534", fontWeight: 700 }}>ADD</span>
                    <select value={setupFrom} onChange={e => setSetupFrom(Number(e.target.value))}
                      style={{ ...mono, fontSize: 11, fontWeight: 600, background: "white", border: "1.5px solid #bbf7d0", borderRadius: 5, padding: "5px 8px", color: C.text, outline: "none" }}>
                      {setupNodes.map((_, i) => <option key={i} value={i}>Node {i}</option>)}
                    </select>
                    <span style={{ ...mono, fontSize: 12, color: "#94a3b8" }}>↔</span>
                    <select value={setupTo} onChange={e => setSetupTo(Number(e.target.value))}
                      style={{ ...mono, fontSize: 11, fontWeight: 600, background: "white", border: "1.5px solid #bbf7d0", borderRadius: 5, padding: "5px 8px", color: C.text, outline: "none" }}>
                      {setupNodes.map((_, i) => <option key={i} value={i}>Node {i}</option>)}
                    </select>
                    <button className="btn btn-green" onClick={() => addSetupEdge(setupFrom, setupTo)}
                      disabled={setupFrom === setupTo || setupEdges.some(e => e.from === Math.min(setupFrom, setupTo) && e.to === Math.max(setupFrom, setupTo))}
                      style={{ flexShrink: 0 }}>
                      {setupFrom === setupTo ? "pick two nodes"
                        : setupEdges.some(e => e.from === Math.min(setupFrom, setupTo) && e.to === Math.max(setupFrom, setupTo)) ? "already exists"
                        : `+ connect ${setupFrom} ↔ ${setupTo}`}
                    </button>
                  </div>

                  {setupEdges.length === 0 ? (
                    <div style={{ ...mono, fontSize: 11, color: "#94a3b8", textAlign: "center", padding: "30px 0" }}>No edges yet — add some above.</div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                          {["From → To", "Weight →", "Weight ←", ""].map(h => (
                            <th key={h} style={{ ...mono, fontSize: 9, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.1em", padding: "0 8px 10px", textAlign: "left" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {setupEdges.map((e, idx) => (
                          <tr key={idx} className="setup-row" style={{ borderBottom: `1px solid ${C.border}` }}>
                            <td style={{ padding: "8px", ...mono, fontSize: 12, fontWeight: 700 }}>
                              <span style={{ background: "#dbeafe", color: C.blue, padding: "2px 7px", borderRadius: 4 }}>{e.from}</span>
                              <span style={{ color: "#94a3b8", margin: "0 5px" }}>↔</span>
                              <span style={{ background: "#dbeafe", color: C.blue, padding: "2px 7px", borderRadius: 4 }}>{e.to}</span>
                            </td>
                            <td className="setup-cell" style={{ padding: "8px 6px", width: 110 }}>
                              <input type="number" min={0} max={0.6} step={0.01} value={e.wFT}
                                onChange={ev => handleSetupEdgeField(idx, "wFT", Math.min(0.6, Math.max(0, Number(ev.target.value))))} />
                            </td>
                            <td className="setup-cell" style={{ padding: "8px 6px", width: 110 }}>
                              <input type="number" min={0} max={0.6} step={0.01} value={e.wTF}
                                onChange={ev => handleSetupEdgeField(idx, "wTF", Math.min(0.6, Math.max(0, Number(ev.target.value))))} />
                            </td>
                            <td style={{ padding: "8px", textAlign: "right" }}>
                              <button onClick={() => removeSetupEdge(idx)}
                                style={{ ...mono, fontSize: 14, background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", lineHeight: 1 }}>×</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div style={{ ...mono, fontSize: 9, color: "#94a3b8", marginTop: 12, lineHeight: 1.6 }}>
                    Weight → = how much node A's vote boosts node B's propensity (next day). Range 0–0.60.
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div style={{ padding: "14px 22px", borderTop: `1.5px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8, background: "#fafafa" }}>
              {simResult && (
                <button className="btn btn-ghost" onClick={() => setShowSetup(false)}>Cancel</button>
              )}
              <button className="btn btn-blue" style={{ padding: "8px 24px", fontSize: 12 }}
                onClick={() => launchSim(setupNodes, setupEdges, globalConfig)}>
                ▶ Run Simulation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <header style={{ background: C.white, borderBottom: `1.5px solid ${C.border}`, padding: "10px 18px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>Network Voting Simulator</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {showCf && cfResult && <span style={{ ...mono, background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d", padding: "2px 8px", borderRadius: 99, fontSize: 9 }}>★ CF</span>}
          {activeResult && (
            <div style={{ padding: "5px 12px", borderRadius: 7, background: passed ? "#dcfce7" : "#fee2e2", border: `1.5px solid ${passed ? "#86efac" : "#fca5a5"}` }}>
              <div style={{ ...mono, fontSize: 10, fontWeight: 700, color: passed ? "#166534" : "#991b1b" }}>
                {passed ? `✓ PASSED · day ${passedDay}` : "✗ FAILED"}
              </div>
            </div>
          )}
          <button className="btn btn-blue" onClick={() => reRunSim()}>▶ Run again</button>
          <button className="btn btn-ghost" onClick={fullRebuild}>⚙ Setup</button>
          <button className="btn btn-green" onClick={exportCSV}>↓ CSV log</button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ══ LEFT PANEL ══ */}
        <aside style={{ width: 250, background: C.white, borderRight: `1.5px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
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
            {[["nodes", "Nodes"], ["edges", "Edges"], ["log", "Draw Log"], ["cf", "CF"]].map(([id, lbl]) => (
              <button key={id} className={`tab ${panel === id ? "on" : ""}`} onClick={() => setPanel(id)}>
                {lbl}
                {id === "nodes" && selectedNode !== null && <span style={{ marginLeft: 3, background: C.blue, color: "white", borderRadius: 99, padding: "0 4px", fontSize: 8 }}>{selectedNode}</span>}
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
                        <div style={{ width: 24, height: 24, borderRadius: "50%", background: ds?.voted ? C.coral : `hsl(${propHue},65%,65%)`, border: `2px solid ${isSel ? C.blue : C.border}`, display: "flex", alignItems: "center", justifyContent: "center", ...mono, fontSize: 10, fontWeight: 700, color: "white", flexShrink: 0 }}>{i}</div>
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
                          <NumSlider label="initial propensity" value={np.propensity} min={0.01} max={0.99} step={0.01} color="#f59e0b"
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
                      {nodeParams.map((_, i) => <option key={i} value={i}>Node {i}</option>)}
                    </select>
                    <span style={{ ...mono, fontSize: 11, color: "#94a3b8" }}>↔</span>
                    <select value={addEdgeTo} onChange={e => setAddEdgeTo(Number(e.target.value))}
                      style={{ flex: 1, ...mono, fontSize: 11, fontWeight: 600, background: "white", border: "1.5px solid #bbf7d0", borderRadius: 5, padding: "5px 7px", color: C.text, outline: "none" }}>
                      {nodeParams.map((_, i) => <option key={i} value={i}>Node {i}</option>)}
                    </select>
                  </div>
                  <button className="btn btn-green" style={{ width: "100%", fontSize: 11 }}
                    onClick={addEdge}
                    disabled={addEdgeFrom === addEdgeTo || edges.some(e => e.from === Math.min(addEdgeFrom, addEdgeTo) && e.to === Math.max(addEdgeFrom, addEdgeTo))}>
                    {addEdgeFrom === addEdgeTo ? "select two different nodes"
                      : edges.some(e => e.from === Math.min(addEdgeFrom, addEdgeTo) && e.to === Math.max(addEdgeFrom, addEdgeTo)) ? "already connected"
                      : `+ connect ${addEdgeFrom} ↔ ${addEdgeTo}`}
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
                          <div style={{ width: 20, height: 20, borderRadius: "50%", background: fromVoted ? C.coral : "#bfdbfe", display: "flex", alignItems: "center", justifyContent: "center", ...mono, fontSize: 9, fontWeight: 700, color: fromVoted ? "white" : C.blue, border: `1.5px solid ${fromVoted ? "#b83222" : "#93c5fd"}` }}>{e.from}</div>
                          <span style={{ ...mono, fontSize: 10, color: "#94a3b8" }}>↔</span>
                          <div style={{ width: 20, height: 20, borderRadius: "50%", background: toVoted ? C.coral : "#bfdbfe", display: "flex", alignItems: "center", justifyContent: "center", ...mono, fontSize: 9, fontWeight: 700, color: toVoted ? "white" : C.blue, border: `1.5px solid ${toVoted ? "#b83222" : "#93c5fd"}` }}>{e.to}</div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ ...mono, fontSize: 9, color: "#94a3b8" }}>
                            {e.from}→{e.to}: <strong style={{ color: C.blue }}>{e.wFT.toFixed(2)}</strong>
                            {" · "}
                            {e.to}→{e.from}: <strong style={{ color: C.coral }}>{e.wTF.toFixed(2)}</strong>
                          </div>
                        </div>
                        <button onClick={ev => { ev.stopPropagation(); removeEdge(idx); }}
                          style={{ ...mono, fontSize: 12, background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                          title="remove edge">×</button>
                      </div>

                      {isSelEdge && (
                        <div onClick={ev => ev.stopPropagation()}>
                          <div style={{ background: "#eff6ff", borderRadius: 7, padding: "9px 10px", marginBottom: 8 }}>
                            <div style={{ ...mono, fontSize: 9, color: C.blue, fontWeight: 700, marginBottom: 6 }}>
                              {e.from} → {e.to}
                            </div>
                            <NumSlider label={`weight`} value={e.wFT} min={0} max={0.60} step={0.01} color={C.blue}
                              onChange={v => { setDraggingEdgeIdx(idx); updateEdge(idx, "wFT", v); }}
                              onMouseUp={() => setDraggingEdgeIdx(null)}
                              onTouchEnd={() => setDraggingEdgeIdx(null)} />
                            <PropBar value={e.wFT} max={0.6} color={C.blue} h={5} />
                          </div>

                          <div style={{ background: "#fff5f5", borderRadius: 7, padding: "9px 10px" }}>
                            <div style={{ ...mono, fontSize: 9, color: C.coral, fontWeight: 700, marginBottom: 6 }}>
                              {e.to} → {e.from}
                            </div>
                            <NumSlider label={`weight`} value={e.wTF} min={0} max={0.60} step={0.01} color={C.coral}
                              onChange={v => { setDraggingEdgeIdx(idx); updateEdge(idx, "wTF", v); }}
                              onMouseUp={() => setDraggingEdgeIdx(null)}
                              onTouchEnd={() => setDraggingEdgeIdx(null)} />
                            <PropBar value={e.wTF} max={0.6} color={C.coral} h={5} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── DRAW LOG PANEL ── */}
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
                        <span style={{ ...mono, fontSize: 10, fontWeight: 700, color: C.text }}>Node {i}</span>
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
                            <div key={d} style={{ display: "grid", gridTemplateColumns: "26px 1fr 44px 44px 54px", gap: "0 5px", padding: "5px 10px", alignItems: "center", background: isCurrDay ? "#dbeafe20" : didVote ? "#fee2e225" : "transparent", borderBottom: "1px solid #f8fafc" }}>
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
                                  <div style={{ ...mono, fontSize: 7, color: "#16a34a", marginTop: 1 }}>
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
                        <Card key={lbl} style={{ padding: "9px 11px", border: `1.5px solid ${r.passed ? "#86efac" : "#fca5a5"}`, background: r.passed ? "#f0fdf4" : "#fff5f5" }}>
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
          </div>

          {/* Graph */}
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            {displayState && positions.length > 0 && (
              <NetworkGraph
                positions={positions} edges={edges} state={displayState}
                selectedNode={selectedNode} onSelectNode={handleSelectNode}
                onSelectEdge={ei => setSelectedEdgeIdx(ei === selectedEdgeIdx ? null : ei)}
                cfNode={showCf ? cfNode : null}
                showWeights={showWeights}
                hoveredKey={hovKey}
                highlightEdgeIdx={draggingEdgeIdx ?? expandedEdgeIdx ?? selectedEdgeIdx}
                onHoverEdge={handleHoverEdge}
              />
            )}
            {hovInfo && (
              <div style={{ position: "absolute", bottom: 44, left: "50%", transform: "translateX(-50%)", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "6px 14px", ...mono, fontSize: 11, boxShadow: "0 2px 10px #0000001a", pointerEvents: "none", whiteSpace: "nowrap" }}>
                <strong style={{ color: C.blue }}>Node {hovInfo.from}</strong>
                <span style={{ color: "#94a3b8", margin: "0 6px" }}>→</span>
                <strong style={{ color: C.blue }}>Node {hovInfo.to}</strong>
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

        {/* ══ RIGHT PANEL — Stats ══ */}
        <aside style={{ width: 240, background: C.white, borderLeft: `1.5px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
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
                    <span style={{ ...mono, fontSize: 9, color: "#94a3b8", minWidth: 16 }}>#{s.i}</span>
                    <div style={{ flex: 1, position: "relative", height: 6, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${s.propensity * 100}%`, background: s.voted ? C.coral : `hsl(${hue},65%,58%)`, borderRadius: 99 }} />
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
                    <rect x={0} y={thY} width={W} height={H - thY} fill="#e85d4208" />
                    <line x1={0} y1={thY} x2={W} y2={thY} stroke="#e85d42" strokeWidth="1" strokeDasharray="4 3" opacity={0.4} />
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
                {[["#2563eb", "baseline"], ...(cfResult ? [["#f59e0b", "cf"]] : []), ["#e85d42", "threshold"]].map(([col, lbl]) => (
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
                <SH>NODE {selectedNode} DETAIL</SH>
                <Card style={{ padding: "9px 11px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                    {[["init p", selNodeParams.propensity.toFixed(2), "#f59e0b"], ["curr p", selNodeData.propensity.toFixed(2), C.blue], ["edges", connectedEdges.length, "#16a34a"]].map(([k, v, c]) => (
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
    </div>
  );
}
