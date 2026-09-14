"""
kelly_cash/main.py
------------------
Kelly Cash — HOD Breakout Bot runner.

Run with:
    cd chop-trader
    python kelly_cash/main.py

Dashboard (separate terminal):
    streamlit run kelly_cash/dashboard.py

Startup sequence:
  1. Load config
  2. Init Alpaca clients
  3. Init Scanner Dan (for candidate discovery)
  4. Start APScheduler:
       - Signal loop : every signal_interval_minutes (find & enter breakouts)
       - Risk loop   : every poll_interval_seconds (check exits)
       - EOD close   : 15:30 ET
       - Daily reset : 4:00 AM ET
"""

import logging
import os
import sys
import time as _time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from kelly_cash.config import kelly_config as config
from kelly_cash.strategy import (
    KellyPosition, check_entry, check_exit, calc_shares
)
from scanner_dan.scanner import ScannerDan
from trading.executor import OrderExecutor
from trading.logger import TradeLogger
from data.calendar import MarketCalendar

os.makedirs("logs", exist_ok=True)
logging.Formatter.converter = _time.gmtime
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s UTC  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(config.log_path),
    ],
)
logger = logging.getLogger("kelly_cash")
ET = ZoneInfo("America/New_York")

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

scanner:    ScannerDan    = None
executor:   OrderExecutor = None
trade_logger: TradeLogger = None
calendar:   MarketCalendar = None

positions: dict = {}          # symbol → KellyPosition (Kelly Cash's own tracking)
start_of_day_equity: float = 0.0
bot_halted: bool = False


# ---------------------------------------------------------------------------
# Session guard
# ---------------------------------------------------------------------------

def _is_trading_time() -> bool:
    now = datetime.now(ET)
    if now.weekday() >= 5:
        return False
    t = now.strftime("%H:%M")
    return config.trade_start <= t < config.trade_end


# ---------------------------------------------------------------------------
# Scheduler jobs
# ---------------------------------------------------------------------------

def job_signal_loop():
    """Scan for HOD breakout candidates and enter positions."""
    global bot_halted

    if bot_halted:
        logger.warning("Kelly Cash halted (daily loss limit). No new entries.")
        return

    if not calendar.is_open():
        logger.info("Market closed today — signal loop skipped")
        return

    if not _is_trading_time():
        logger.info("Outside trading window — signal loop skipped")
        return

    logger.info("Signal loop: scanning for HOD breakouts...")
    df = scanner.scan(
        min_price     = config.min_price,
        max_price     = config.max_price,
        max_float_M   = config.max_float_M,
        min_rel_vol   = config.min_rel_vol_entry,
        min_change_pct = config.min_change_pct,
    )

    if df.empty:
        logger.info("No candidates found this cycle")
        return

    portfolio_value = executor.get_portfolio_value()

    for _, row in df.iterrows():
        symbol   = row["symbol"]
        price    = row["price"]
        hod      = row["hod"]
        rel_vol  = row["rel_vol_daily"]
        chg_pct  = row["change_close_pct"]

        should_buy, reason = check_entry(
            symbol, price, hod, rel_vol, chg_pct, config, positions
        )

        if not should_buy:
            logger.debug(f"  {symbol}: skip — {reason}")
            continue

        qty = calc_shares(price, rel_vol or 1.0, portfolio_value, config)
        if qty == 0:
            logger.info(f"  {symbol}: sizing returned 0 — skipping")
            continue

        logger.info(
            f"  → BUY {qty} {symbol} @ ~${price:.2f} "
            f"(HOD=${hod:.2f}, rel_vol={rel_vol:.2f}x)"
        )
        success = executor.submit_buy(symbol, qty, price=price)
        if success:
            positions[symbol] = KellyPosition(
                symbol=symbol,
                qty=qty,
                entry_price=price,
                entry_time=datetime.now(timezone.utc),
                hod_at_entry=hod,
            )
            trade_logger.log_trade(
                symbol=symbol, action="buy", qty=qty, price=price,
                confidence=rel_vol / 10.0,    # use rel_vol as proxy for confidence in log
                regime="momentum", session="regular",
                notes=f"hod_breakout hod={hod:.2f} rel_vol={rel_vol:.2f}x",
            )


def job_risk_loop():
    """Check all open Kelly Cash positions for exit conditions."""
    global bot_halted, start_of_day_equity

    if not positions:
        return

    current_equity = executor.get_equity()

    # Daily loss guard
    if start_of_day_equity > 0:
        loss_pct = (start_of_day_equity - current_equity) / start_of_day_equity
        if loss_pct >= config.max_daily_loss:
            logger.critical(
                f"Kelly Cash daily loss limit hit: {loss_pct*100:.2f}% — halting bot"
            )
            bot_halted = True
            _close_all()
            return

    # Get current prices via scanner (one snapshot call for all held symbols)
    held = list(positions.keys())
    try:
        snaps = scanner._fetch_snapshots(held)
    except Exception as e:
        logger.error(f"Risk loop snapshot failed: {e}")
        return

    for symbol, pos in list(positions.items()):
        snap = snaps.get(symbol)
        if not snap:
            continue

        daily  = snap.daily_bar
        trade  = snap.latest_trade
        minute = snap.minute_bar

        if trade and trade.price:
            current_price = float(trade.price)
        elif minute and minute.close:
            current_price = float(minute.close)
        elif daily:
            current_price = float(daily.close)
        else:
            continue

        current_hod = float(daily.high) if daily and daily.high else pos.hod_at_entry
        pos.increment_bars()

        should_exit, reason = check_exit(pos, current_price, current_hod, config)
        if should_exit:
            pnl     = pos.unrealized_pnl(current_price)
            pnl_pct = pos.pnl_pct(current_price)
            logger.info(
                f"  → EXIT {pos.qty} {symbol} @ ${current_price:.2f} "
                f"reason={reason} pnl={pnl_pct*100:.2f}%"
            )
            success = executor.submit_sell(symbol, pos.qty)
            if success:
                del positions[symbol]
                trade_logger.log_trade(
                    symbol=symbol, action=reason, qty=pos.qty, price=current_price,
                    pnl=pnl, pnl_pct=pnl_pct, notes=f"exit_reason={reason}",
                )


def job_eod_close():
    """15:30 ET — close all open Kelly Cash positions."""
    if not calendar.is_open():
        return
    logger.info("Kelly Cash EOD close: liquidating all positions")
    _close_all(reason="eod_close")


def job_daily_reset():
    """4:00 AM ET — reset daily halt flag."""
    global bot_halted, start_of_day_equity
    bot_halted = False
    start_of_day_equity = executor.get_equity()
    logger.info(f"Daily reset: bot_halted=False  equity=${start_of_day_equity:,.2f}")


def _close_all(reason: str = "force_close"):
    """Sell all tracked positions."""
    snaps = {}
    if positions:
        try:
            snaps = scanner._fetch_snapshots(list(positions.keys()))
        except Exception:
            pass

    for symbol, pos in list(positions.items()):
        snap = snaps.get(symbol)
        price = 0.0
        if snap and snap.latest_trade:
            price = float(snap.latest_trade.price)
        elif snap and snap.daily_bar:
            price = float(snap.daily_bar.close)

        pnl     = pos.unrealized_pnl(price)
        pnl_pct = pos.pnl_pct(price)
        success = executor.submit_sell(symbol, pos.qty)
        if success:
            del positions[symbol]
            trade_logger.log_trade(
                symbol=symbol, action=reason, qty=pos.qty, price=price,
                pnl=pnl, pnl_pct=pnl_pct, notes=reason,
            )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def startup():
    global scanner, executor, trade_logger, calendar, start_of_day_equity

    logger.info("=" * 60)
    logger.info("KELLY CASH — HOD Breakout Bot starting up")
    logger.info(f"  Paper trading  : {config.paper}")
    logger.info(f"  Price range    : ${config.min_price}–${config.max_price}")
    logger.info(f"  Max float      : {config.max_float_M}M")
    logger.info(f"  Min change %   : {config.min_change_pct}%")
    logger.info(f"  Min rel vol    : {config.min_rel_vol_entry}x")
    logger.info("=" * 60)

    executor     = OrderExecutor(config)
    trade_logger = TradeLogger(config)
    calendar     = MarketCalendar(executor.client)
    calendar.refresh()

    scanner = ScannerDan(
        api_key    = config.api_key,
        secret_key = config.secret_key,
        min_price  = config.min_price,
        max_price  = config.max_price,
        max_float_M = config.max_float_M,
        min_rel_vol = config.min_rel_vol_entry,
        min_change_pct = config.min_change_pct,
    )

    start_of_day_equity = executor.get_equity()
    logger.info(f"Starting equity: ${start_of_day_equity:,.2f}")
    logger.info("Startup complete ✓")


def main():
    startup()

    scheduler = BlockingScheduler(timezone="America/New_York")

    scheduler.add_job(
        job_signal_loop,
        IntervalTrigger(minutes=config.signal_interval_minutes, timezone="America/New_York"),
        id="signal_loop", name="HOD Breakout Scan",
    )
    scheduler.add_job(
        job_risk_loop,
        IntervalTrigger(seconds=config.poll_interval_seconds, timezone="America/New_York"),
        id="risk_loop", name="Risk Monitor",
    )
    scheduler.add_job(
        job_eod_close,
        CronTrigger(day_of_week="mon-fri", hour=15, minute=30, timezone="America/New_York"),
        id="eod_close", name="EOD Close",
    )
    scheduler.add_job(
        job_daily_reset,
        CronTrigger(day_of_week="mon-fri", hour=4, minute=0, timezone="America/New_York"),
        id="daily_reset", name="Daily Reset",
    )

    logger.info("Kelly Cash scheduler running. Press Ctrl+C to stop.")
    logger.info(f"  Signal scan : every {config.signal_interval_minutes} min")
    logger.info(f"  Risk poll   : every {config.poll_interval_seconds} sec")
    logger.info(f"  EOD close   : 15:30 ET")

    try:
        scheduler.start()
    except KeyboardInterrupt:
        logger.info("Kelly Cash stopped by user")
        scheduler.shutdown()


if __name__ == "__main__":
    main()
