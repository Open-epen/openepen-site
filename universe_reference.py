"""
scanner_dan/universe.py
-----------------------
Small-cap stock universe and yfinance fundamentals cache for Scanner Dan.

Float and short interest change slowly (daily/weekly), so we fetch them
once at startup and once per day via background refresh. The scan itself
uses Alpaca for real-time price/volume data every N seconds.
"""

import logging
import threading
import time
from datetime import date
from typing import Dict, Optional

import yfinance as yf

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Seed universe — commonly active small/micro caps
# Add symbols here or via the dashboard UI to expand coverage.
# Alpaca will filter down to what's actually tradeable.
# ---------------------------------------------------------------------------
SEED_UNIVERSE = [
    # Biotech / pharma movers
    "SNDL", "CLOV", "PROG", "MVIS", "EXPR", "CRTX", "ATOS", "BFRI", "APDN",
    "SIGA", "PTGX", "IMTX", "APCX", "XELA", "ABML",
    # Small cap tech / fintech
    "BBAI", "INPX", "ILUS", "ZKIN", "GFAI", "NCTY", "VISL", "GBOX",
    "PHUN", "MMAT", "VERB", "IDEX",
    # Energy / EV
    "TELL", "INDO", "WKHS", "RIDE", "GOEV", "MULN", "FFIE", "CENN",
    # Other high-volume small caps
    "DPRO", "WTRH", "LXEH", "NXTP", "HCDI", "BODY", "SOFI", "BBIG",
    "WISH", "AMC", "KOSS", "NAKD", "SNDL", "CIDM", "ILUS",
    # Micro-cap momentum names
    "CENN", "ABML", "SFIO", "ILUS", "GBOX", "MOXC", "ANPX",
    "ILUS", "PIXY", "DPRO", "SHOT", "RCAT", "INPX",
    # Add more as you discover movers — one per line, easy to edit
    "PSUS", "SPCM", "CRVO", "CLFD", "LAIX", "TPVG",
]

# Magnificent Seven + MU (for VWAP strategy)
MAG7_PLUS_MU_UNIVERSE = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "MU"
]

# Deduplicate while preserving order
SEED_UNIVERSE = list(dict.fromkeys(SEED_UNIVERSE))
MAG7_PLUS_MU_UNIVERSE = list(dict.fromkeys(MAG7_PLUS_MU_UNIVERSE))


# ---------------------------------------------------------------------------
# Fundamentals cache
# ---------------------------------------------------------------------------

class FundamentalsCache:
    """
    Caches float shares and short interest from yfinance.
    Thread-safe; refresh runs in a background thread so the UI stays responsive.
    """

    def __init__(self):
        self._data: Dict[str, dict] = {}
        self._cache_date: Optional[date] = None
        self._lock = threading.Lock()
        self._refreshing = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, symbol: str) -> dict:
        """Return cached fundamentals for symbol. Returns empty dict if unknown."""
        with self._lock:
            return dict(self._cache_date and self._data.get(symbol) or {})

    def get_float_M(self, symbol: str) -> Optional[float]:
        return self.get(symbol).get("float_M")

    def get_short_pct(self, symbol: str) -> Optional[float]:
        return self.get(symbol).get("short_pct")

    def needs_refresh(self) -> bool:
        with self._lock:
            return self._cache_date != date.today() and not self._refreshing

    def refresh_sync(self, symbols: list) -> None:
        """Blocking refresh — used at startup before the UI opens."""
        self._do_refresh(symbols)

    def refresh_background(self, symbols: list) -> None:
        """Non-blocking refresh — called during the trading day."""
        if self._refreshing:
            return
        t = threading.Thread(target=self._do_refresh, args=(symbols,), daemon=True)
        t.start()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _do_refresh(self, symbols: list) -> None:
        with self._lock:
            self._refreshing = True

        logger.info(f"Fundamentals: fetching data for {len(symbols)} symbols...")
        new_data: Dict[str, dict] = {}

        for i, sym in enumerate(symbols):
            new_data[sym] = _fetch_one(sym)
            # Gentle rate limit — yfinance can 429 if hammered
            if i > 0 and i % 10 == 0:
                time.sleep(1.0)

        with self._lock:
            self._data = new_data
            self._cache_date = date.today()
            self._refreshing = False

        logger.info("Fundamentals: refresh complete")

    @property
    def is_ready(self) -> bool:
        with self._lock:
            return self._cache_date is not None


def _fetch_one(symbol: str) -> dict:
    """Fetch float + short interest for one symbol from yfinance."""
    try:
        info = yf.Ticker(symbol).info
        float_shares = info.get("floatShares") or info.get("sharesOutstanding")
        short_raw = info.get("shortPercentOfFloat") or 0.0
        return {
            "float_shares": float_shares,
            "float_M": round(float_shares / 1_000_000, 2) if float_shares else None,
            "short_pct": round(float(short_raw) * 100, 1) if short_raw else None,
        }
    except Exception as e:
        logger.debug(f"yfinance error {symbol}: {e}")
        return {"float_shares": None, "float_M": None, "short_pct": None}


# Singleton — import this in scanner.py and app.py
fundamentals = FundamentalsCache()
