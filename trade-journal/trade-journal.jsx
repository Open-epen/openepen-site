import React, { useState, useMemo, useEffect, useRef } from "react";

// ---------- Constants ----------
const ENTRY_TYPES = ["Breakout", "Pullback", "Reversal", "Gap & Go", "Range", "Other"];
const EMOTIONS = ["Confident", "Calm", "Anxious", "FOMO", "Revenge", "Bored", "Tired"];
const EMOTION_COLOR = {
  Confident: "#3FA66A",
  Calm: "#4C8FAE",
  Anxious: "#D4A017",
  FOMO: "#D4A017",
  Revenge: "#C1502E",
  Bored: "#7A8699",
  Tired: "#7A8699",
};

// Synonym map: canonical field name → list of header strings that mean the same thing.
// Checked case-insensitively with whitespace collapsed. First match wins per field.
const COLUMN_SYNONYMS = {
  date:      ["date", "trade date", "transaction date", "filled time", "execution date"],
  ticker:    ["ticker", "symbol", "name"],
  side:      ["side", "action", "transaction type", "buy/sell"],
  entry:     ["entry", "entry price"],
  exit:      ["exit", "exit price"],
  size:      ["size", "qty", "quantity", "total qty", "shares", "filled qty"],
  price:     ["price", "avg price", "fill price", "execution price"],
  type:      ["type", "setup", "strategy"],
  rules:     ["rulesfollowed", "rules followed", "rules"],
  emotion:   ["emotion"],
  notes:     ["notes", "note", "comments"],
  entryTime: ["entry time", "entrytime", "placed time", "order time"],
  exitTime:  ["exit time", "exittime", "execution time"],
  status:    ["status", "order status", "state"],
};

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function dayOfWeek(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}

function holdMinutes(t) {
  if (!t.entryTime || !t.exitTime) return null;
  const [eh, em] = t.entryTime.split(":").map(Number);
  const [xh, xm] = t.exitTime.split(":").map(Number);
  let mins = (xh * 60 + xm) - (eh * 60 + em);
  if (mins < 0) mins += 24 * 60; // overnight edge case, unlikely for day trades
  return mins;
}

function fmtDuration(mins) {
  if (mins === null || mins === undefined) return "—";
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

// Exit efficiency: how much of the favorable move (entry to MFE) was actually captured at exit.
function exitEfficiency(t) {
  if (t.mfe === undefined || t.mfe === null || t.mfe === "" ) return null;
  const dir = t.side === "short" ? -1 : 1;
  const favorableMove = (t.mfe - t.entry) * dir;
  const capturedMove = (t.exit - t.entry) * dir;
  if (favorableMove <= 0) return null;
  return Math.max(0, Math.min(100, (capturedMove / favorableMove) * 100));
}

// Parse one CSV line, respecting double-quoted fields with embedded commas.
function parseCSVRow(line) {
  const cols = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) { cols.push(cur); cur = ""; }
    else { cur += ch; }
  }
  cols.push(cur);
  return cols;
}

// Map normalized headers to field names using COLUMN_SYNONYMS.
// Returns { fieldName: columnIndex } — fields with no match are absent from the result.
function matchColumns(normalizedHeaders) {
  const map = {};
  for (const [field, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    for (const syn of synonyms) {
      const idx = normalizedHeaders.indexOf(syn);
      if (idx !== -1) { map[field] = idx; break; }
    }
  }
  return map;
}

// Parse broker datetime strings into a sortable key + split date/time.
// Handles "MM/DD/YYYY HH:MM:SS" (Webull), "YYYY-MM-DD HH:MM", ISO, and date-only.
function parseFillDatetime(str) {
  if (!str) return null;
  // MM/DD/YYYY HH:MM[:SS]
  const m1 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m1) {
    const [, mm, dd, yyyy, hh, min] = m1;
    const date = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    const time = `${hh.padStart(2, "0")}:${min}`;
    return { sortKey: `${date}T${time}`, date, time };
  }
  // YYYY-MM-DD[ HH:MM] or YYYY-MM-DDTHH:MM
  const m2 = str.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (m2) {
    return {
      sortKey: m2[1] + (m2[2] ? `T${m2[2]}` : "T00:00"),
      date: m2[1],
      time: m2[2] ?? "",
    };
  }
  return null;
}

// Process fill-level CSVs: accumulate a running position per ticker, emit one
// completed trade each time the position returns to exactly zero.
// Returns { trades, openPositions } on success, or { ambiguous, reason } / { error } on failure.
function importFillCSV(lines, colMap) {
  const getCell = (row, field) =>
    colMap[field] !== undefined ? row[colMap[field]]?.trim() ?? "" : "";

  // ── Parse all fill rows ───────────────────────────────────────────────────
  const fills = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCSVRow(lines[i]);
    const g = (f) => getCell(c, f);

    if ("status" in colMap && g("status").toLowerCase() !== "filled") continue;

    const ticker = g("ticker").toUpperCase();
    const action = g("side").toLowerCase();    // "buy" | "sell"
    const qty    = parseFloat(g("size"));
    const price  = parseFloat(g("price"));
    const rawDt  = g("date");                  // datetime string from broker

    if (!ticker || !["buy", "sell"].includes(action) || !(qty > 0) || !(price > 0)) continue;

    fills.push({ ticker, action, qty, price, rawDt, dt: parseFillDatetime(rawDt), line: i + 1 });
  }

  if (!fills.length) return { error: "No valid fill rows found after filtering." };

  // ── Group by ticker ───────────────────────────────────────────────────────
  const byTicker = {};
  for (const fill of fills) {
    if (!byTicker[fill.ticker]) byTicker[fill.ticker] = [];
    byTicker[fill.ticker].push(fill);
  }

  const completedTrades = [];
  const openPositions   = [];

  for (const [ticker, tickerFills] of Object.entries(byTicker)) {
    // Sort by datetime; fall back to file order when timestamps are equal or absent.
    tickerFills.sort((a, b) => {
      if (a.dt && b.dt) return a.dt.sortKey.localeCompare(b.dt.sortKey);
      if (a.dt) return -1;
      if (b.dt) return  1;
      return a.line - b.line;
    });

    let posQty        = 0;   // + = long, − = short
    let entryWap      = 0;   // weighted-average entry price (opening fills)
    let openingShares = 0;   // total shares on the opening side
    let openingFills  = [];
    let closingFills  = [];

    for (const fill of tickerFills) {
      const isBuy = fill.action === "buy";

      if (posQty === 0) {
        // Start a new round trip
        posQty        = isBuy ? fill.qty : -fill.qty;
        entryWap      = fill.price;
        openingShares = fill.qty;
        openingFills  = [fill];
        closingFills  = [];

      } else {
        const isAdding = (posQty > 0 && isBuy) || (posQty < 0 && !isBuy);

        if (isAdding) {
          // Scale into existing position — update weighted average
          const absQty = Math.abs(posQty);
          const newAbs = absQty + fill.qty;
          entryWap      = (entryWap * absQty + fill.price * fill.qty) / newAbs;
          openingShares += fill.qty;
          posQty         = posQty > 0 ? newAbs : -newAbs;
          openingFills.push(fill);

        } else {
          // Closing side (partial or full exit)
          const absQty = Math.abs(posQty);
          const newAbs = absQty - fill.qty;

          if (newAbs < -1e-9) {
            // This fill would flip the position past zero — refuse rather than guess.
            return {
              ambiguous: true,
              reason: `${ticker}: a ${fill.action} of ${fill.qty} shares would flip the ` +
                      `position (currently ${posQty > 0 ? "long" : "short"} ${absQty} shares).`,
            };
          }

          closingFills.push(fill);

          if (Math.abs(newAbs) < 1e-9) {
            // Round trip complete — emit trade
            const totalCloseQty = closingFills.reduce((s, f) => s + f.qty, 0);
            const exitWap       = closingFills.reduce((s, f) => s + f.price * f.qty, 0) / totalCloseQty;
            const firstOpen     = openingFills[0];
            const lastClose     = closingFills[closingFills.length - 1];

            completedTrades.push({
              id:        uid(),
              date:      firstOpen.dt?.date ?? firstOpen.rawDt,
              ticker,
              side:      posQty > 0 ? "long" : "short",
              entry:     Math.round(entryWap * 10000) / 10000,
              exit:      Math.round(exitWap  * 10000) / 10000,
              size:      openingShares,
              entryTime: firstOpen.dt?.time ?? "",
              exitTime:  lastClose.dt?.time  ?? "",
              type:      "Other",
              rules:     null,
              emotion:   "Calm",
              notes:     "",
              mfe:       null,
              mae:       null,
            });

            // Reset for the next round trip on this ticker
            posQty        = 0;
            entryWap      = 0;
            openingShares = 0;
            openingFills  = [];
            closingFills  = [];

          } else {
            // Partial close — reduce position, keep accumulating closing fills
            posQty = posQty > 0 ? newAbs : -newAbs;
          }
        }
      }
    }

    if (Math.abs(posQty) > 1e-9) {
      openPositions.push({ ticker, qty: posQty, entryWap });
    }
  }

  return { trades: completedTrades, openPositions };
}

// ---------- Seed data so the dashboard isn't empty on first load ----------
function makeSeedTrades() {
  const base = [
    ["2026-04-01", "NVDA", 121.4, 119.8, 50, "long", "Breakout", false, "FOMO", "09:34", "09:41", 122.6, 119.5],
    ["2026-04-02", "TSLA", 248.2, 245.9, 30, "long", "Pullback", true, "Anxious", "10:02", "10:25", 249.8, 245.2],
    ["2026-04-07", "AMD", 96.7, 99.3, 80, "long", "Pullback", true, "Calm", "09:45", "10:50", 99.8, 96.4],
    ["2026-04-10", "SPY", 545.1, 547.6, 40, "long", "Gap & Go", true, "Confident", "09:31", "09:58", 548.0, 544.7],
    ["2026-04-13", "COIN", 218.0, 213.2, 20, "long", "Breakout", false, "Revenge", "11:10", "11:18", 219.0, 212.8],
    ["2026-04-14", "MSFT", 412.3, 414.8, 25, "long", "Reversal", true, "Calm", "13:20", "14:05", 415.5, 411.9],
    ["2026-04-29", "TSLA", 251.0, 246.4, 60, "long", "Revenge re-entry", false, "Revenge", "10:40", "10:47", 251.6, 246.0],
    ["2026-05-01", "NVDA", 124.0, 121.5, 35, "long", "Breakout", false, "Anxious", "09:32", "09:50", 125.0, 121.0],
    ["2026-05-07", "AMD", 98.2, 101.4, 70, "long", "Pullback", true, "Confident", "09:48", "11:02", 101.9, 97.8],
    ["2026-05-08", "SPY", 543.0, 544.2, 50, "long", "Range", true, "Bored", "12:15", "13:40", 544.8, 542.6],
    ["2026-05-12", "MSFT", 410.1, 415.9, 30, "long", "Gap & Go", true, "Confident", "09:31", "10:10", 416.5, 409.7],
    ["2026-05-13", "COIN", 220.5, 218.0, 25, "long", "Reversal", true, "Calm", "10:55", "11:30", 221.2, 217.5],
    ["2026-05-18", "TSLA", 245.0, 249.1, 40, "long", "Breakout", true, "Confident", "09:35", "10:48", 249.6, 244.5],
    ["2026-05-20", "NVDA", 122.8, 119.4, 45, "long", "FOMO chase", false, "FOMO", "14:02", "14:09", 123.4, 119.0],
    ["2026-05-27", "AMD", 99.5, 102.0, 60, "long", "Pullback", true, "Calm", "09:50", "10:55", 102.4, 99.1],
    ["2026-06-01", "SPY", 546.0, 544.8, 50, "short", "Reversal", true, "Anxious", "10:05", "10:35", 546.6, 544.2],
    ["2026-06-02", "MSFT", 413.0, 416.2, 25, "long", "Gap & Go", true, "Confident", "09:32", "10:01", 416.8, 412.6],
    ["2026-06-03", "COIN", 219.0, 211.5, 30, "long", "Breakout", false, "FOMO", "11:20", "11:29", 220.0, 211.0],
    ["2026-06-04", "TSLA", 247.5, 250.9, 35, "long", "Pullback", true, "Calm", "09:42", "10:33", 251.4, 247.0],
    ["2026-06-08", "NVDA", 120.0, 121.8, 55, "long", "Breakout", true, "Confident", "09:33", "09:59", 122.3, 119.6],
    ["2026-06-09", "AMD", 97.4, 99.9, 65, "long", "Pullback", true, "Calm", "09:50", "10:42", 100.4, 97.0],
    ["2026-06-10", "SPY", 548.2, 540.6, 45, "long", "Gap & Go", false, "Tired", "09:31", "09:36", 548.9, 540.2],
    ["2026-06-11", "MSFT", 414.5, 415.9, 20, "long", "Range", true, "Bored", "12:40", "13:55", 416.4, 414.0],
    ["2026-06-12", "COIN", 217.0, 222.4, 30, "long", "Breakout", true, "Confident", "09:36", "10:50", 222.9, 216.5],
    ["2026-06-15", "NVDA", 121.4, 124.1, 50, "long", "Breakout", true, "Confident", "09:34", "10:12", 124.6, 121.0],
    ["2026-06-15", "TSLA", 248.2, 245.9, 30, "long", "FOMO chase", false, "FOMO", "13:15", "13:22", 248.9, 245.4],
    ["2026-06-16", "AMD", 96.7, 99.3, 80, "long", "Pullback", true, "Calm", "09:45", "10:50", 99.8, 96.4],
    ["2026-06-16", "SPY", 545.1, 543.8, 40, "short", "Reversal", true, "Anxious", "11:05", "11:30", 545.7, 543.4],
    ["2026-06-17", "TSLA", 251.0, 247.2, 60, "long", "Revenge re-entry", false, "Revenge", "10:40", "10:47", 251.6, 246.8],
    ["2026-06-18", "MSFT", 412.3, 416.8, 25, "long", "Gap & Go", true, "Confident", "09:31", "10:22", 417.3, 411.9],
    ["2026-06-19", "COIN", 218.0, 214.5, 20, "long", "Breakout", true, "Tired", "09:40", "09:58", 219.5, 214.0],
  ];
  return base.map(([date, ticker, entry, exit, size, side, type, rules, emotion, entryTime, exitTime, mfe, mae]) => ({
    id: uid(), date, ticker, entry, exit, size, side, type, rules, emotion,
    entryTime, exitTime, mfe, mae,
    notes: "", _demo: true,
  }));
}

const seedTrades = makeSeedTrades();

const seedJournal = [
  { id: uid(), date: "2026-06-17", text: "Rough day. Knew I was tilted after the TSLA loss and still went back in. Need a hard rule: no re-entry on the same ticker same day after a loss." },
  { id: uid(), date: "2026-06-19", text: "Tired going in, should have sized down or skipped the session. Stop management suffered for it." },
];

// ---------- Main App ----------
export default function TradeJournalApp() {
  const [trades, setTrades] = useState(() => {
    try {
      const saved = localStorage.getItem("tj_trades");
      return saved ? JSON.parse(saved) : seedTrades;
    } catch {
      return seedTrades;
    }
  });
  const [journal, setJournal] = useState(() => {
    try {
      const saved = localStorage.getItem("tj_journal");
      return saved ? JSON.parse(saved) : seedJournal;
    } catch {
      return seedJournal;
    }
  });
  useEffect(() => {
    localStorage.setItem("tj_trades", JSON.stringify(trades));
  }, [trades]);

  useEffect(() => {
    localStorage.setItem("tj_journal", JSON.stringify(journal));
  }, [journal]);

  const [tab, setTab] = useState("log");
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (startDate && t.date < startDate) return false;
      if (endDate && t.date > endDate) return false;
      return true;
    });
  }, [trades, startDate, endDate]);

  const sortedTrades = useMemo(() => {
    const arr = [...filteredTrades];
    arr.sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (sortKey === "pnl") {
        av = pnlOf(a);
        bv = pnlOf(b);
      }
      if (sortKey === "hold") {
        av = holdMinutes(a) ?? -1;
        bv = holdMinutes(b) ?? -1;
      }
      if (typeof av === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [filteredTrades, sortKey, sortDir]);

  function pnlOf(t) {
    const dir = t.side === "short" ? -1 : 1;
    return (t.exit - t.entry) * t.size * dir;
  }

  function addTrade(trade) {
    setTrades((prev) => [...prev, { ...trade, id: uid() }]);
    setShowForm(false);
  }

  function updateTrade(updated) {
    setTrades((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setEditingId(null);
    setShowForm(false);
  }

  function deleteTrade(id) {
    setTrades((prev) => prev.filter((t) => t.id !== id));
  }

  function addJournalEntry(entry) {
    setJournal((prev) => [{ ...entry, id: uid() }, ...prev]);
  }

  function deleteJournalEntry(id) {
    setJournal((prev) => prev.filter((j) => j.id !== id));
  }

  function clearDemoTrades() {
    setTrades((prev) => prev.filter((t) => !t._demo));
  }

  function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = ev.target.result.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) { alert("CSV has no data rows."); return; }

      const rawHeaders = parseCSVRow(lines[0]);
      const normHeaders = rawHeaders.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
      const colMap = matchColumns(normHeaders);

      // Helper: get a cell value by field name, returns "" if column wasn't matched.
      const get = (row, field) => (colMap[field] !== undefined ? row[colMap[field]]?.trim() ?? "" : "");

      // ── Fill-level detection ──────────────────────────────────────────────
      // Signal 1: only a single "price" column, no separate entry + exit columns.
      const hasPriceOnly = ("price" in colMap) && !("entry" in colMap) && !("exit" in colMap);

      // Signal 2: side/action column contains "buy" or "sell" values (not "long"/"short").
      let hasBuySellValues = false;
      if ("side" in colMap) {
        for (let i = 1; i < Math.min(lines.length, 6); i++) {
          const val = get(parseCSVRow(lines[i]), "side").toLowerCase();
          if (val === "buy" || val === "sell") { hasBuySellValues = true; break; }
        }
      }

      if (hasBuySellValues || hasPriceOnly) {
        const result = importFillCSV(lines, colMap);

        if (result.ambiguous) {
          alert(
            "This file appears to have individual buy/sell fills rather than complete trades.\n\n" +
            "Trade pairing isn't supported yet — please combine each trade into one row with entry " +
            "and exit, or use our simple CSV template instead."
          );
          return;
        }

        if (result.error) {
          alert(result.error);
          return;
        }

        if (!result.trades.length) {
          const openNote = result.openPositions?.length
            ? ` (${result.openPositions.length} position(s) still open at end of file)`
            : "";
          alert(`No completed trades found${openNote}.`);
          return;
        }

        setTrades((prev) => [...prev, ...result.trades]);
        const openNote = result.openPositions?.length
          ? `\n${result.openPositions.length} open position(s) were not imported (still open at end of file).`
          : "";
        alert(`Imported ${result.trades.length} trade(s) from fill-level data.${openNote}`);
        return;
      }

      // ── Required column check ─────────────────────────────────────────────
      const required = ["date", "ticker", "entry", "exit", "size"];
      const missing = required.filter((f) => !(f in colMap));
      if (missing.length) {
        alert(
          `Could not find required columns: ${missing.join(", ")}.\n` +
          `Headers detected: ${rawHeaders.join(", ")}`
        );
        return;
      }

      // ── Row-by-row import ─────────────────────────────────────────────────
      const skipped = [];
      const imported = [];

      for (let i = 1; i < lines.length; i++) {
        const c = parseCSVRow(lines[i]);
        const date   = get(c, "date");
        const ticker = get(c, "ticker").toUpperCase();
        const side   = get(c, "side").toLowerCase();
        const entry  = parseFloat(get(c, "entry"));
        const exitP  = parseFloat(get(c, "exit"));
        const size   = parseFloat(get(c, "size"));

        if (!date || !ticker || !["long", "short"].includes(side) ||
            isNaN(entry) || isNaN(exitP) || isNaN(size)) {
          skipped.push(i + 1); continue;
        }

        imported.push({
          id: uid(), date, ticker, side, entry, exit: exitP, size,
          type:      get(c, "type")    || "Other",
          rules:     (() => { const r = get(c, "rules"); return r === "" ? null : r.toLowerCase() === "yes"; })(),
          emotion:   get(c, "emotion") || "Calm",
          notes:     get(c, "notes")   || "",
          entryTime: get(c, "entryTime"),
          exitTime:  get(c, "exitTime"),
          mfe: null, mae: null,
        });
      }

      if (!imported.length) { alert("No valid rows found."); return; }
      setTrades((prev) => [...prev, ...imported]);
      alert(
        skipped.length
          ? `Imported ${imported.length} trade(s). Skipped ${skipped.length} bad row(s) (lines: ${skipped.join(", ")}).`
          : `Imported ${imported.length} trade(s).`
      );
    };
    reader.readAsText(file);
  }

  function exportCSV() {
    const headers = ["date", "ticker", "side", "entry", "exit", "size", "pnl", "type", "rulesFollowed", "emotion", "notes"];
    const rows = trades.map((t) => [
      t.date, t.ticker, t.side, t.entry, t.exit, t.size,
      pnlOf(t).toFixed(2), t.type, t.rules === true ? "yes" : t.rules === false ? "no" : "", t.emotion,
      `"${(t.notes || "").replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trade-journal-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={styles.app}>
      <style>{fontImport}</style>
      <Header
        tab={tab}
        setTab={setTab}
        onExport={exportCSV}
        onImport={handleImport}
        demoCount={trades.filter((t) => t._demo).length}
        onClearDemo={clearDemoTrades}
        startDate={startDate}
        endDate={endDate}
        setStartDate={setStartDate}
        setEndDate={setEndDate}
      />
      <main style={styles.main}>
        {tab === "log" && (
          <LogTab
            trades={sortedTrades}
            pnlOf={pnlOf}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={(k) => {
              if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
              else {
                setSortKey(k);
                setSortDir("desc");
              }
            }}
            onEdit={(id) => {
              setEditingId(id);
              setShowForm(true);
            }}
            onDelete={deleteTrade}
            onAddNew={() => {
              setEditingId(null);
              setShowForm(true);
            }}
          />
        )}
        {tab === "journal" && (
          <JournalTab journal={journal} onAdd={addJournalEntry} onDelete={deleteJournalEntry} />
        )}
        {tab === "dashboard" && <DashboardTab trades={filteredTrades} pnlOf={pnlOf} />}
        {tab === "calendar" && <CalendarTab trades={trades} pnlOf={pnlOf} />}
      </main>

      {showForm && (
        <TradeFormModal
          trade={editingId ? trades.find((t) => t.id === editingId) : null}
          onSave={editingId ? updateTrade : addTrade}
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- Header ----------
function Header({ tab, setTab, onExport, onImport, demoCount, onClearDemo, startDate, endDate, setStartDate, setEndDate }) {
  const importRef = useRef(null);
  const tabs = [
    { id: "log", label: "Trade Log" },
    { id: "journal", label: "Daily Journal" },
    { id: "dashboard", label: "Dashboard" },
    { id: "calendar", label: "Calendar" },
  ];
  const showDateFilter = tab === "log" || tab === "dashboard";
  return (
    <header style={styles.header}>
      <div style={styles.headerInner}>
        <div style={styles.brand}>
          <span style={styles.brandMark}>◆</span>
          <span style={styles.brandText}>OPENEPEN <span style={{ color: C.green }}>JOURNAL</span></span>
        </div>
        <nav style={styles.nav}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                ...styles.navBtn,
                ...(tab === t.id ? styles.navBtnActive : {}),
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        {showDateFilter && (
          <div style={styles.headerDateFilter}>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={styles.headerDateInput}
              title="Start date"
            />
            <span style={{ color: C.slate, fontSize: 12 }}>to</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={styles.headerDateInput}
              title="End date"
            />
            {(startDate || endDate) && (
              <button
                style={styles.clearFilterBtn}
                onClick={() => {
                  setStartDate("");
                  setEndDate("");
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}
        {demoCount > 0 && (
          <button style={styles.clearDemoBtn} onClick={onClearDemo}>
            Clear demo data ({demoCount})
          </button>
        )}
        <input ref={importRef} type="file" accept=".csv" onChange={onImport} style={{ display: "none" }} />
        <button style={styles.exportBtn} onClick={() => importRef.current.click()}>
          Import CSV
        </button>
        <button style={styles.exportBtn} onClick={onExport}>
          Export CSV
        </button>
      </div>
    </header>
  );
}

// ---------- Trade Log Tab ----------
function LogTab({ trades, pnlOf, sortKey, sortDir, onSort, onEdit, onDelete, onAddNew }) {
  const cols = [
    { key: "date", label: "Date" },
    { key: "ticker", label: "Ticker" },
    { key: "side", label: "Side" },
    { key: "type", label: "Setup" },
    { key: "pnl", label: "P&L" },
    { key: "hold", label: "Hold" },
    { key: "rules", label: "Rules" },
    { key: "emotion", label: "Emotion" },
  ];
  return (
    <div>
      <div style={styles.sectionHead}>
        <div>
          <h2 style={styles.h2}>Trade Log</h2>
          <p style={styles.subtext}>Every entry, every exit, every reason. Click a row to edit.</p>
        </div>
        <button style={styles.primaryBtn} onClick={onAddNew}>+ Add Trade</button>
      </div>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c.key}
                  style={styles.th}
                  onClick={() => onSort(c.key)}
                >
                  {c.label}
                  {sortKey === c.key && (
                    <span style={{ color: C.green, marginLeft: 6 }}>
                      {sortDir === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </th>
              ))}
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && (
              <tr>
                <td colSpan={8} style={styles.emptyCell}>
                  No trades logged yet. Add your first one above — the dashboard fills in as you go.
                </td>
              </tr>
            )}
            {trades.map((t) => {
              const pnl = pnlOf(t);
              return (
                <tr key={t.id} style={styles.tr} onClick={() => onEdit(t.id)}>
                  <td style={styles.td}>{t.date}</td>
                  <td style={{ ...styles.td, fontWeight: 600 }}>{t.ticker}</td>
                  <td style={{ ...styles.td, textTransform: "capitalize", color: C.slate }}>{t.side}</td>
                  <td style={styles.td}>{t.type}</td>
                  <td style={{ ...styles.td, color: pnl >= 0 ? C.green : C.rust, fontFamily: "var(--mono)" }}>
                    {fmtMoney(pnl)}
                  </td>
                  <td style={{ ...styles.td, color: C.slate, fontFamily: "var(--mono)", fontSize: 12.5 }}>
                    {fmtDuration(holdMinutes(t))}
                  </td>
                  <td style={styles.td}>
                    {t.rules === true && (
                      <span style={{ ...styles.pill, ...styles.pillGood }}>Followed</span>
                    )}
                    {t.rules === false && (
                      <span style={{ ...styles.pill, ...styles.pillBad }}>Broke</span>
                    )}
                    {(t.rules === null || t.rules === undefined) && (
                      <span style={{ ...styles.pill, ...styles.pillNeutral }}>—</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <span style={{ ...styles.tag, borderColor: EMOTION_COLOR[t.emotion] }}>{t.emotion}</span>
                  </td>
                  <td style={styles.td} onClick={(e) => e.stopPropagation()}>
                    <button style={styles.deleteBtn} onClick={() => onDelete(t.id)}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Daily Journal Tab ----------
function JournalTab({ journal, onAdd, onDelete }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [text, setText] = useState("");

  function submit() {
    if (!text.trim()) return;
    onAdd({ date, text });
    setText("");
  }

  const sorted = [...journal].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div>
      <div style={styles.sectionHead}>
        <div>
          <h2 style={styles.h2}>Daily Journal</h2>
          <p style={styles.subtext}>How the day went — even the days you didn't trade.</p>
        </div>
      </div>

      <div style={styles.journalForm}>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={styles.dateInput}
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What happened today — mindset, distractions, what you'd tell yourself tomorrow morning..."
          style={styles.journalTextarea}
          rows={3}
        />
        <button style={styles.primaryBtn} onClick={submit}>Save Entry</button>
      </div>

      <div style={styles.journalList}>
        {sorted.length === 0 && (
          <p style={styles.subtext}>No journal entries yet. Today's a good day to start.</p>
        )}
        {sorted.map((j) => (
          <div key={j.id} style={styles.journalEntry}>
            <div style={styles.journalEntryHead}>
              <span style={styles.journalDate}>
                {j.date} <span style={{ color: C.slate }}>· {dayOfWeek(j.date)}</span>
              </span>
              <button style={styles.deleteBtn} onClick={() => onDelete(j.id)}>✕</button>
            </div>
            <p style={styles.journalText}>{j.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Dashboard Tab ----------
function DashboardTab({ trades, pnlOf }) {
  const [view, setView] = useState("overall"); // "overall" | "daily"
  const [selectedDay, setSelectedDay] = useState(null);

  const stats = useMemo(() => computeStats(trades, pnlOf), [trades]);

  const availableDays = useMemo(() => {
    const days = [...new Set(trades.map((t) => t.date))].sort().reverse();
    return days;
  }, [trades]);

  const dayTrades = useMemo(() => {
    if (!selectedDay) return [];
    return trades.filter((t) => t.date === selectedDay);
  }, [trades, selectedDay]);

  const dayStats = useMemo(() => {
    if (!selectedDay) return null;
    return computeStats(dayTrades, pnlOf);
  }, [dayTrades, selectedDay]);

  if (trades.length === 0) {
    return (
      <div style={styles.emptyDash}>
        <h2 style={styles.h2}>Dashboard</h2>
        <p style={styles.subtext}>Log a few trades and your performance picture builds itself here.</p>
      </div>
    );
  }

  const activeStats = view === "daily" && dayStats ? dayStats : stats;

  return (
    <div>
      <div style={styles.sectionHead}>
        <div>
          <h2 style={styles.h2}>Dashboard</h2>
          <p style={styles.subtext}>The numbers behind your trading — not just what happened, but why.</p>
        </div>
        <div style={styles.viewToggle}>
          <button
            style={{ ...styles.toggleBtn, ...(view === "overall" ? styles.toggleBtnActive : {}) }}
            onClick={() => setView("overall")}
          >
            Overall
          </button>
          <button
            style={{ ...styles.toggleBtn, ...(view === "daily" ? styles.toggleBtnActive : {}) }}
            onClick={() => {
              setView("daily");
              if (!selectedDay) setSelectedDay(availableDays[0]);
            }}
          >
            Daily
          </button>
        </div>
      </div>

      {view === "daily" && (
        <div style={styles.dayPicker}>
          <span style={styles.fieldLabel}>SELECT DAY</span>
          <select
            value={selectedDay || ""}
            onChange={(e) => setSelectedDay(e.target.value)}
            style={{ ...styles.input, width: 200 }}
          >
            {availableDays.map((d) => (
              <option key={d} value={d}>{d} · {dayOfWeek(d)}</option>
            ))}
          </select>
          {dayStats && (
            <span style={{ ...styles.dayPickerSummary, color: dayStats.totalPnl >= 0 ? C.green : C.rust }}>
              {fmtMoney(dayStats.totalPnl)} net · {dayTrades.length} trade{dayTrades.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}

      {/* Signature element: rules-followed split bar */}
      <div style={styles.signatureCard}>
        <div style={styles.signatureLabel}>WIN RATE — RULES FOLLOWED VS. BROKEN</div>
        <SplitBar
          leftPct={activeStats.winRateFollowed}
          rightPct={activeStats.winRateBroken}
          leftCount={activeStats.followedCount}
          rightCount={activeStats.brokenCount}
        />
        <div style={styles.signatureFooter}>
          {activeStats.followedCount > 0 && activeStats.brokenCount > 0 && (
            <span>
              When you followed your rules, you won{" "}
              <strong style={{ color: C.green }}>{activeStats.winRateFollowed.toFixed(0)}%</strong> of the time.
              When you didn't, <strong style={{ color: C.rust }}>{activeStats.winRateBroken.toFixed(0)}%</strong>.
              That gap is your edge — or your leak.
            </span>
          )}
          {(activeStats.followedCount === 0 || activeStats.brokenCount === 0) && (
            <span>Log a mix of disciplined and undisciplined trades to see this comparison sharpen.</span>
          )}
        </div>
      </div>

      <div style={styles.statGrid}>
        <StatCard label="Total P&L" value={fmtMoney(activeStats.totalPnl)} positive={activeStats.totalPnl >= 0} negative={activeStats.totalPnl < 0} />
        <StatCard label="Win Rate" value={`${activeStats.winRate.toFixed(0)}%`} />
        <StatCard label="P&L Ratio" value={`${activeStats.pnlRatio.toFixed(2)} : 1`} />
        <StatCard label="Avg Win" value={fmtMoney(activeStats.avgWin)} positive />
        <StatCard label="Avg Loss" value={fmtMoney(activeStats.avgLoss)} negative />
        <StatCard label="Total Trades" value={activeStats.count} />
        <StatCard label="Profit Factor" value={activeStats.profitFactor === Infinity ? "∞" : activeStats.profitFactor.toFixed(2)} />
        <StatCard label="Largest Gain" value={fmtMoney(activeStats.largestGain)} positive />
        <StatCard label="Largest Loss" value={fmtMoney(activeStats.largestLoss)} negative />
        <StatCard label="Avg Win Hold" value={fmtDuration(activeStats.avgWinHold)} />
        <StatCard label="Avg Loss Hold" value={fmtDuration(activeStats.avgLossHold)} />
        <StatCard
          label="Exit Efficiency"
          value={activeStats.avgExitEfficiency !== null ? `${activeStats.avgExitEfficiency.toFixed(0)}%` : "—"}
          hint="% of best move captured"
        />
      </div>

      {view === "overall" && (
        <>
          <div style={styles.chartRow}>
            <ChartCard title="Equity Curve">
              <EquityCurve points={stats.equityCurve} />
            </ChartCard>
            <ChartCard title="P&L by Day of Week">
              <BarChartSimple data={stats.byDow} />
            </ChartCard>
          </div>

          <div style={styles.chartRow}>
            <ChartCard title="P&L by Setup Type">
              <BarChartSimple data={stats.byType} />
            </ChartCard>
            <ChartCard title="P&L by Emotion">
              <BarChartSimple data={stats.byEmotion} colorMap={EMOTION_COLOR} />
            </ChartCard>
          </div>
        </>
      )}

      {view === "daily" && dayStats && (
        <div style={styles.chartRow}>
          <ChartCard title="Trades This Day">
            <BarChartSimple
              data={dayTrades.map((t) => ({ label: t.ticker, value: pnlOf(t) }))}
            />
          </ChartCard>
          <ChartCard title="P&L by Setup Type (this day)">
            <BarChartSimple data={dayStats.byType} />
          </ChartCard>
        </div>
      )}
    </div>
  );
}

// ---------- Calendar Tab ----------
function CalendarTab({ trades, pnlOf }) {
  const dailyPnl = useMemo(() => {
    const map = {};
    trades.forEach((t) => {
      map[t.date] = (map[t.date] || 0) + pnlOf(t);
    });
    return map;
  }, [trades]);

  const months = useMemo(() => {
    const dates = Object.keys(dailyPnl);
    if (dates.length === 0) {
      const now = new Date();
      return [{ year: now.getFullYear(), month: now.getMonth() }];
    }
    const monthSet = new Set(dates.map((d) => d.slice(0, 7)));
    return [...monthSet].sort().map((m) => {
      const [y, mo] = m.split("-");
      return { year: parseInt(y), month: parseInt(mo) - 1 };
    });
  }, [dailyPnl]);

  return (
    <div>
      <div style={styles.sectionHead}>
        <div>
          <h2 style={styles.h2}>Calendar</h2>
          <p style={styles.subtext}>Every trading day, at a glance. Green days, red days, and the weekly net that ties them together.</p>
        </div>
      </div>
      <div style={styles.calendarGrid}>
        {months.map(({ year, month }) => (
          <MonthCalendar key={`${year}-${month}`} year={year} month={month} dailyPnl={dailyPnl} />
        ))}
      </div>
    </div>
  );
}

function MonthCalendar({ year, month, dailyPnl }) {
  const monthName = new Date(year, month, 1).toLocaleString("default", { month: "long" });
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = (firstDay.getDay() + 6) % 7; // make Monday = 0

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  let monthNet = 0;
  Object.keys(dailyPnl).forEach((d) => {
    const [y, m] = d.split("-");
    if (parseInt(y) === year && parseInt(m) - 1 === month) monthNet += dailyPnl[d];
  });

  function pad(n) { return n < 10 ? `0${n}` : `${n}`; }

  return (
    <div style={styles.monthCard}>
      <div style={styles.monthHead}>
        <span style={styles.monthTitle}>{monthName} {year}</span>
        <span style={{ ...styles.monthNet, color: monthNet >= 0 ? C.green : C.rust }}>
          Net: {fmtMoney(monthNet)}
        </span>
      </div>
      <div style={styles.calWeekHeader}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Week Net"].map((d) => (
          <div key={d} style={styles.calWeekHeaderCell}>{d}</div>
        ))}
      </div>
      {weeks.map((week, wi) => {
        const weekdays = week.slice(0, 5);
        let weekNet = 0;
        let hasTrade = false;
        weekdays.forEach((d) => {
          if (d) {
            const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
            if (dailyPnl[dateStr] !== undefined) {
              weekNet += dailyPnl[dateStr];
              hasTrade = true;
            }
          }
        });
        return (
          <div key={wi} style={styles.calWeekRow}>
            {weekdays.map((d, di) => {
              if (!d) return <div key={di} style={styles.calCellEmpty} />;
              const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
              const pnl = dailyPnl[dateStr];
              const hasData = pnl !== undefined;
              return (
                <div
                  key={di}
                  style={{
                    ...styles.calCell,
                    background: hasData ? (pnl >= 0 ? "rgba(63,166,106,0.22)" : "rgba(193,80,46,0.22)") : C.bgPanel2,
                  }}
                >
                  <span style={styles.calDayNum}>{d}</span>
                  {hasData && (
                    <span style={{ ...styles.calDayPnl, color: pnl >= 0 ? C.green : C.rust }}>
                      {fmtMoney(pnl)}
                    </span>
                  )}
                </div>
              );
            })}
            <div style={styles.calWeekNetCell}>
              {hasTrade ? (
                <span style={{ color: weekNet >= 0 ? C.green : C.rust, fontWeight: 700 }}>
                  {fmtMoney(weekNet)}
                </span>
              ) : (
                <span style={{ color: C.slate }}>—</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function computeStats(trades, pnlOf) {
  const withPnl = trades.map((t) => ({ ...t, pnl: pnlOf(t) }));
  const wins = withPnl.filter((t) => t.pnl > 0);
  const losses = withPnl.filter((t) => t.pnl <= 0);
  const totalPnl = withPnl.reduce((s, t) => s + t.pnl, 0);
  const winRate = withPnl.length ? (wins.length / withPnl.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? Infinity : grossWin / grossLoss;
  // P&L ratio: avg loss : avg win, expressed as a ratio against 1 (matches "0.25 : 1" style reference)
  const pnlRatio = avgWin !== 0 ? Math.abs(avgLoss) / Math.abs(avgWin) : 0;
  const largestGain = withPnl.length ? Math.max(...withPnl.map((t) => t.pnl), 0) : 0;
  const largestLoss = withPnl.length ? Math.min(...withPnl.map((t) => t.pnl), 0) : 0;

  const followed = withPnl.filter((t) => t.rules === true);
  const broken   = withPnl.filter((t) => t.rules === false);
  const winRateFollowed = followed.length ? (followed.filter((t) => t.pnl > 0).length / followed.length) * 100 : 0;
  const winRateBroken = broken.length ? (broken.filter((t) => t.pnl > 0).length / broken.length) * 100 : 0;

  // Hold time, broken out by winners vs losers
  const winHolds = wins.map((t) => holdMinutes(t)).filter((m) => m !== null);
  const lossHolds = losses.map((t) => holdMinutes(t)).filter((m) => m !== null);
  const avgWinHold = winHolds.length ? winHolds.reduce((s, m) => s + m, 0) / winHolds.length : null;
  const avgLossHold = lossHolds.length ? lossHolds.reduce((s, m) => s + m, 0) / lossHolds.length : null;

  // Exit efficiency: average % of the favorable move actually captured (only for trades with MFE logged)
  const effs = withPnl.map((t) => exitEfficiency(t)).filter((e) => e !== null);
  const avgExitEfficiency = effs.length ? effs.reduce((s, e) => s + e, 0) / effs.length : null;

  // equity curve, sorted by date
  const sortedByDate = [...withPnl].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  const equityCurve = sortedByDate.map((t) => {
    running += t.pnl;
    return { label: t.date, value: running };
  });

  const byDow = groupSum(withPnl, (t) => dayOfWeek(t.date), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  const byType = groupSum(withPnl, (t) => t.type);
  const byEmotion = groupSum(withPnl, (t) => t.emotion);

  return {
    totalPnl, winRate, avgWin, avgLoss, profitFactor, pnlRatio, largestGain, largestLoss,
    count: withPnl.length,
    winRateFollowed, winRateBroken,
    followedCount: followed.length, brokenCount: broken.length,
    avgWinHold, avgLossHold, avgExitEfficiency,
    equityCurve, byDow, byType, byEmotion,
  };
}

function groupSum(items, keyFn, order) {
  const map = {};
  items.forEach((t) => {
    const k = keyFn(t);
    map[k] = (map[k] || 0) + t.pnl;
  });
  let entries = Object.entries(map).map(([label, value]) => ({ label, value }));
  if (order) {
    entries = order.filter((k) => k in map).map((k) => ({ label: k, value: map[k] }));
  } else {
    entries.sort((a, b) => b.value - a.value);
  }
  return entries;
}

// ---------- Small visual components ----------
function SplitBar({ leftPct, rightPct, leftCount, rightCount }) {
  const total = leftCount + rightCount || 1;
  const leftWidth = (leftCount / total) * 100;
  const rightWidth = (rightCount / total) * 100;
  return (
    <div>
      <div style={styles.splitBarOuter}>
        {leftCount > 0 && (
          <div style={{ ...styles.splitBarSeg, width: `${leftWidth}%`, background: C.green }}>
            <span style={styles.splitBarPct}>{leftPct.toFixed(0)}%</span>
          </div>
        )}
        {rightCount > 0 && (
          <div style={{ ...styles.splitBarSeg, width: `${rightWidth}%`, background: C.rust }}>
            <span style={styles.splitBarPct}>{rightPct.toFixed(0)}%</span>
          </div>
        )}
      </div>
      <div style={styles.splitBarLegend}>
        <span><span style={{ ...styles.legendDot, background: C.green }} /> Rules followed ({leftCount})</span>
        <span><span style={{ ...styles.legendDot, background: C.rust }} /> Rules broken ({rightCount})</span>
      </div>
    </div>
  );
}

function StatCard({ label, value, positive, negative, hint }) {
  let color = C.text;
  if (positive) color = C.green;
  if (negative) color = C.rust;
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, color }}>{value}</div>
      {hint && <div style={styles.statHint}>{hint}</div>}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div style={styles.chartCard}>
      <div style={styles.chartTitle}>{title}</div>
      {children}
    </div>
  );
}

function BarChartSimple({ data, colorMap }) {
  if (!data.length) return <p style={styles.subtext}>No data yet.</p>;
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  return (
    <div style={styles.barChart}>
      {data.map((d) => {
        const widthPct = (Math.abs(d.value) / max) * 100;
        const color = colorMap ? colorMap[d.label] || C.green : d.value >= 0 ? C.green : C.rust;
        return (
          <div key={d.label} style={styles.barRow}>
            <div style={styles.barLabel}>{d.label}</div>
            <div style={styles.barTrack}>
              <div style={{ ...styles.barFill, width: `${widthPct}%`, background: color }} />
            </div>
            <div style={{ ...styles.barValue, color }}>{fmtMoney(d.value)}</div>
          </div>
        );
      })}
    </div>
  );
}

function EquityCurve({ points }) {
  if (!points.length) return <p style={styles.subtext}>No data yet.</p>;
  const w = 420;
  const h = 160;
  const pad = 10;
  const values = points.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((p.value - min) / range) * (h - pad * 2);
    return [x, y];
  });
  const path = coords.map((c, i) => (i === 0 ? `M${c[0]},${c[1]}` : `L${c[0]},${c[1]}`)).join(" ");
  const zeroY = h - pad - ((0 - min) / range) * (h - pad * 2);
  const last = points[points.length - 1];
  const lastUp = last.value >= 0;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h }}>
      <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke={C.line} strokeDasharray="3,3" />
      <path d={path} fill="none" stroke={lastUp ? C.green : C.rust} strokeWidth="2" />
      {coords.map((c, i) => (
        <circle key={i} cx={c[0]} cy={c[1]} r="2.5" fill={lastUp ? C.green : C.rust} />
      ))}
    </svg>
  );
}

// ---------- Trade Form Modal ----------
function TradeFormModal({ trade, onSave, onClose }) {
  const [form, setForm] = useState(
    trade || {
      date: new Date().toISOString().slice(0, 10),
      ticker: "",
      side: "long",
      entry: "",
      exit: "",
      size: "",
      type: ENTRY_TYPES[0],
      rules: null,
      emotion: EMOTIONS[0],
      notes: "",
      entryTime: "",
      exitTime: "",
      mfe: "",
      mae: "",
    }
  );

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function submit() {
    if (!form.ticker || !form.entry || !form.exit || !form.size) return;
    onSave({
      ...form,
      id: trade ? trade.id : undefined,
      entry: parseFloat(form.entry),
      exit: parseFloat(form.exit),
      size: parseFloat(form.size),
      mfe: form.mfe === "" ? null : parseFloat(form.mfe),
      mae: form.mae === "" ? null : parseFloat(form.mae),
    });
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <h3 style={styles.h3}>{trade ? "Edit Trade" : "Add Trade"}</h3>
          <button style={styles.deleteBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.formGrid}>
          <Field label="Date">
            <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} style={styles.input} />
          </Field>
          <Field label="Ticker">
            <input
              type="text"
              value={form.ticker}
              onChange={(e) => set("ticker", e.target.value.toUpperCase())}
              placeholder="NVDA"
              style={styles.input}
            />
          </Field>
          <Field label="Side">
            <select value={form.side} onChange={(e) => set("side", e.target.value)} style={styles.input}>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </Field>
          <Field label="Size (shares)">
            <input
              type="number"
              value={form.size}
              onChange={(e) => set("size", e.target.value)}
              placeholder="100"
              style={styles.input}
            />
          </Field>
          <Field label="Entry price">
            <input
              type="number"
              step="0.01"
              value={form.entry}
              onChange={(e) => set("entry", e.target.value)}
              placeholder="0.00"
              style={styles.input}
            />
          </Field>
          <Field label="Exit price">
            <input
              type="number"
              step="0.01"
              value={form.exit}
              onChange={(e) => set("exit", e.target.value)}
              placeholder="0.00"
              style={styles.input}
            />
          </Field>
          <Field label="Entry time (optional)">
            <input
              type="time"
              value={form.entryTime || ""}
              onChange={(e) => set("entryTime", e.target.value)}
              style={styles.input}
            />
          </Field>
          <Field label="Exit time (optional)">
            <input
              type="time"
              value={form.exitTime || ""}
              onChange={(e) => set("exitTime", e.target.value)}
              style={styles.input}
            />
          </Field>
          <Field label="Best price hit (MFE, optional)">
            <input
              type="number"
              step="0.01"
              value={form.mfe ?? ""}
              onChange={(e) => set("mfe", e.target.value)}
              placeholder="Highest favorable price"
              style={styles.input}
            />
          </Field>
          <Field label="Worst price hit (MAE, optional)">
            <input
              type="number"
              step="0.01"
              value={form.mae ?? ""}
              onChange={(e) => set("mae", e.target.value)}
              placeholder="Worst price against you"
              style={styles.input}
            />
          </Field>
          <Field label="Setup type">
            <select value={form.type} onChange={(e) => set("type", e.target.value)} style={styles.input}>
              {ENTRY_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Emotion">
            <select value={form.emotion} onChange={(e) => set("emotion", e.target.value)} style={styles.input}>
              {EMOTIONS.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Rules followed?">
          <div style={styles.rulesToggle}>
            {[
              { v: true,  label: "Yes" },
              { v: null,  label: "Not tagged" },
              { v: false, label: "No" },
            ].map(({ v, label }) => (
              <button
                key={label}
                type="button"
                onClick={() => set("rules", v)}
                style={{
                  ...styles.rulesBtn,
                  ...(form.rules === v
                    ? v === true  ? styles.rulesBtnYes
                    : v === false ? styles.rulesBtnNo
                    :               styles.rulesBtnNeutral
                    : {}),
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="What was the setup? What were you thinking going in and coming out?"
            style={{ ...styles.input, minHeight: 70, fontFamily: "var(--body)" }}
          />
        </Field>

        <div style={styles.modalActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={submit}>{trade ? "Save Changes" : "Add Trade"}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

// ---------- Design tokens ----------
const C = {
  bg: "#0B1320",
  bgPanel: "#101A2C",
  bgPanel2: "#0E1726",
  line: "#22304A",
  text: "#E8E6DF",
  slate: "#7A8699",
  green: "#3FA66A",
  greenDeep: "#1B4332",
  amber: "#D4A017",
  rust: "#C1502E",
};

const fontImport = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');
  :root { --mono: 'JetBrains Mono', monospace; --body: 'Inter', sans-serif; }
  * { box-sizing: border-box; }
  table { border-collapse: collapse; width: 100%; }
`;

const styles = {
  app: {
    minHeight: "100vh",
    background: C.bg,
    color: C.text,
    fontFamily: "var(--body)",
  },
  header: {
    borderBottom: `1px solid ${C.line}`,
    background: C.bgPanel,
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  headerInner: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "16px 24px",
    display: "flex",
    alignItems: "center",
    gap: 24,
    flexWrap: "wrap",
  },
  brand: { display: "flex", alignItems: "center", gap: 8, marginRight: "auto" },
  brandMark: { color: C.green, fontSize: 18 },
  brandText: { fontFamily: "var(--mono)", fontWeight: 700, letterSpacing: 1, fontSize: 14, color: C.text },
  nav: { display: "flex", gap: 4 },
  navBtn: {
    background: "transparent",
    border: "none",
    color: C.slate,
    padding: "8px 14px",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--body)",
  },
  navBtnActive: { background: C.bgPanel2, color: C.text },
  headerDateFilter: { display: "flex", alignItems: "center", gap: 6 },
  headerDateInput: {
    background: C.bgPanel2,
    border: `1px solid ${C.line}`,
    borderRadius: 6,
    padding: "6px 8px",
    color: C.text,
    fontFamily: "var(--mono)",
    fontSize: 12,
  },
  clearFilterBtn: {
    background: "transparent",
    border: "none",
    color: C.green,
    fontSize: 12,
    cursor: "pointer",
    padding: "4px 6px",
  },
  clearDemoBtn: {
    background: "transparent",
    border: `1px solid ${C.amber}`,
    color: C.amber,
    padding: "8px 14px",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "var(--mono)",
  },
  exportBtn: {
    background: "transparent",
    border: `1px solid ${C.line}`,
    color: C.slate,
    padding: "8px 14px",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "var(--mono)",
  },
  main: { maxWidth: 1100, margin: "0 auto", padding: "32px 24px 80px" },
  sectionHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    flexWrap: "wrap",
    gap: 16,
    marginBottom: 24,
  },
  h2: { fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: -0.3 },
  h3: { fontSize: 18, fontWeight: 700, margin: 0 },
  subtext: { color: C.slate, fontSize: 14, margin: "4px 0 0" },
  primaryBtn: {
    background: C.green,
    color: "#08130D",
    border: "none",
    padding: "10px 18px",
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
  },
  secondaryBtn: {
    background: "transparent",
    border: `1px solid ${C.line}`,
    color: C.text,
    padding: "10px 18px",
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
  },
  tableWrap: {
    background: C.bgPanel,
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    overflow: "hidden",
  },
  th: {
    textAlign: "left",
    padding: "12px 16px",
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: C.slate,
    borderBottom: `1px solid ${C.line}`,
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  tr: { cursor: "pointer", transition: "background 0.15s" },
  td: {
    padding: "13px 16px",
    fontSize: 14,
    borderBottom: `1px solid ${C.line}`,
  },
  emptyCell: { padding: "32px 16px", textAlign: "center", color: C.slate, fontSize: 14 },
  pill: {
    fontSize: 12,
    fontWeight: 600,
    padding: "3px 10px",
    borderRadius: 20,
    display: "inline-block",
  },
  pillGood:    { background: "rgba(63,166,106,0.15)", color: C.green },
  pillBad:     { background: "rgba(193,80,46,0.15)", color: C.rust },
  pillNeutral: { background: "transparent", color: C.slate, border: `1px solid ${C.line}` },
  tag: {
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 20,
    border: `1px solid ${C.line}`,
    color: C.text,
  },
  deleteBtn: {
    background: "transparent",
    border: "none",
    color: C.slate,
    cursor: "pointer",
    fontSize: 13,
    padding: 4,
  },
  journalForm: {
    background: C.bgPanel,
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  dateInput: {
    background: C.bgPanel2,
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    padding: "10px 12px",
    color: C.text,
    fontFamily: "var(--mono)",
    fontSize: 13,
    width: 160,
  },
  journalTextarea: {
    background: C.bgPanel2,
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    padding: "12px 14px",
    color: C.text,
    fontSize: 14,
    fontFamily: "var(--body)",
    resize: "vertical",
  },
  journalList: { display: "flex", flexDirection: "column", gap: 12 },
  journalEntry: {
    background: C.bgPanel,
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: 16,
  },
  journalEntryHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  journalDate: { fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600 },
  journalText: { margin: 0, fontSize: 14, lineHeight: 1.6, color: C.text },
  emptyDash: { textAlign: "center", padding: "60px 0" },
  signatureCard: {
    background: `linear-gradient(135deg, ${C.bgPanel}, ${C.bgPanel2})`,
    border: `1px solid ${C.line}`,
    borderRadius: 14,
    padding: 24,
    marginBottom: 24,
  },
  signatureLabel: { fontFamily: "var(--mono)", fontSize: 12, letterSpacing: 1, color: C.slate, marginBottom: 14 },
  splitBarOuter: {
    display: "flex",
    height: 36,
    borderRadius: 8,
    overflow: "hidden",
    background: C.bgPanel2,
  },
  splitBarSeg: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "width 0.3s",
  },
  splitBarPct: { fontFamily: "var(--mono)", fontWeight: 700, fontSize: 13, color: "#08130D" },
  splitBarLegend: { display: "flex", gap: 24, marginTop: 12, fontSize: 13, color: C.slate },
  legendDot: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 6 },
  signatureFooter: { marginTop: 14, fontSize: 13.5, color: C.slate, lineHeight: 1.6 },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    background: C.bgPanel,
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: "16px 18px",
  },
  statLabel: { fontSize: 12, color: C.slate, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  statValue: { fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700 },
  statHint: { fontSize: 10.5, color: C.slate, marginTop: 4 },
  chartRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },
  chartCard: {
    background: C.bgPanel,
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 18,
  },
  chartTitle: { fontSize: 13, fontWeight: 600, color: C.slate, marginBottom: 14, textTransform: "uppercase", letterSpacing: 0.5 },
  barChart: { display: "flex", flexDirection: "column", gap: 10 },
  barRow: { display: "grid", gridTemplateColumns: "70px 1fr 70px", alignItems: "center", gap: 8 },
  barLabel: { fontSize: 12.5, color: C.text },
  barTrack: { background: C.bgPanel2, height: 14, borderRadius: 4, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4 },
  barValue: { fontFamily: "var(--mono)", fontSize: 12, textAlign: "right" },
  viewToggle: { display: "flex", gap: 4, background: C.bgPanel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 4 },
  toggleBtn: {
    background: "transparent",
    border: "none",
    color: C.slate,
    padding: "7px 14px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  toggleBtnActive: { background: C.greenDeep, color: C.green },
  dayPicker: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    marginBottom: 20,
    background: C.bgPanel,
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: "12px 16px",
  },
  dayPickerSummary: { fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600 },
  calendarGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 },
  monthCard: {
    background: C.bgPanel,
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 16,
  },
  monthHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
    paddingBottom: 10,
    borderBottom: `1px solid ${C.line}`,
  },
  monthTitle: { fontWeight: 700, fontSize: 15 },
  monthNet: { fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700 },
  calWeekHeader: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 1.1fr", gap: 4, marginBottom: 4 },
  calWeekHeaderCell: { fontSize: 10.5, color: C.slate, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "center" },
  calWeekRow: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 1.1fr", gap: 4, marginBottom: 4 },
  calCell: {
    borderRadius: 6,
    padding: "6px 4px",
    minHeight: 44,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
  },
  calCellEmpty: { minHeight: 44 },
  calDayNum: { fontSize: 10.5, color: C.slate },
  calDayPnl: { fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700 },
  calWeekNetCell: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--mono)",
    fontSize: 12,
    background: C.bgPanel2,
    borderRadius: 6,
  },
  modalOverlay: {
    position: "fixed",
    top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 50,
  },
  modal: {
    background: C.bgPanel,
    border: `1px solid ${C.line}`,
    borderRadius: 14,
    padding: 24,
    maxWidth: 560,
    width: "100%",
    maxHeight: "90vh",
    overflowY: "auto",
  },
  modalHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 4 },
  fieldLabel: { fontSize: 12, color: C.slate, textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    background: C.bgPanel2,
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    padding: "9px 12px",
    color: C.text,
    fontSize: 14,
    fontFamily: "var(--body)",
    width: "100%",
  },
  rulesToggle: {
    display: "flex",
    gap: 0,
    background: C.bgPanel2,
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    overflow: "hidden",
  },
  rulesBtn: {
    flex: 1,
    background: "transparent",
    border: "none",
    borderRight: `1px solid ${C.line}`,
    color: C.slate,
    padding: "9px 0",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--body)",
    transition: "background 0.15s, color 0.15s",
  },
  rulesBtnYes:     { background: "rgba(63,166,106,0.18)", color: C.green,  fontWeight: 700 },
  rulesBtnNo:      { background: "rgba(193,80,46,0.18)",  color: C.rust,   fontWeight: 700 },
  rulesBtnNeutral: { background: C.bgPanel,               color: C.text,   fontWeight: 600 },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 },
};
