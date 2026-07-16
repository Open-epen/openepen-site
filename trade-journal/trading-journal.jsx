import React, { useState, useEffect, useMemo } from "react";

// ---------- constants ----------
const RULES = [
  { id: "noAdd",        label: "Never added to a losing position" },
  { id: "maxLoss",      label: "Stopped at daily max loss (or never hit it)" },
  { id: "noPnlTrading", label: "Didn't trade my P&L" },
  { id: "cutFast",      label: "Cut losses fast — no hoping" },
  { id: "twoArrow",     label: "2-arrow rule: max 2 failed attempts per ticker" },
  { id: "secondCandle", label: "Waited for pullback / 2nd-candle close on entries" },
  { id: "rossMuted",    label: "Ross muted during execution" },
  { id: "quitDone",     label: 'Said "I\'m done" and actually logged off' },
];

const SETUPS   = ["Stair-Step Pullback", "Rhythm Rotation (dip-then-rip)", "Other / unnamed"];
const ACCOUNTS = ["Real (Webull)", "Real + Sim", "Sim @ 25 shares", "Sim (other)"];
const SIM_ONLY = new Set(["Sim @ 25 shares", "Sim (other)"]);

const KEY = "kelly-trading-journal-v2";

const todayStr = () => new Date().toISOString().slice(0, 10);

function weekOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const dow = (d.getDay() + 6) % 7; // Mon = 0
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

function blankEntry(date) {
  return {
    date,
    account: ACCOUNTS[0],
    rested: true,
    tiredRuleHonored: true,
    planWritten: false,
    setups: [],
    trades: 0,
    pnlReal: "",
    pnlSim: "",
    rules: Object.fromEntries(RULES.map((r) => [r.id, true])),
    positionError: false,
    entertainmentMode: false,
    bestTrade: "",
    fixTomorrow: "",
  };
}

function scoreEntry(e) {
  const ruleVals  = RULES.map((r) => (e.rules?.[r.id] ? 1 : 0));
  const rulePct   = ruleVals.reduce((a, b) => a + b, 0) / RULES.length;
  const tradeDisc = e.trades <= 8 ? 1 : e.trades <= 14 ? 0.5 : 0;
  const fatigue   = e.tiredRuleHonored ? 1 : 0;
  const plan      = e.planWritten ? 1 : 0;
  let s = rulePct * 60 + tradeDisc * 15 + fatigue * 10 + plan * 15;
  if (e.entertainmentMode) s = Math.min(s, 49);
  return Math.round(s);
}

const grade      = (s) => (s >= 90 ? "A" : s >= 80 ? "B" : s >= 70 ? "C" : s >= 55 ? "D" : "F");
const gradeColor = (s) => (s >= 90 ? "#3fce8b" : s >= 70 ? "#e8b04a" : "#ef5b6e");

// ---------- palette ----------
const C = {
  bg:     "#0d1117",
  panel:  "#161c26",
  panel2: "#1c2432",
  line:   "#2a3446",
  text:   "#dbe4f0",
  dim:    "#7d8ba1",
  green:  "#3fce8b",
  red:    "#ef5b6e",
  amber:  "#e8b04a",
  blue:   "#5aa2e8",
};
const mono = "'SF Mono', 'Cascadia Code', Consolas, monospace";

// ============================================================
// Helper components — defined OUTSIDE ProcessLog so React
// keeps the same component type across re-renders and inputs
// never lose focus.
// ============================================================

function Toggle({ on, set, yes = "Yes", no = "No", invertColor = false }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {[[true, yes], [false, no]].map(([v, lbl]) => {
        const active = on === v;
        const good   = invertColor ? !v : v;
        return (
          <button
            key={lbl}
            onClick={() => set(v)}
            style={{
              padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
              fontFamily: mono,
              border: `1px solid ${active ? (good ? C.green : C.red) : C.line}`,
              background: active ? (good ? "rgba(63,206,139,.12)" : "rgba(239,91,110,.12)") : "transparent",
              color: active ? (good ? C.green : C.red) : C.dim,
            }}
          >
            {lbl}
          </button>
        );
      })}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      gap: 14, padding: "8px 0", borderBottom: `1px solid ${C.line}22`, flexWrap: "wrap",
    }}>
      <div style={{ fontSize: 13.5, maxWidth: 480 }}>{label}</div>
      {children}
    </div>
  );
}

function Section({ title, children, accent }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.line}`,
      borderRadius: 10, padding: "16px 18px", marginBottom: 14,
    }}>
      <div style={{
        fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase",
        color: accent || C.dim, fontFamily: mono, marginBottom: 12,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, val, good, bad }) {
  return (
    <div style={{ background: C.panel2, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, color: C.dim, fontFamily: mono, textTransform: "uppercase", letterSpacing: ".08em" }}>
        {label}
      </div>
      <div style={{
        fontSize: 17, fontWeight: 700, fontFamily: mono,
        color: good ? C.green : bad ? C.red : C.text, marginTop: 3,
      }}>
        {val}
      </div>
    </div>
  );
}

function GateItem({ label, progress, target, detail }) {
  const done = progress >= target;
  return (
    <div style={{
      background: C.panel, border: `1px solid ${done ? C.green : C.line}`,
      borderRadius: 10, padding: "14px 18px", marginBottom: 10,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13.5 }}>{label}</div>
        <div style={{ fontFamily: mono, fontWeight: 700, color: done ? C.green : C.amber }}>
          {Math.min(progress, target)}/{target}
        </div>
      </div>
      <div style={{ height: 6, background: C.panel2, borderRadius: 3, marginTop: 10 }}>
        <div style={{
          height: 6,
          width: `${Math.min(100, (progress / target) * 100)}%`,
          background: done ? C.green : C.amber,
          borderRadius: 3,
          transition: "width .3s",
        }} />
      </div>
      {detail && <div style={{ fontSize: 12, color: C.dim, marginTop: 6, fontFamily: mono }}>{detail}</div>}
    </div>
  );
}

function Empty({ text }) {
  return (
    <div style={{ color: C.dim, textAlign: "center", padding: "40px 0", fontSize: 14 }}>{text}</div>
  );
}

// ---------- calendar helpers ----------
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function prevMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
function nextMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
}

function CalendarGrid({ entries, month, onSelectDate }) {
  const today       = todayStr();
  const [y, mon]    = month.split("-").map(Number);
  const daysInMonth = new Date(y, mon, 0).getDate();
  const startDow    = (new Date(y, mon - 1, 1).getDay() + 6) % 7; // Mon=0

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${month}-${String(d).padStart(2, "0")}`;
    const entry   = entries[dateStr];
    const s       = entry ? scoreEntry(entry) : null;
    cells.push({ day: d, dateStr, entry, score: s });
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 4 }}>
        {DOW_LABELS.map((d) => (
          <div key={d} style={{ textAlign: "center", fontSize: 11, color: C.dim, fontFamily: mono, paddingBottom: 4 }}>
            {d}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
        {cells.map((cell, i) => {
          if (!cell) return <div key={`pad-${i}`} />;
          const { day, dateStr, entry, score } = cell;
          const isToday   = dateStr === today;
          const dotColor  = score !== null ? gradeColor(score) : null;
          const bgAlpha   = entry
            ? (score >= 90 ? "rgba(63,206,139,.16)" : score >= 70 ? "rgba(232,176,74,.16)" : "rgba(239,91,110,.16)")
            : C.panel2;
          return (
            <div
              key={dateStr}
              onClick={() => onSelectDate(dateStr)}
              style={{
                background: bgAlpha,
                border: isToday
                  ? `2px solid ${C.blue}`
                  : entry
                    ? `1px solid ${dotColor}66`
                    : `1px solid ${C.line}`,
                borderRadius: 8,
                padding: "7px 4px 5px",
                textAlign: "center",
                cursor: "pointer",
                minHeight: 50,
                userSelect: "none",
                transition: "opacity .15s",
              }}
            >
              <div style={{
                fontSize: 13, fontFamily: mono,
                color: isToday ? C.blue : entry ? C.text : C.dim,
                fontWeight: isToday ? 700 : 400,
              }}>
                {day}
              </div>
              {entry && (
                <div style={{ fontSize: 11, fontFamily: mono, fontWeight: 700, color: dotColor, marginTop: 2 }}>
                  {grade(score)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 16, flexWrap: "wrap" }}>
        {[["A (90+)", C.green], ["B/C (70–89)", C.amber], ["D/F (<70)", C.red]].map(([lbl, col]) => (
          <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: C.dim, fontFamily: mono }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: col, opacity: 0.7 }} />
            {lbl}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Shared input styles (not components — style objects are fine
// inside the component without causing unmount issues)
// ============================================================
const numStyle = {
  width: 110, background: "#1c2432", border: "1px solid #2a3446", color: "#dbe4f0",
  padding: "7px 10px", borderRadius: 6, fontFamily: "'SF Mono', Consolas, monospace",
  fontSize: 14, textAlign: "right",
};
const taStyle = {
  width: "100%", boxSizing: "border-box", background: "#1c2432", border: "1px solid #2a3446",
  color: "#dbe4f0", padding: "10px 12px", borderRadius: 8, fontSize: 13.5, minHeight: 54,
  fontFamily: "'Segoe UI', system-ui, sans-serif", resize: "vertical",
};

// ============================================================
// Main component
// ============================================================
export default function ProcessLog() {
  const [entries,     setEntries]     = useState({});
  const [loaded,      setLoaded]      = useState(false);
  const [tab,         setTab]         = useState("today");
  const [date,        setDate]        = useState(todayStr());
  const [draft,       setDraft]       = useState(() => blankEntry(todayStr()));
  const [savedFlash,  setSavedFlash]  = useState(false);
  const [calMonth,    setCalMonth]    = useState(() => todayStr().slice(0, 7));
  const [filterFrom,  setFilterFrom]  = useState("");
  const [filterTo,    setFilterTo]    = useState("");

  // ---------- load ----------
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        setEntries(JSON.parse(raw));
      } else {
        try {
          const oldRaw = localStorage.getItem("kelly-trading-journal-v1");
          if (oldRaw) {
            const migrated = {};
            for (const [d, e] of Object.entries(JSON.parse(oldRaw))) {
              const m = { ...blankEntry(d), ...e };
              if (e.rules?.flatCheck === false) m.positionError = true;
              m.rules = Object.fromEntries(
                RULES.map((r2) => [r2.id, e.rules?.[r2.id] !== undefined ? e.rules[r2.id] : true])
              );
              migrated[d] = m;
            }
            setEntries(migrated);
            localStorage.setItem(KEY, JSON.stringify(migrated));
          }
        } catch (_) {}
      }
    } catch (_) {}
    setLoaded(true);
  }, []);

  useEffect(() => {
    setDraft(entries[date] ? { ...blankEntry(date), ...entries[date] } : blankEntry(date));
  }, [date, loaded]); // eslint-disable-line

  // ---------- save / delete ----------
  const save = () => {
    const next = { ...entries, [date]: draft };
    setEntries(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (_) {
      alert("Save failed — try again.");
    }
  };

  const removeEntry = () => {
    const next = { ...entries };
    delete next[date];
    setEntries(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) {}
    setDraft(blankEntry(date));
  };

  // ---------- derived data ----------
  const sorted = useMemo(
    () => Object.values(entries).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [entries]
  );

  const filteredEntries = useMemo(() => sorted.filter((e) => {
    if (filterFrom && e.date < filterFrom) return false;
    if (filterTo   && e.date > filterTo)   return false;
    return true;
  }), [sorted, filterFrom, filterTo]);

  const weeks = useMemo(() => {
    const map = {};
    for (const e of Object.values(entries)) {
      const wk = weekOf(e.date);
      (map[wk] = map[wk] || []).push(e);
    }
    return Object.entries(map)
      .map(([wk, list]) => {
        const days   = list.length;
        const scores = list.map(scoreEntry);
        const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / days);
        const compliantDays = list.filter((e) => RULES.every((r) => e.rules?.[r.id])).length;
        const posErrors     = list.filter((e) => e.positionError).length;

        // Sim-only accounts: pnlReal entered by user counts as sim, not real
        const realPnl = list.reduce((a, e) =>
          a + (SIM_ONLY.has(e.account) ? 0 : (parseFloat(e.pnlReal) || 0)), 0);
        const simPnl  = list.reduce((a, e) => {
          const baseSim = parseFloat(e.pnlSim) || 0;
          const simReal = SIM_ONLY.has(e.account) ? (parseFloat(e.pnlReal) || 0) : 0;
          return a + baseSim + simReal;
        }, 0);

        const avgTrades = (list.reduce((a, e) => a + (Number(e.trades) || 0), 0) / days).toFixed(1);
        const realGreen = realPnl > 0;
        const sim25Days = list.filter((e) => e.account === "Sim @ 25 shares");
        const sim25Clean =
          sim25Days.length > 0 &&
          sim25Days.every((e) => RULES.every((r) => e.rules?.[r.id]) && !e.positionError);
        return {
          wk, days, avgScore, compliantDays, posErrors, realPnl, simPnl,
          avgTrades, realGreen, sim25Clean, hasSim25: sim25Days.length > 0,
        };
      })
      .sort((a, b) => (a.wk < b.wk ? 1 : -1));
  }, [entries]);

  const currentWeek = useMemo(() => {
    const wk = weekOf(todayStr());
    return weeks.find((w) => w.wk === wk) || null;
  }, [weeks]);

  const gate = useMemo(() => {
    const chron = [...weeks].sort((a, b) => (a.wk > b.wk ? 1 : -1));
    let streakGreen = 0;
    for (let i = chron.length - 1; i >= 0; i--) {
      if (chron[i].realGreen && chron[i].posErrors === 0) streakGreen++;
      else break;
    }
    let sim25Streak = 0;
    for (let i = chron.length - 1; i >= 0; i--) {
      if (!chron[i].hasSim25) continue;
      if (chron[i].sim25Clean) sim25Streak++;
      else break;
    }
    const totalPosErrors30 = chron.slice(-4).reduce((a, w) => a + w.posErrors, 0);
    return { streakGreen, sim25Streak, totalPosErrors30 };
  }, [weeks]);

  const s          = scoreEntry(draft);
  const scoreColor = gradeColor(s);

  const dateInputStyle = {
    background: C.panel2, border: `1px solid ${C.line}`, color: C.text,
    padding: "7px 10px", borderRadius: 8, fontFamily: mono, fontSize: 13, colorScheme: "dark",
  };

  const navToDate = (d) => { setDate(d); setTab("today"); };

  const tabs = [
    ["today",     "Daily Log"],
    ["scorecard", "Weekly Scorecard"],
    ["gate",      "Size-Up Gate"],
    ["history",   "History"],
  ];

  // ---------- render ----------
  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.text,
      fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "0 0 60px",
    }}>
      {/* header */}
      <div style={{ borderBottom: `1px solid ${C.line}`, padding: "20px 24px 0", background: C.panel }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
              Kelly's Trading Business{" "}
              <span style={{ color: C.dim, fontWeight: 400, fontSize: 14 }}>— process over P&L</span>
            </h1>
            <div style={{ fontFamily: mono, fontSize: 12, color: C.dim }}>Proof phase · 10 shares real</div>
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 14 }}>
            {tabs.map(([id, lbl]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                style={{
                  padding: "9px 16px", border: "none", cursor: "pointer", fontSize: 13.5,
                  background: tab === id ? C.bg : "transparent",
                  color:      tab === id ? C.text : C.dim,
                  borderRadius: "8px 8px 0 0",
                  borderBottom: tab === id ? `2px solid ${C.blue}` : "2px solid transparent",
                  fontWeight:  tab === id ? 600 : 400,
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 860, margin: "22px auto 0", padding: "0 24px" }}>

        {/* ============ DAILY LOG ============ */}
        {tab === "today" && (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={dateInputStyle}
              />
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>Process score</span>
                <span style={{ fontFamily: mono, fontSize: 26, fontWeight: 700, color: scoreColor }}>
                  {s} <span style={{ fontSize: 15 }}>({grade(s)})</span>
                </span>
              </div>
            </div>

            <Section title="Before the open">
              <Row label="Slept well & actually want to be here?">
                <Toggle
                  on={draft.rested}
                  set={(v) => setDraft((d) => ({ ...d, rested: v }))}
                  yes="Rested" no="Tired"
                />
              </Row>
              {!draft.rested && (
                <Row label="Tired rule honored? (watch-only or 1 share max)">
                  <Toggle
                    on={draft.tiredRuleHonored}
                    set={(v) => setDraft((d) => ({ ...d, tiredRuleHonored: v }))}
                  />
                </Row>
              )}
              <Row label="Written plan before the open (tickers, entries, stops)?">
                <Toggle
                  on={draft.planWritten}
                  set={(v) => setDraft((d) => ({ ...d, planWritten: v }))}
                />
              </Row>
              <Row label="Account traded today">
                <select
                  value={draft.account}
                  onChange={(e) => setDraft((d) => ({ ...d, account: e.target.value }))}
                  style={{
                    background: C.panel2, border: `1px solid ${C.line}`, color: C.text,
                    padding: "7px 10px", borderRadius: 6, fontSize: 13,
                  }}
                >
                  {ACCOUNTS.map((a) => <option key={a}>{a}</option>)}
                </select>
              </Row>
            </Section>

            <Section title="Rule compliance" accent={C.blue}>
              {RULES.map((r) => (
                <Row key={r.id} label={r.label}>
                  <Toggle
                    on={draft.rules[r.id]}
                    set={(v) => setDraft((d) => ({ ...d, rules: { ...d.rules, [r.id]: v } }))}
                    yes="Kept" no="Broke"
                  />
                </Row>
              ))}
              <Row label={<span style={{ color: C.red }}>Did entertainment mode take over? (trading for fun past limits)</span>}>
                <Toggle
                  on={draft.entertainmentMode}
                  set={(v) => setDraft((d) => ({ ...d, entertainmentMode: v }))}
                  yes="Yes" no="No" invertColor
                />
              </Row>
            </Section>

            <Section title="The session">
              <Row label="Setups traded (only count YOUR two)">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {SETUPS.map((st) => {
                    const on = draft.setups.includes(st);
                    return (
                      <button
                        key={st}
                        onClick={() => setDraft((d) => ({
                          ...d,
                          setups: on ? d.setups.filter((x) => x !== st) : [...d.setups, st],
                        }))}
                        style={{
                          padding: "5px 12px", borderRadius: 6, fontSize: 12.5, cursor: "pointer",
                          border:      `1px solid ${on ? C.blue : C.line}`,
                          background:  on ? "rgba(90,162,232,.14)" : "transparent",
                          color:       on ? C.blue : C.dim,
                        }}
                      >
                        {st}
                      </button>
                    );
                  })}
                </div>
              </Row>
              <Row label="Total round-trip trades">
                <input
                  type="number" min="0"
                  value={draft.trades}
                  onChange={(e) => setDraft((d) => ({ ...d, trades: Number(e.target.value) }))}
                  style={numStyle}
                />
              </Row>
              <Row label="P&L — real ($)">
                <input
                  type="number" step="0.01"
                  value={draft.pnlReal} placeholder="0.00"
                  onChange={(e) => setDraft((d) => ({ ...d, pnlReal: e.target.value }))}
                  style={numStyle}
                />
              </Row>
              <Row label="P&L — sim ($)">
                <input
                  type="number" step="0.01"
                  value={draft.pnlSim} placeholder="0.00"
                  onChange={(e) => setDraft((d) => ({ ...d, pnlSim: e.target.value }))}
                  style={numStyle}
                />
              </Row>
              <Row label={
                <span>
                  Position-awareness error today?{" "}
                  <span style={{ color: C.dim, fontSize: 12 }}>(didn't know you were in/out — feeds the Size-Up Gate)</span>
                </span>
              }>
                <Toggle
                  on={draft.positionError}
                  set={(v) => setDraft((d) => ({ ...d, positionError: v }))}
                  yes="Yes" no="No" invertColor
                />
              </Row>
            </Section>

            <Section title="Close-out (2 sentences, that's it)">
              <textarea
                value={draft.bestTrade}
                placeholder="One thing I did well today…"
                onChange={(e) => setDraft((d) => ({ ...d, bestTrade: e.target.value }))}
                style={taStyle}
              />
              <textarea
                value={draft.fixTomorrow}
                placeholder="One thing I'll do differently tomorrow…"
                onChange={(e) => setDraft((d) => ({ ...d, fixTomorrow: e.target.value }))}
                style={{ ...taStyle, marginTop: 8 }}
              />
            </Section>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={save}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 8, border: "none", cursor: "pointer",
                  background: savedFlash ? C.green : C.blue, color: "#0d1117", fontWeight: 700, fontSize: 15,
                }}
              >
                {savedFlash ? "Saved ✓" : "Save session"}
              </button>
              {entries[date] && (
                <button
                  onClick={removeEntry}
                  style={{
                    padding: "12px 18px", borderRadius: 8, border: `1px solid ${C.line}`,
                    cursor: "pointer", background: "transparent", color: C.dim, fontSize: 13,
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </>
        )}

        {/* ============ SCORECARD ============ */}
        {tab === "scorecard" && (
          <>
            <p style={{ color: C.dim, fontSize: 13.5, marginTop: 0 }}>
              A week where you made $0.40 with 100% rule compliance beats a week where you made $4 breaking three rules.
              Grades here are process, not dollars.
            </p>
            {weeks.length === 0 && <Empty text="No sessions logged yet. Log a day and the scorecard builds itself." />}
            {weeks.map((w) => (
              <div key={w.wk} style={{
                background: C.panel, border: `1px solid ${C.line}`,
                borderRadius: 10, padding: "14px 18px", marginBottom: 12,
              }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>Week of {w.wk}</div>
                  <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 700, color: gradeColor(w.avgScore) }}>
                    {grade(w.avgScore)}{" "}
                    <span style={{ fontSize: 13, color: C.dim }}>{w.avgScore}/100</span>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginTop: 12 }}>
                  <Stat label="Days logged"          val={w.days} />
                  <Stat label="Fully compliant days" val={`${w.compliantDays}/${w.days}`} good={w.compliantDays === w.days} />
                  <Stat label="Position errors"      val={w.posErrors} good={w.posErrors === 0} bad={w.posErrors > 0} />
                  <Stat label="Avg trades/day"       val={w.avgTrades} />
                  <Stat label="Real P&L"             val={`$${w.realPnl.toFixed(2)}`} good={w.realPnl > 0} bad={w.realPnl < 0} />
                  <Stat label="Sim P&L"              val={`$${w.simPnl.toFixed(2)}`}  good={w.simPnl > 0}  bad={w.simPnl < 0} />
                </div>
              </div>
            ))}
          </>
        )}

        {/* ============ GATE ============ */}
        {tab === "gate" && (
          <>
            <p style={{ color: C.dim, fontSize: 13.5, marginTop: 0 }}>
              Sizing up is earned on schedule, not grabbed on a hot day. The gate from 10 → 25 real shares:
            </p>
            <GateItem
              label="3 consecutive green weeks in real money (with zero position errors)"
              progress={gate.streakGreen} target={3}
            />
            <GateItem
              label="2 clean weeks in the sim at 25 shares (all rules kept, no position errors)"
              progress={gate.sim25Streak} target={2}
            />
            <GateItem
              label="Zero position-awareness errors, last 4 weeks"
              progress={gate.totalPosErrors30 === 0 ? 1 : 0} target={1}
              detail={gate.totalPosErrors30 > 0
                ? `${gate.totalPosErrors30} error(s) on record — clock resets`
                : "Clean"}
            />
            <div style={{
              background: C.panel,
              border: `1px solid ${gate.streakGreen >= 3 && gate.sim25Streak >= 2 && gate.totalPosErrors30 === 0 ? C.green : C.line}`,
              borderRadius: 10, padding: 18, marginTop: 16, textAlign: "center",
            }}>
              {gate.streakGreen >= 3 && gate.sim25Streak >= 2 && gate.totalPosErrors30 === 0 ? (
                <div style={{ color: C.green, fontWeight: 700, fontSize: 16 }}>
                  Gate open — 25 shares real is earned. 🚀
                </div>
              ) : (
                <div style={{ color: C.dim, fontSize: 14 }}>
                  Gate closed. A rule breach resets the current streak by one week.
                </div>
              )}
            </div>
          </>
        )}

        {/* ============ HISTORY ============ */}
        {tab === "history" && (
          <>
            {/* Current week card */}
            <div style={{
              background: C.panel, border: `1px solid ${C.line}`,
              borderRadius: 10, padding: "14px 18px", marginBottom: 16,
            }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
                <span style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: C.dim, fontFamily: mono }}>
                  This week
                </span>
                {currentWeek ? (
                  <span style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: gradeColor(currentWeek.avgScore) }}>
                    {grade(currentWeek.avgScore)}{" "}
                    <span style={{ fontSize: 13, color: C.dim }}>{currentWeek.avgScore}/100</span>
                  </span>
                ) : (
                  <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>No entries yet</span>
                )}
              </div>
              {currentWeek ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
                  <Stat label="Days logged"     val={currentWeek.days} />
                  <Stat label="Compliant days"  val={`${currentWeek.compliantDays}/${currentWeek.days}`} good={currentWeek.compliantDays === currentWeek.days} />
                  <Stat label="Position errors" val={currentWeek.posErrors} good={currentWeek.posErrors === 0} bad={currentWeek.posErrors > 0} />
                  <Stat label="Avg trades/day"  val={currentWeek.avgTrades} />
                  <Stat label="Real P&L"        val={`$${currentWeek.realPnl.toFixed(2)}`} good={currentWeek.realPnl > 0} bad={currentWeek.realPnl < 0} />
                  <Stat label="Sim P&L"         val={`$${currentWeek.simPnl.toFixed(2)}`}  good={currentWeek.simPnl > 0}  bad={currentWeek.simPnl < 0} />
                </div>
              ) : (
                <p style={{ color: C.dim, fontSize: 13, margin: 0 }}>
                  Log your first session this week to see stats here.
                </p>
              )}
            </div>

            {/* Month calendar */}
            <div style={{
              background: C.panel, border: `1px solid ${C.line}`,
              borderRadius: 10, padding: "14px 18px", marginBottom: 16,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <button
                  onClick={() => setCalMonth(prevMonth(calMonth))}
                  style={{
                    background: C.panel2, border: `1px solid ${C.line}`, color: C.text,
                    padding: "6px 16px", borderRadius: 6, cursor: "pointer", fontSize: 18, lineHeight: 1,
                  }}
                >
                  ‹
                </button>
                <span style={{ fontFamily: mono, fontSize: 14, fontWeight: 600 }}>
                  {monthLabel(calMonth)}
                </span>
                <button
                  onClick={() => setCalMonth(nextMonth(calMonth))}
                  style={{
                    background: C.panel2, border: `1px solid ${C.line}`, color: C.text,
                    padding: "6px 16px", borderRadius: 6, cursor: "pointer", fontSize: 18, lineHeight: 1,
                  }}
                >
                  ›
                </button>
              </div>
              <CalendarGrid entries={entries} month={calMonth} onSelectDate={navToDate} />
            </div>

            {/* Date filter + list */}
            <div style={{
              background: C.panel, border: `1px solid ${C.line}`,
              borderRadius: 10, padding: "14px 18px",
            }}>
              <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: C.dim, fontFamily: mono, marginBottom: 10 }}>
                Filter entries
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
                <label style={{ fontSize: 13, color: C.dim }}>From</label>
                <input
                  type="date"
                  value={filterFrom}
                  onChange={(e) => setFilterFrom(e.target.value)}
                  style={dateInputStyle}
                />
                <label style={{ fontSize: 13, color: C.dim }}>To</label>
                <input
                  type="date"
                  value={filterTo}
                  onChange={(e) => setFilterTo(e.target.value)}
                  style={dateInputStyle}
                />
                {(filterFrom || filterTo) && (
                  <button
                    onClick={() => { setFilterFrom(""); setFilterTo(""); }}
                    style={{
                      background: "transparent", border: `1px solid ${C.line}`,
                      color: C.dim, padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12,
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>

              {filteredEntries.length === 0 ? (
                <Empty text={sorted.length === 0 ? "Nothing logged yet." : "No entries match the selected range."} />
              ) : (
                filteredEntries.map((e) => {
                  const es        = scoreEntry(e);
                  const isSimAcct = SIM_ONLY.has(e.account);
                  const displayPnl  = isSimAcct
                    ? (parseFloat(e.pnlReal) || parseFloat(e.pnlSim) || 0)
                    : (parseFloat(e.pnlReal) || 0);
                  const pnlLabel  = isSimAcct ? "sim" : "real";
                  return (
                    <div
                      key={e.date}
                      onClick={() => navToDate(e.date)}
                      style={{
                        border: `1px solid ${C.line}`, borderRadius: 8,
                        padding: "10px 14px", marginBottom: 6, cursor: "pointer",
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        gap: 10, flexWrap: "wrap", background: C.panel2,
                      }}
                    >
                      <div>
                        <span style={{ fontFamily: mono, fontSize: 13 }}>{e.date}</span>
                        <span style={{ color: C.dim, fontSize: 12.5, marginLeft: 10 }}>{e.account}</span>
                        {e.entertainmentMode && (
                          <span style={{ color: C.red, fontSize: 11.5, marginLeft: 10, fontFamily: mono }}>
                            ENTERTAINMENT MODE
                          </span>
                        )}
                        {e.positionError && (
                          <span style={{ color: C.amber, fontSize: 11.5, marginLeft: 10, fontFamily: mono }}>
                            POSITION ERROR
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                        <span style={{ fontFamily: mono, fontSize: 12.5, color: displayPnl >= 0 ? C.green : C.red }}>
                          ${displayPnl.toFixed(2)} {pnlLabel}
                        </span>
                        <span style={{ fontFamily: mono, fontWeight: 700, color: gradeColor(es) }}>
                          {grade(es)}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
