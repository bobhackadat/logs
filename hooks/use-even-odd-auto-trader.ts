'use client';

/**
 * Maximum Power Even/Odd auto-trading hook.
 *
 * Runs the Pattern Flip Disruptor at maximum execution capacity: every single
 * WebSocket tick triggers an instant contract entry (no pacing delays, no
 * conservative filters). Purchase results feed a continuous Martingale loop —
 * WIN resets the stake to base, LOSS multiplies it by the configured
 * multiplier and fires the next contract on the very next tick. The loop also
 * halts when Target Profit or Stop Loss is hit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DerivWS, Tick } from '@deriv/core';
import {
  buildDigitWindow,
  decideNextContract,
  type EngineDirection,
  type EngineTrade,
  type PatternFlipDecision,
} from '@/lib/even-odd-engine';

const TICK_WINDOW_SIZE = 10;
const PAYOUT_PROPORTION = 0.95; // DIGITEVEN/DIGITODD payout ≈ 95% of stake

export interface EvenOddEngineStats {
  totalTrades: number;
  wins: number;
  losses: number;
  /** Realised profit/loss in USD (dynamically updating currency container). */
  profitLoss: number;
}

export interface UseEvenOddAutoTraderParams {
  ws: DerivWS | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  activeSymbol: string | null;
  pipSize: number;
  prices: number[];
  currentTick: Tick | null;
  /** Engine master switch surfaced on the dashboard. */
  enabled: boolean;
  baseStake: number;
  martingaleMultiplier: number;
  targetProfit: number;
  stopLoss: number;
}

export interface UseEvenOddAutoTraderReturn {
  stats: EvenOddEngineStats;
  trades: EngineTrade[];
  currentStake: number;
  martingaleLevel: number;
  lastDecision: PatternFlipDecision | null;
  digitWindow: number[];
  isHalted: boolean;
  haltReason: string | null;
  resetSession: () => void;
}

interface BuyResponseLike {
  buy?: { contract_id: number; buy_price: number };
  error?: { message?: string };
}

export function useEvenOddAutoTrader({
  ws,
  isConnected,
  isAuthenticated,
  activeSymbol,
  pipSize,
  prices,
  currentTick,
  enabled,
  baseStake,
  martingaleMultiplier,
  targetProfit,
  stopLoss,
}: UseEvenOddAutoTraderParams): UseEvenOddAutoTraderReturn {
  const [trades, setTrades] = useState<EngineTrade[]>([]);
  const [currentStake, setCurrentStake] = useState<number>(baseStake);
  const [martingaleLevel, setMartingaleLevel] = useState<number>(0);
  const [lastDecision, setLastDecision] = useState<PatternFlipDecision | null>(null);
  const [isHalted, setIsHalted] = useState<boolean>(false);
  const [haltReason, setHaltReason] = useState<string | null>(null);

  const realisedPLRef = useRef<number>(0);
  const currentStakeRef = useRef<number>(baseStake);
  const martingaleLevelRef = useRef<number>(0);
  const haltedRef = useRef<boolean>(false);
  const inFlightRef = useRef<boolean>(false);
  const openContractsRef = useRef<Map<number, EngineTrade>>(new Map());

  // Keep the execution stake anchored to the base stake whenever the operator
  // edits it while the engine sits at level 0 (no martingale chain active).
  useEffect(() => {
    if (martingaleLevelRef.current === 0) {
      currentStakeRef.current = baseStake;
      setCurrentStake(baseStake);
    }
  }, [baseStake]);

  const stats: EvenOddEngineStats = useMemo(
    () => ({
      totalTrades: trades.length,
      wins: trades.filter((t) => t.status === 'won').length,
      losses: trades.filter((t) => t.status === 'lost').length,
      profitLoss: realisedPLRef.current,
    }),
    [trades]
  );

  const digitWindow = useMemo(
    () => buildDigitWindow(prices, pipSize, TICK_WINDOW_SIZE),
    [prices, pipSize]
  );

  /**
   * Martingale sequence applied in the purchase/settlement callback:
   *  - WIN  -> reset execution stake to Base Stake immediately.
   *  - LOSS -> multiply previous stake by the Martingale Multiplier so the
   *            next consecutive tick fires at the recovered amount.
   */
  const settleTrade = useCallback(
    (contractId: number, status: 'won' | 'lost') => {
      const trade = openContractsRef.current.get(contractId);
      if (!trade || trade.status !== 'open') return;
      openContractsRef.current.delete(contractId);

      const profit = status === 'won' ? trade.stake * PAYOUT_PROPORTION : -trade.stake;
      const settled: EngineTrade = { ...trade, status, profit };
      realisedPLRef.current += profit;

      if (status === 'won') {
        martingaleLevelRef.current = 0;
        currentStakeRef.current = baseStake;
      } else {
        martingaleLevelRef.current += 1;
        currentStakeRef.current = Number(
          (trade.stake * martingaleMultiplier).toFixed(2)
        );
      }
      setMartingaleLevel(martingaleLevelRef.current);
      setCurrentStake(currentStakeRef.current);

      setTrades((prev) => prev.map((t) => (t.contractId === contractId ? settled : t)));

      // Capital architecture guard rails: stop the offensive loop once the
      // session target or drawdown limit is reached.
      if (targetProfit > 0 && realisedPLRef.current >= targetProfit) {
        haltedRef.current = true;
        setIsHalted(true);
        setHaltReason('Target Profit reached');
      } else if (stopLoss > 0 && realisedPLRef.current <= -Math.abs(stopLoss)) {
        haltedRef.current = true;
        setIsHalted(true);
        setHaltReason('Stop Loss reached');
      }
    },
    [baseStake, martingaleMultiplier, targetProfit, stopLoss]
  );

  // Track our own contracts via the proposal_open_contract stream so win/loss
  // settlement is independent of the manual trading hooks.
  useEffect(() => {
    if (!ws || !isConnected || !isAuthenticated) return;
    let subId: string | null = null;
    let disposed = false;

    const handler = (data: Record<string, unknown>) => {
      const poc = data.proposal_open_contract as
        | { contract_id?: number; is_sold?: number; is_won?: number; status?: string }
        | undefined;
      if (!poc || poc.contract_id === undefined) return;
      if (!openContractsRef.current.has(poc.contract_id)) return;
      const settledFlag = poc.is_sold === 1 || poc.status === 'settled' || poc.status === 'sold';
      if (!settledFlag) return;
      settleTrade(poc.contract_id, poc.is_won === 1 ? 'won' : 'lost');
    };

    ws.send({ proposal_open_contract: 1, subscribe: 1 })
      .then((res) => {
        if (disposed) {
          ws.send({ forget: (res as { subscription?: { id?: string } }).subscription?.id }).catch(() => {});
          return;
        }
        subId = (res as { subscription?: { id?: string } }).subscription?.id ?? null;
      })
      .catch(() => {});

    const off = ws.onMessage((data) => {
      if ((data.msg_type as string | undefined) !== 'proposal_open_contract') return;
      handler(data);
    });

    return () => {
      disposed = true;
      off();
      if (subId) ws.send({ forget: subId }).catch(() => {});
    };
  }, [ws, isConnected, isAuthenticated, settleTrade]);

  /** Fire an offensive EVEN/ODD contract for the given direction + stake. */
  const fireContract = useCallback(
    async (direction: EngineDirection, stake: number, epoch: number) => {
      if (!ws || !isConnected || !activeSymbol) return;
      inFlightRef.current = true;
      try {
        const res = await ws.send<BuyResponseLike>({
          buy_for_proposal: 1,
          amount: String(stake),
          basis: 'stake',
          contract_type: direction,
          currency: 'USD',
          duration: 1,
          duration_unit: 't',
          symbol: activeSymbol,
        });
        if (res.buy) {
          const trade: EngineTrade = {
            contractId: res.buy.contract_id,
            direction,
            stake,
            level: martingaleLevelRef.current,
            epoch,
            status: 'open',
            profit: 0,
          };
          // Counter incremented instantly on contract placement.
          openContractsRef.current.set(trade.contractId, trade);
          setTrades((prev) => [...prev, trade]);
        }
      } catch {
        // A rejected tick entry simply yields to the next tick — the engine
        // never pauses or throttles between attempts.
      } finally {
        inFlightRef.current = false;
      }
    },
    [ws, isConnected, activeSymbol]
  );

  // Core per-tick loop: one contract on EVERY tick — maximum execution
  // capacity, zero pacing delays.
  useEffect(() => {
    if (!enabled || !isAuthenticated || !isConnected || !ws) return;
    if (!currentTick || !activeSymbol) return;
    if (haltedRef.current || inFlightRef.current) return;
    if (digitWindow.length < 2) return;

    const decision = decideNextContract(digitWindow);
    if (!decision) return;
    setLastDecision(decision);

    void fireContract(decision.direction, currentStakeRef.current, currentTick.epoch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires exactly once per tick arrival
  }, [currentTick?.epoch]);

  const resetSession = useCallback(() => {
    realisedPLRef.current = 0;
    martingaleLevelRef.current = 0;
    currentStakeRef.current = baseStake;
    haltedRef.current = false;
    openContractsRef.current.clear();
    setTrades([]);
    setMartingaleLevel(0);
    setCurrentStake(baseStake);
    setIsHalted(false);
    setHaltReason(null);
  }, [baseStake]);

  return {
    stats,
    trades,
    currentStake,
    martingaleLevel,
    lastDecision,
    digitWindow,
    isHalted,
    haltReason,
    resetSession,
  };
}
