"""
kelly_cash/dashboard.py
-----------------------
Kelly Cash — Live Trading Dashboard.

Run with:
    cd chop-trader
    streamlit run kelly_cash/dashboard.py

Shows:
  • Status bar — paper/live mode, trading window, today's P&L, equity
  • Open positions — with live P&L (pulled from trade log)
  • Scanner feed — top Scanner Dan candidates right now
  • Equity curve — cumulative P&L over time
  • Trade log — recent closed trades
  • Controls — tune all KellyConfig params live
"""

import os
import sys
import time
import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

from kelly_cash.config import kelly_config as config

load_dotenv()
logging.basicConfig(level=logging.INFO)
ET = ZoneInfo("America/New_York")

# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="Kelly Cash",
    page_icon="💸",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
/* OpenEpen + Kelly Cash Theme */
:root {
    --navy: #0a0f1e;
    --navy-mid: #111827;
    --navy-light: #1e293b;
    --green: #22c55e;
    --green-dark: #16a34a;
    --green-glow: rgba(34, 197, 94, 0.15);
    --green-light: #4ade80;
    --text: #e2e8f0;
    --text-muted: #94a3b8;
    --border: rgba(34, 197, 94, 0.2);
    --white: #ffffff;
    --card-bg: #0f172a;
    --red: #ef4444;
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

html, body, [class*="css"] {
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    background-color: var(--navy);
    color: var(--text);
}

.stApp { background-color: var(--navy); }
#MainMenu, footer, header { visibility: hidden; }

.bot-title {
    font-size: 32px;
    font-weight: 800;
    color: var(--white);
    letter-spacing: -0.02em;
    margin-bottom: 4px;
}
.bot-title span {
    color: var(--green);
}

.bot-sub {
    font-size: 12px;
    color: var(--text-muted);
    letter-spacing: 2px;
    text-transform: uppercase;
    font-weight: 500;
}

.sec-hdr {
    font-size: 12px;
    letter-spacing: 2px;
    color: var(--green);
    text-transform: uppercase;
    border-bottom: 1px solid var(--border);
    padding-bottom: 8px;
    margin: 24px 0 16px;
    font-weight: 600;
}

[data-testid="metric-container"] {
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 14px;
    backdrop-filter: blur(8px);
}
[data-testid="metric-container"] label {
    font-size: 11px;
    letter-spacing: 1px;
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
}
[data-testid="metric-container"] [data-testid="stMetricValue"] {
    font-size: 24px;
    font-weight: 700;
    color: var(--green-light);
    margin-top: 4px;
}

[data-testid="stSidebar"] {
    background-color: var(--card-bg);
    border-right: 1px solid var(--border);
}

.pill {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
}
.pill-green  { background: rgba(34, 197, 94, 0.15); color: var(--green); border: 1px solid var(--border); }
.pill-red    { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); }
.pill-amber  { background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
.pill-gray   { background: rgba(148, 163, 184, 0.15); color: var(--text-muted); border: 1px solid rgba(148, 163, 184, 0.3); }

.stSlider label { font-size: 11px; letter-spacing: 1px; color: var(--text-muted); font-weight: 600; }
.stSlider {
    padding: 8px 0;
}

.stButton button {
    background: var(--green);
    color: var(--navy);
    border: none;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1px;
    border-radius: 6px;
    padding: 8px 16px;
}
.stButton button:hover {
    background: var(--green-light);
    color: var(--navy);
}

/* Table styling */
[data-testid="stDataFrame"] {
    background: var(--card-bg);
}

[data-testid="stDataFrame"] th {
    background: rgba(34, 197, 94, 0.1);
    color: var(--green);
    font-weight: 600;
    border-bottom: 1px solid var(--border);
}

[data-testid="stDataFrame"] td {
    border-bottom: 1px solid rgba(34, 197, 94, 0.1);
    color: var(--text);
}
</style>
""", unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

@st.cache_resource
def get_db():
    os.makedirs("logs", exist_ok=True)
    return create_engine(f"sqlite:///{config.db_path}", echo=False)


def load_trades(limit: int = 200) -> pd.DataFrame:
    try:
        with get_db().connect() as conn:
            df = pd.read_sql(
                text("SELECT * FROM trades ORDER BY timestamp DESC LIMIT :lim"),
                conn, params={"lim": limit},
            )
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        return df
    except Exception:
        return pd.DataFrame()


def get_today_pnl(trades: pd.DataFrame) -> float:
    if trades.empty or "pnl" not in trades.columns:
        return 0.0
    today = datetime.now(timezone.utc).date()
    mask  = trades["timestamp"].dt.date == today
    return float(trades.loc[mask, "pnl"].dropna().sum())


def build_equity_curve(trades: pd.DataFrame, initial: float = 10_000) -> pd.DataFrame:
    if trades.empty or "pnl" not in trades.columns:
        return pd.DataFrame(columns=["timestamp", "equity"])
    sells = trades[trades["pnl"].notna()].copy()
    if sells.empty:
        return pd.DataFrame(columns=["timestamp", "equity"])
    sells = sells.sort_values("timestamp")
    sells["equity"] = initial + sells["pnl"].cumsum()
    return sells[["timestamp", "equity"]]


# ---------------------------------------------------------------------------
# Sidebar — live config controls
# ---------------------------------------------------------------------------

def render_sidebar():
    with st.sidebar:
        st.markdown('<div class="sec-hdr">Kelly Cash Controls</div>', unsafe_allow_html=True)
        mode = "🟡 PAPER" if config.paper else "🔴 LIVE"
        st.markdown(f'<span class="pill pill-amber">{mode} TRADING</span>', unsafe_allow_html=True)
        st.markdown("")

        st.markdown('<div class="sec-hdr">Strategy</div>', unsafe_allow_html=True)
        strategy_choice = st.radio(
            "Select Strategy",
            options=["HOD Breakout", "VWAP Break"],
            index=1 if config.strategy == "vwap" else 0,
            key="kc_strategy",
            horizontal=False
        )
        if strategy_choice == "VWAP Break":
            st.markdown('<span class="pill pill-green">🟢 Mag7 + MU</span>', unsafe_allow_html=True)
        else:
            st.markdown('<span class="pill pill-gray">👀 Small Caps</span>', unsafe_allow_html=True)
        st.markdown("")

        st.markdown('<div class="sec-hdr">Entry Criteria</div>', unsafe_allow_html=True)

        st.slider("MIN PRICE $",      0.5,  20.0, config.min_price,   0.5,  key="kc_min_price")
        st.slider("MAX PRICE $",      1.0, 100.0, config.max_price,   1.0,  key="kc_max_price")
        st.slider("MAX FLOAT (M)",    5,   500,   int(config.max_float_M), 5, key="kc_max_float", format="%dM")
        st.slider("MIN REL VOL",      0.5, 10.0,  config.min_rel_vol_entry, 0.25, key="kc_min_rel_vol", format="%.2fx")
        st.slider("MIN CHANGE %",     0.0, 30.0,  config.min_change_pct, 0.5, key="kc_min_change", format="%.1f%%")
        st.slider("HOD BREAKOUT",     1.000, 1.050, config.hod_breakout_pct, 0.001, key="kc_hod_breakout", format="%.3f")

        st.markdown('<div class="sec-hdr">Exit Rules</div>', unsafe_allow_html=True)
        st.slider("STOP LOSS %",       1,  20, int(config.stop_loss_pct * 100),    1, key="kc_stop_loss",    format="%d%%")
        st.slider("TAKE PROFIT %",     5,  50, int(config.take_profit_pct * 100),  1, key="kc_take_profit",  format="%d%%")
        st.slider("TRAILING STOP %",   1,  20, int(config.trailing_stop_pct * 100),1, key="kc_trail_stop",   format="%d%%")
        st.slider("HOD BREAKDOWN %",   1,  15, int(config.hod_breakdown_pct * 100),1, key="kc_hod_breakdown",format="%d%%")

        st.markdown('<div class="sec-hdr">Position Sizing</div>', unsafe_allow_html=True)
        st.checkbox("Dynamic sizing (vol-scaled)", value=config.use_dynamic_sizing, key="kc_dynamic")
        st.slider("FIXED SHARES",     1, 500, config.share_count,         1, key="kc_share_count", disabled=st.session_state.get("kc_dynamic", True))
        st.slider("MAX POSITION %",   1,  25, int(config.max_position_pct * 100), 1, key="kc_max_pos_pct", format="%d%%")
        st.slider("MAX OPEN POSITIONS", 1, 10, config.max_open_positions,  1, key="kc_max_pos")

        st.markdown('<div class="sec-hdr">Risk</div>', unsafe_allow_html=True)
        st.slider("MAX DAILY LOSS %", 1, 20, int(config.max_daily_loss * 100), 1, key="kc_max_daily_loss", format="%d%%")

        st.markdown("")
        st.info(
            "⚠️ These controls update the display only. To apply changes to the running bot, "
            "restart `kelly_cash/main.py`.",
            icon=None,
        )


# ---------------------------------------------------------------------------
# Scanner feed panel
# ---------------------------------------------------------------------------

def render_scanner_feed():
    # Check session state first for live strategy changes, fall back to config
    strategy_choice = st.session_state.get("kc_strategy", None)
    if strategy_choice == "VWAP Break":
        strategy = "VWAP"
    elif strategy_choice == "HOD Breakout":
        strategy = "HOD"
    else:
        strategy = config.strategy.upper()
    
    if strategy == "VWAP":
        st.markdown('<div class="sec-hdr">Scanner Feed — Magnificent Seven + MU (VWAP Strategy)</div>', unsafe_allow_html=True)
    else:
        st.markdown('<div class="sec-hdr">Scanner Dan Feed — Small-Cap HOD Breakouts</div>', unsafe_allow_html=True)

    api_key    = os.getenv("ALPACA_API_KEY", "")
    secret_key = os.getenv("ALPACA_SECRET_KEY", "")

    if not api_key:
        st.warning("No Alpaca API key found — scanner feed unavailable.")
        return

    @st.cache_resource
    def _get_scanner():
        from scanner_dan.scanner import ScannerDan
        return ScannerDan(api_key=api_key, secret_key=secret_key)

    with st.spinner("Pulling scanner feed..."):
        try:
            # For VWAP strategy, use Mag7 + MU instead of small caps
            if strategy == "VWAP":
                from kelly_cash.config import MAG7_PLUS_MU
                df = _get_scanner().scan(
                    min_price     = 50.0,  # VWAP trades higher prices
                    max_price     = 500.0,
                    max_float_M   = 10000.0,  # large caps
                    min_rel_vol   = st.session_state.get("kc_min_rel_vol", 1.5),
                    min_change_pct = 0.0,
                    extra_symbols = MAG7_PLUS_MU,
                )
            else:
                df = _get_scanner().scan(
                    min_price    = st.session_state.get("kc_min_price",    config.min_price),
                    max_price    = st.session_state.get("kc_max_price",    config.max_price),
                    max_float_M  = st.session_state.get("kc_max_float",    config.max_float_M),
                    min_rel_vol  = st.session_state.get("kc_min_rel_vol",  config.min_rel_vol_entry),
                    min_change_pct = st.session_state.get("kc_min_change", config.min_change_pct),
                )
        except Exception as e:
            st.error(f"Scanner error: {e}")
            return

    if df.empty:
        st.info("No candidates match current filters right now.")
        return

    rows = []
    
    if strategy == "VWAP":
        # VWAP strategy display
        vwap_pct = st.session_state.get("kc_vwap_breakout", config.vwap_breakout_pct)
        for _, row in df.head(8).iterrows():
            price = row.get("price") or 0
            # Note: Scanner Dan doesn't have VWAP yet, so we simulate it
            # In production, you'd fetch VWAP from a data source
            # For now, use HOD as proxy
            vwap_approx = row.get("hod") or price
            breakout_level = vwap_approx * vwap_pct
            at_breakout = price >= breakout_level if breakout_level > 0 else False

            rows.append({
                "Symbol":    row["symbol"],
                "Price":     f"${price:.2f}",
                "VWAP Est.": f"${vwap_approx:.2f}",
                "Gap %":     f"{((price - vwap_approx) / vwap_approx * 100):+.2f}%",
                "Chg Close": f"{row.get('change_close_pct', 0):+.2f}%",
                "Rel Vol":   f"{row.get('rel_vol_daily', 0):.2f}x",
                "Signal":    "🟢 VWAP BREAK" if at_breakout else "👀 BUILDING",
            })
    else:
        # HOD strategy display (original)
        hod_pct = st.session_state.get("kc_hod_breakout", config.hod_breakout_pct)
        for _, row in df.head(10).iterrows():
            hod = row.get("hod") or 0
            price = row.get("price") or 0
            breakout_level = hod * hod_pct if hod else 0
            at_breakout = price >= breakout_level if breakout_level > 0 else False

            rows.append({
                "Symbol":    row["symbol"],
                "Price":     f"${price:.2f}",
                "HOD":       f"${hod:.2f}" if hod else "—",
                "HOD Gap %": f"{row.get('hod_gap_pct', 0):+.2f}%",
                "Chg Close": f"{row.get('change_close_pct', 0):+.2f}%",
                "Rel Vol":   f"{row.get('rel_vol_daily', 0):.2f}x",
                "Float":     f"{row.get('float_M', 0):.1f}M" if row.get("float_M") else "—",
                "Signal":    "🟢 BREAK" if at_breakout else "👀 WATCH",
            })

    st.dataframe(pd.DataFrame(rows), width='stretch', hide_index=True)


# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

def render_header(trades: pd.DataFrame):
    now_et  = datetime.now(ET)
    t_str   = now_et.strftime("%I:%M:%S %p ET")
    t_clock = now_et.strftime("%H:%M")

    if "09:45" <= t_clock < "15:30":
        session_html = '<span class="pill pill-green">● TRADING ACTIVE</span>'
    elif "04:00" <= t_clock < "09:45":
        session_html = '<span class="pill pill-amber">● PRE-MARKET</span>'
    else:
        session_html = '<span class="pill pill-gray">● MARKET CLOSED</span>'

    # Use session state strategy choice if available, else fall back to config
    strategy_choice = st.session_state.get("kc_strategy", None)
    if strategy_choice == "VWAP Break":
        strategy_name = "VWAP Break (Mag7)"
    elif strategy_choice == "HOD Breakout":
        strategy_name = "HOD Breakout"
    else:
        strategy_name = "VWAP Break (Mag7)" if config.strategy == "vwap" else "HOD Breakout"
    
    st.markdown(
        f"""
        <div style="display:flex; justify-content:space-between; align-items:center;
                    padding: 12px 0 18px; border-bottom: 1px solid rgba(34, 197, 94, 0.2); margin-bottom:18px">
            <div>
                <span class="bot-title">💸 Kelly <span>Cash</span></span>
                &nbsp;&nbsp;{session_html}
                <div class="bot-sub">{strategy_name} — Kelly's Strategy</div>
            </div>
            <div style="font-size:11px; color:#94a3b8">{t_str}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    today_pnl    = get_today_pnl(trades)
    total_trades = len(trades[trades["action"].isin(["sell","stop_loss","take_profit","eod_close","trailing_stop","hod_breakdown"])]) if not trades.empty else 0
    wins         = len(trades[trades.get("pnl", pd.Series(dtype=float)) > 0]) if not trades.empty else 0
    win_rate     = wins / total_trades * 100 if total_trades > 0 else 0

    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("TODAY P&L",    f"${today_pnl:+,.2f}")
    c2.metric("TOTAL TRADES", str(total_trades))
    c3.metric("WIN RATE",     f"{win_rate:.0f}%")
    c4.metric("MODE",         "PAPER" if config.paper else "LIVE")
    c5.metric("STRATEGY",     strategy_name)


# ---------------------------------------------------------------------------
# Equity curve
# ---------------------------------------------------------------------------

def render_equity_curve(trades: pd.DataFrame):
    st.markdown('<div class="sec-hdr">Kelly Cash — Equity Curve</div>', unsafe_allow_html=True)

    eq = build_equity_curve(trades)
    if eq.empty:
        st.info("Equity curve appears after first closed trade.")
        return

    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=eq["timestamp"], y=eq["equity"],
        mode="lines",
        line=dict(color="#86c950", width=2),
        fill="tozeroy",
        fillcolor="rgba(134,201,80,0.06)",
        name="Equity",
    ))
    fig.update_layout(
        paper_bgcolor="#050810", plot_bgcolor="#050810",
        font=dict(family="JetBrains Mono", color="#4a6a2a", size=10),
        margin=dict(l=0, r=0, t=10, b=0), height=220,
        xaxis=dict(showgrid=False),
        yaxis=dict(showgrid=True, gridcolor="#0a1205", tickprefix="$"),
        hovermode="x unified",
    )
    st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})


# ---------------------------------------------------------------------------
# Trade log
# ---------------------------------------------------------------------------

def render_trade_log(trades: pd.DataFrame):
    st.markdown('<div class="sec-hdr">Recent Trades</div>', unsafe_allow_html=True)

    if trades.empty:
        st.info("No Kelly Cash trades recorded yet.")
        return

    cols = ["timestamp", "symbol", "action", "qty", "price", "pnl", "pnl_pct", "notes"]
    avail = [c for c in cols if c in trades.columns]
    display = trades[avail].copy().head(50)

    if "timestamp" in display.columns:
        display["timestamp"] = display["timestamp"].dt.strftime("%m-%d %H:%M")
    if "price" in display.columns:
        display["price"]  = display["price"].map("${:.2f}".format)
    if "pnl" in display.columns:
        display["pnl"]    = display["pnl"].map(lambda x: f"${x:+.2f}" if pd.notna(x) else "")
    if "pnl_pct" in display.columns:
        display["pnl_pct"] = display["pnl_pct"].map(lambda x: f"{x*100:+.2f}%" if pd.notna(x) else "")

    display.columns = [c.upper().replace("_", " ") for c in display.columns]
    st.dataframe(display, use_container_width=True, hide_index=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    render_sidebar()

    trades = load_trades()

    render_header(trades)
    render_scanner_feed()

    left, right = st.columns([3, 2])
    with left:
        render_equity_curve(trades)
    with right:
        st.markdown('<div class="sec-hdr">Strategy Parameters</div>', unsafe_allow_html=True)
        
        # Use session state strategy choice if available, else fall back to config
        strategy_choice = st.session_state.get("kc_strategy", None)
        if strategy_choice == "VWAP Break":
            is_vwap = True
        elif strategy_choice == "HOD Breakout":
            is_vwap = False
        else:
            is_vwap = config.strategy == "vwap"
        
        if is_vwap:
            st.markdown(f"""
<div style="font-size:11px; line-height:2; color:#94a3b8">
<strong style="color: var(--green)">VWAP STRATEGY</strong><br>
<br>
ENTRY &nbsp;&nbsp;&nbsp;: Price ≥ VWAP × {config.vwap_breakout_pct:.3f}<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ Rel Vol ≥ {config.min_rel_vol_vwap}×<br>
<br>
EXITS &nbsp;&nbsp;: Profit Target &nbsp;&nbsp;&nbsp;{config.vwap_profit_target*100:.0f}%<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Stop Loss &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{config.vwap_stop_loss*100:.0f}%<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;VWAP Touchback<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;EOD Close &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;15:30 ET<br>
<br>
UNIVERSE : Mag7 + MU (large cap)<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Focus on breakouts<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;above VWAP
</div>
""", unsafe_allow_html=True)
        else:
            st.markdown(f"""
<div style="font-size:11px; line-height:2; color:#94a3b8">
<strong style="color: var(--green)">HOD BREAKOUT STRATEGY</strong><br>
<br>
ENTRY &nbsp;&nbsp;&nbsp;: Price ≥ HOD × {config.hod_breakout_pct:.3f}<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ Rel Vol ≥ {config.min_rel_vol_entry}×<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ Change ≥ {config.min_change_pct}%<br>
<br>
EXITS &nbsp;&nbsp;: Stop Loss &nbsp;&nbsp;&nbsp;{config.stop_loss_pct*100:.0f}%<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Take Profit &nbsp;{config.take_profit_pct*100:.0f}%<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Trailing Stop {config.trailing_stop_pct*100:.0f}%<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;HOD Breakdown {config.hod_breakdown_pct*100:.0f}%<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;EOD Close &nbsp;&nbsp;&nbsp;15:30 ET<br>
</div>
""", unsafe_allow_html=True)

    render_trade_log(trades)

    # Auto-refresh
    elapsed = time.time() - st.session_state.get("kc_last_refresh", 0)
    if elapsed >= 30:
        st.session_state["kc_last_refresh"] = time.time()
        st.rerun()

    st.markdown(
        f'<div style="text-align:right; font-size:9px; color:#1a2810; margin-top:16px">'
        f"auto-refresh in {max(0, 30 - int(elapsed))}s</div>",
        unsafe_allow_html=True,
    )


if __name__ == "__main__" or True:
    main()
