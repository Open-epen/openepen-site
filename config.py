"""
kelly_cash/config.py
--------------------
Kelly Cash — Trading Bot configuration.

Two strategies available:
  1. HOD Breakout (original) — breaks above High of Day
  2. VWAP Break (Mag7 focused) — breaks above VWAP, exits at VWAP or 10% profit
"""

from dataclasses import dataclass, field
from typing import List
import os
from dotenv import load_dotenv

load_dotenv()

# Magnificent Seven + MU
MAG7_PLUS_MU = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "MU"
]


@dataclass
class KellyConfig:

    # ------------------------------------------------------------------
    # Alpaca credentials (same .env as the main bot)
    # ------------------------------------------------------------------
    api_key:    str = field(default_factory=lambda: os.getenv("ALPACA_API_KEY", ""))
    secret_key: str = field(default_factory=lambda: os.getenv("ALPACA_SECRET_KEY", ""))
    paper:      bool = True   # start in paper mode — flip to False when ready for live

    # ------------------------------------------------------------------
    # Strategy selection: "hod" or "vwap"
    # ------------------------------------------------------------------
    strategy: str = "vwap"  # "hod" or "vwap" — default to VWAP for Magnificent Seven

    @property
    def base_url(self) -> str:
        return (
            "https://paper-api.alpaca.markets"
            if self.paper
            else "https://api.alpaca.markets"
        )

    # ------------------------------------------------------------------
    # Universe (Scanner Dan feeds into this)
    # ------------------------------------------------------------------
    min_price:   float = 1.0    # minimum stock price
    max_price:   float = 20.0   # maximum stock price
    max_float_M: float = 100.0  # max float in millions
    
    # For VWAP strategy: use Magnificent Seven + MU
    use_mag7_only: bool = False  # if True, only trade mag7 + MU

    # ------------------------------------------------------------------
    # Entry criteria — HOD breakout (original strategy)
    # ------------------------------------------------------------------
    # Buy when: current price >= (HOD × hod_breakout_pct)
    # e.g. 1.002 = buy when price is within 0.2% above the HOD
    hod_breakout_pct: float = 1.002

    # Relative volume required to confirm breakout (prevents fake-outs)
    min_rel_vol_entry: float = 2.0

    # Minimum change from prev close to qualify as a mover worth trading
    min_change_pct: float = 5.0

    # ------------------------------------------------------------------
    # Entry criteria — VWAP break (new strategy)
    # ------------------------------------------------------------------
    # Buy when: current price >= (VWAP × vwap_breakout_pct)
    vwap_breakout_pct: float = 1.002  # e.g. 1.002 = within 0.2% above VWAP
    min_rel_vol_vwap: float = 1.5     # lower volume requirement for VWAP breakouts
    
    # ------------------------------------------------------------------
    # Position sizing
    # ------------------------------------------------------------------
    use_dynamic_sizing: bool  = True
    share_count:        int   = 10      # fixed shares (when dynamic off)
    max_position_pct:   float = 0.10    # max 10% of portfolio per trade
    max_open_positions: int   = 3       # max concurrent positions at once

    # ------------------------------------------------------------------
    # Exit criteria — HOD strategy
    # ------------------------------------------------------------------
    stop_loss_pct:    float = 0.01   # exit if down 5% from entry
    take_profit_pct:  float = 0.05   # exit if up 15% from entry
    trailing_stop_pct: float = 0.01  # trail 4% from peak price
    min_hold_bars:    int   = 2       # wait at least 2 bars before exit check

    # HOD breakdown exit: sell if price drops more than this % below HOD
    hod_breakdown_pct: float = 0.03  # sell if price is 3% below HOD after entry

    # ------------------------------------------------------------------
    # Exit criteria — VWAP strategy
    # ------------------------------------------------------------------
    # For VWAP strategy: profit target 10%, exit at VWAP
    vwap_profit_target: float = 0.10  # take profit at 10%
    vwap_stop_loss: float = 0.08      # stop loss at 8%
    # Exit at VWAP support: if price touches VWAP again, exit
    vwap_exit_on_return: bool = True  # exit if price falls back to VWAP

    # ------------------------------------------------------------------
    # Risk management
    # ------------------------------------------------------------------
    max_daily_loss: float = 0.05    # halt bot if portfolio down 5% today

    # ------------------------------------------------------------------
    # Scheduler
    # ------------------------------------------------------------------
    poll_interval_seconds:   int = 30   # risk check interval
    signal_interval_minutes: int = 5    # how often to look for new breakouts

    # ------------------------------------------------------------------
    # Session window (ET)
    # ------------------------------------------------------------------
    trade_start: str = "09:45"   # don't trade in the first 15 min (shakeout period)
    trade_end:   str = "15:30"   # close all before end of day

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------
    db_path:  str = "logs/kelly_cash.db"
    log_path: str = "logs/kelly_cash.log"


# Singleton
kelly_config = KellyConfig()
