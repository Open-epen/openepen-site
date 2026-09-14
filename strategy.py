"""
kelly_cash/strategy.py
----------------------
Kelly Cash — Trading strategy logic.

Two strategies:

1. HOD Breakout (original):
  Entry: Current price >= HOD × hod_breakout_pct
  Exit: trailing stop, take-profit, HOD breakdown, stop-loss

2. VWAP Break (Magnificent Seven focused):
  Entry: Current price >= VWAP × vwap_breakout_pct (with volume)
  Exit: profit target (10%), VWAP touch, stop-loss

Position sizing:
  If use_dynamic_sizing: scale by rel_vol (higher volume = bigger position)
  Else: fixed share_count, capped by max_position_pct
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple

from kelly_cash.config import KellyConfig

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Position state
# ---------------------------------------------------------------------------

@dataclass
class KellyPosition:
    symbol:      str
    qty:         int
    entry_price: float
    entry_time:  datetime
    strategy:    str               # "hod" or "vwap"
    
    # HOD strategy fields
    hod_at_entry: float = 0.0     # HOD at the time we entered
    
    # VWAP strategy fields
    vwap_at_entry: float = 0.0    # VWAP at entry time
    
    # Common fields
    peak_price:  float = 0.0      # tracks highest price seen since entry
    bars_held:   int   = 0

    def __post_init__(self):
        self.peak_price = self.entry_price

    def update_peak(self, current_price: float):
        if current_price > self.peak_price:
            self.peak_price = current_price

    def unrealized_pnl(self, current_price: float) -> float:
        return (current_price - self.entry_price) * self.qty

    def pnl_pct(self, current_price: float) -> float:
        if self.entry_price == 0:
            return 0.0
        return (current_price - self.entry_price) / self.entry_price

    def increment_bars(self):
        self.bars_held += 1


# ---------------------------------------------------------------------------
# Entry logic — HOD strategy
# ---------------------------------------------------------------------------

def check_entry_hod(
    symbol: str,
    price: float,
    hod: float,
    rel_vol: float,
    change_close_pct: float,
    config: KellyConfig,
    existing_positions: Dict[str, KellyPosition],
) -> Tuple[bool, str]:
    """HOD breakout entry check."""
    # Max positions guard
    if len(existing_positions) >= config.max_open_positions:
        return False, "max_positions_reached"

    # Already in this stock
    if symbol in existing_positions:
        return False, "already_in_position"

    # Price range filter
    if not (config.min_price <= price <= config.max_price):
        return False, f"price_out_of_range (${price:.2f})"

    # Must have HOD data
    if not hod or hod <= 0:
        return False, "no_hod_data"

    # HOD breakout check
    breakout_level = hod * config.hod_breakout_pct
    if price < breakout_level:
        return False, f"below_breakout_level (${breakout_level:.2f})"

    # Volume confirmation
    if rel_vol is not None and rel_vol < config.min_rel_vol_entry:
        return False, f"low_rel_vol ({rel_vol:.2f}x < {config.min_rel_vol_entry}x)"

    # Momentum confirmation
    if change_close_pct is not None and abs(change_close_pct) < config.min_change_pct:
        return False, f"weak_move ({change_close_pct:+.2f}% < {config.min_change_pct}%)"

    return True, "hod_breakout"


# ---------------------------------------------------------------------------
# Entry logic — VWAP strategy
# ---------------------------------------------------------------------------

def check_entry_vwap(
    symbol: str,
    price: float,
    vwap: float,
    rel_vol: float,
    config: KellyConfig,
    existing_positions: Dict[str, KellyPosition],
) -> Tuple[bool, str]:
    """VWAP breakout entry check."""
    # Max positions guard
    if len(existing_positions) >= config.max_open_positions:
        return False, "max_positions_reached"

    # Already in this stock
    if symbol in existing_positions:
        return False, "already_in_position"

    # Price range filter (may be wider for VWAP)
    if not (config.min_price <= price <= 500.0):  # VWAP strategy allows higher prices
        return False, f"price_out_of_range (${price:.2f})"

    # Must have VWAP data
    if not vwap or vwap <= 0:
        return False, "no_vwap_data"

    # VWAP breakout check
    breakout_level = vwap * config.vwap_breakout_pct
    if price < breakout_level:
        return False, f"below_vwap_level (${breakout_level:.2f})"

    # Volume confirmation (lower requirement than HOD)
    if rel_vol is not None and rel_vol < config.min_rel_vol_vwap:
        return False, f"low_rel_vol ({rel_vol:.2f}x < {config.min_rel_vol_vwap}x)"

    return True, "vwap_break"


# ---------------------------------------------------------------------------
# Unified entry logic
# ---------------------------------------------------------------------------

def check_entry(
    symbol: str,
    price: float,
    hod: float,
    rel_vol: float,
    change_close_pct: float,
    config: KellyConfig,
    existing_positions: Dict[str, KellyPosition],
    vwap: Optional[float] = None,
) -> Tuple[bool, str]:
    """
    Unified entry check — dispatches to strategy-specific logic.
    Returns (should_buy, reason).
    """
    if config.strategy == "vwap":
        return check_entry_vwap(symbol, price, vwap or 0, rel_vol, config, existing_positions)
    else:
        return check_entry_hod(symbol, price, hod, rel_vol, change_close_pct, config, existing_positions)


# ---------------------------------------------------------------------------
# Exit logic — HOD strategy
# ---------------------------------------------------------------------------

def check_exit_hod(
    pos: KellyPosition,
    current_price: float,
    current_hod: float,
    config: KellyConfig,
) -> Tuple[bool, str]:
    """HOD breakout exit checks."""
    # Update peak price for trailing stop
    pos.update_peak(current_price)

    # Minimum hold period
    if pos.bars_held < config.min_hold_bars:
        return False, "min_hold"

    entry = pos.entry_price
    peak  = pos.peak_price

    if entry == 0:
        return False, "invalid_entry"

    pnl_pct      = (current_price - entry) / entry
    trailing_drop = (peak - current_price) / peak if peak > 0 else 0

    # 1. Stop loss
    if pnl_pct <= -config.stop_loss_pct:
        logger.warning(
            f"{pos.symbol}: STOP LOSS — entry=${entry:.2f} "
            f"current=${current_price:.2f} pnl={pnl_pct*100:.2f}%"
        )
        return True, "stop_loss"

    # 2. Take profit
    if pnl_pct >= config.take_profit_pct:
        logger.info(
            f"{pos.symbol}: TAKE PROFIT — entry=${entry:.2f} "
            f"current=${current_price:.2f} pnl={pnl_pct*100:.2f}%"
        )
        return True, "take_profit"

    # 3. Trailing stop (only activates once we're in profit)
    if pnl_pct > 0 and trailing_drop >= config.trailing_stop_pct:
        logger.info(
            f"{pos.symbol}: TRAILING STOP — peak=${peak:.2f} "
            f"current=${current_price:.2f} drop={trailing_drop*100:.2f}%"
        )
        return True, "trailing_stop"

    # 4. HOD breakdown — if price drops below HOD by threshold after we entered above HOD
    if current_hod and current_hod > 0:
        breakdown_level = pos.hod_at_entry * (1 - config.hod_breakdown_pct)
        if current_price < breakdown_level:
            logger.info(
                f"{pos.symbol}: HOD BREAKDOWN — hod_at_entry=${pos.hod_at_entry:.2f} "
                f"breakdown=${breakdown_level:.2f} current=${current_price:.2f}"
            )
            return True, "hod_breakdown"

    return False, "hold"


# ---------------------------------------------------------------------------
# Exit logic — VWAP strategy
# ---------------------------------------------------------------------------

def check_exit_vwap(
    pos: KellyPosition,
    current_price: float,
    current_vwap: float,
    config: KellyConfig,
) -> Tuple[bool, str]:
    """VWAP strategy exit checks."""
    # Update peak price
    pos.update_peak(current_price)

    # Minimum hold period
    if pos.bars_held < config.min_hold_bars:
        return False, "min_hold"

    entry = pos.entry_price
    peak  = pos.peak_price

    if entry == 0:
        return False, "invalid_entry"

    pnl_pct = (current_price - entry) / entry

    # 1. Stop loss (more generous than HOD, e.g., 8%)
    if pnl_pct <= -config.vwap_stop_loss:
        logger.warning(
            f"{pos.symbol}: VWAP STOP LOSS — entry=${entry:.2f} "
            f"current=${current_price:.2f} pnl={pnl_pct*100:.2f}%"
        )
        return True, "vwap_stop_loss"

    # 2. Profit target (10% for VWAP strategy)
    if pnl_pct >= config.vwap_profit_target:
        logger.info(
            f"{pos.symbol}: VWAP PROFIT TARGET — entry=${entry:.2f} "
            f"current=${current_price:.2f} pnl={pnl_pct*100:.2f}%"
        )
        return True, "vwap_profit_target"

    # 3. VWAP touchback — exit if price falls back to VWAP (support/resistance flip)
    if config.vwap_exit_on_return and current_vwap > 0:
        # Exit if price fell back to VWAP after being above it
        if pnl_pct > 0 and current_price <= current_vwap:
            logger.info(
                f"{pos.symbol}: VWAP TOUCHBACK — entry=${entry:.2f} "
                f"vwap=${current_vwap:.2f} current=${current_price:.2f}"
            )
            return True, "vwap_touchback"

    return False, "hold"


# ---------------------------------------------------------------------------
# Unified exit logic
# ---------------------------------------------------------------------------

def check_exit(
    pos: KellyPosition,
    current_price: float,
    current_hod: float,
    config: KellyConfig,
    current_vwap: Optional[float] = None,
) -> Tuple[bool, str]:
    """
    Unified exit check — dispatches to strategy-specific logic.
    Returns (should_exit, reason).
    """
    if pos.strategy == "vwap":
        return check_exit_vwap(pos, current_price, current_vwap or 0, config)
    else:
        return check_exit_hod(pos, current_price, current_hod, config)


# ---------------------------------------------------------------------------
# Position sizing
# ---------------------------------------------------------------------------

def calc_shares(
    price: float,
    rel_vol: float,
    portfolio_value: float,
    config: KellyConfig,
) -> int:
    """
    Calculate shares to buy.
    Dynamic: scale by rel_vol → higher volume surge = slightly larger position.
    Always respects max_position_pct portfolio limit.
    """
    if not config.use_dynamic_sizing:
        max_dollars = portfolio_value * config.max_position_pct
        if price > max_dollars:
            return 0
        return min(config.share_count, int(max_dollars / price))

    max_dollars = portfolio_value * config.max_position_pct

    if price > max_dollars:
        logger.warning(
            f"Price ${price:.2f} exceeds max position ${max_dollars:.0f} — skipping"
        )
        return 0

    # Scale from 40% to 100% of max position based on rel_vol (2x → 10x range)
    vol_scalar = min(1.0, max(0.4, (rel_vol - 1.0) / 9.0 + 0.4)) if rel_vol else 0.4
    target = int((max_dollars * vol_scalar) / price)
    shares = max(1, target)

    logger.debug(
        f"Kelly Cash sizing: price=${price:.2f} rel_vol={rel_vol:.2f} "
        f"scalar={vol_scalar:.2f} portfolio=${portfolio_value:,.0f} → {shares} shares"
    )
    return shares
