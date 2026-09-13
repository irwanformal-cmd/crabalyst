---
name: technical-analysis
description: Technical analysis playbook for market data
purpose: Compute and interpret technical indicators to form a market bias
triggers:
  - technical
  - indicators
  - rsi
  - macd
  - bollinger
  - analysis
constraints:
  - Never provide financial advice; label all output as analytical.
  - No trade execution of any kind.
required_tools:
  - technical_indicators
  - market_data
workflow:
  - Fetch market data for the requested symbol and timeframes.
  - Compute RSI, MACD, Bollinger Bands, SMA, EMA, ADX, Stochastic, ATR.
  - Read each indicator against standard interpretation thresholds.
  - Combine signals into a single bias (bullish / bearish / neutral).
  - Journal the conclusion as a prediction.
output_format: |
  A short bias statement with the key indicator readings and a confidence score.
---

# Technical Analysis

Interpret indicator readings together; do not rely on a single indicator.

- RSI > 70 is overbought; RSI < 30 is oversold.
- MACD histogram above zero is bullish momentum; below zero is bearish.
- Price above the upper Bollinger band suggests overextension; below the lower band suggests oversold.
- ADX > 25 indicates a trending market; ADX < 20 indicates ranging.
- ATR measures volatility and informs stop placement.

Cross-check the trend (SMA/EMA slope) with momentum (RSI/MACD) before concluding.
