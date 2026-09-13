---
name: risk-management
description: Position sizing and risk control playbook
purpose: Size positions and set stops/targets using ATR and risk/reward
triggers:
  - risk
  - position size
  - stop loss
  - take profit
  - risk reward
constraints:
  - Analytical sizing only — never place orders.
  - Never risk more than the configured percentage per trade.
required_tools:
  - risk_calculator
workflow:
  - Determine account equity and entry price.
  - Compute an ATR-based stop loss (default 2x ATR).
  - Set take profit to target a minimum 2:1 reward/risk ratio.
  - Size the position so the loss at the stop equals the chosen risk percent.
  - Report position size, stop, target, R:R and breakeven win rate.
output_format: A risk summary table with position size and stop/target levels.
---

# Risk Management

Always compute risk before reward:

1. Risk amount = account equity × risk percent (default 1%).
2. Stop distance = entry − stop loss.
3. Position size = risk amount / stop distance.
4. Reward/risk = (take profit − entry) / (entry − stop loss).

Keep reward/risk ≥ 2 when possible. Respect the stop; do not widen it after sizing.
