/**
 * Position sizing and risk management helpers. Analytical only — no order
 * execution, no broker integration.
 */

export interface PositionSizeInput {
  accountEquity: number;
  entryPrice: number;
  stopLoss: number;
  /** Fraction of equity to risk per trade (e.g. 0.01 = 1%). */
  riskPercent: number;
}

export interface PositionSizeResult {
  /** Quantity of the asset to buy. */
  positionSize: number;
  riskAmount: number;
  stopDistance: number;
  stopDistancePct: number;
}

export function positionSize(input: PositionSizeInput): PositionSizeResult {
  const riskAmount = input.accountEquity * input.riskPercent;
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  const stopDistancePct = stopDistance / input.entryPrice;
  const size = stopDistance === 0 ? 0 : riskAmount / stopDistance;
  return { positionSize: size, riskAmount, stopDistance, stopDistancePct };
}

export interface RiskRewardInput {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export interface RiskRewardResult {
  riskPerUnit: number;
  rewardPerUnit: number;
  riskRewardRatio: number;
  breakevenWinRate: number;
}

export function riskReward(input: RiskRewardInput): RiskRewardResult {
  const risk = Math.abs(input.entryPrice - input.stopLoss);
  const reward = Math.abs(input.takeProfit - input.entryPrice);
  const rr = risk === 0 ? Infinity : reward / risk;
  return {
    riskPerUnit: risk,
    rewardPerUnit: reward,
    riskRewardRatio: rr,
    breakevenWinRate: risk === 0 ? 0 : 1 / (1 + reward / risk),
  };
}

export function atrStopLoss(entryPrice: number, atrValue: number, multiplier = 2): number {
  return entryPrice - atrValue * multiplier;
}

export function atrTakeProfit(entryPrice: number, atrValue: number, rrRatio = 2, multiplier = 2): number {
  const risk = atrValue * multiplier;
  return entryPrice + risk * rrRatio;
}
