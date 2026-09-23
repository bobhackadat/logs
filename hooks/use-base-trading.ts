'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useActiveSymbols, useTicks } from '@deriv/core';
import type { DerivWS, ActiveSymbol, Tick, DurationLimits, ContractInfo } from '@deriv/core';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { useOpenPositions, type OpenPosition } from './use-open-positions';
import { useClosedPositions, type ClosedPosition } from './use-closed-positions';
import { useSellContract } from './use-sell-contract';

export interface UseBaseTradingParams {
  /** Shared WebSocket instance from DerivWSProvider. */
  ws: DerivWS | null;
  isConnected: boolean;
  /** True when the WS has exhausted all reconnect attempts. */
  isExhausted?: boolean;
  /** True when the user is authenticated (wsUrl is set). Used to gate auth-only calls. */
  isAuthenticated: boolean;
  onAuthWSFailed?: () => void;
  /** Contract types used to filter available symbols and duration limits. */
  contractTypes: string[];
}

export interface UseBaseTradingReturn {
  /** Underlying WebSocket instance — pass to useBuy / useProposal in the template. */
  ws: DerivWS | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  symbols: ActiveSymbol[];
  activeSymbol: ActiveSymbol | null;
  selectSymbol: (symbol: string) => void;
  currentTick: Tick | null;
  /** Raw price history — useful for chart rendering and stat computation. */
  prices: number[];
  pipSize: number;
  /** Last-10-tick rolling window maintained from live WebSocket ticks. */
  enginePrices: number[];
  /** Latest tick epoch — identity key for per-tick engine loops. */
  currentTickEpoch: number | null;
  contracts: ContractInfo[];
  contractsAvailable: boolean;
  durationLimits: DurationLimits;
  defaultStake: number;
  openPositions: OpenPosition[];
  closedPositions: ClosedPosition[];
  refreshClosedPositions: () => Promise<void>;
  sellContract: (contractId: number, bidPrice: string) => Promise<void>;
  sellingId: number | null;
  sellError: string | null;
  clearSellError: () => void;
}

/**
 * Generic trading foundation shared across all template types.
 *
 * Accepts the shared WS instance from DerivWSProvider rather than creating its
 * own, so the connection persists across page navigations.
 */
export function useBaseTrading({
  ws,
  isConnected,
  isExhausted,
  isAuthenticated,
  onAuthWSFailed,
  contractTypes,
}: UseBaseTradingParams): UseBaseTradingReturn {
  const { localize } = useAppTranslations();

  // When the authenticated WS exhausts all reconnect attempts, fall back to
  // the public WS by triggering logout.
  useEffect(() => {
    if (isExhausted && ws) {
      onAuthWSFailed?.();
    }
  }, [isExhausted, ws, onAuthWSFailed]);

  const {
    symbols,
    activeSymbol,
    selectSymbol,
    contracts,
    contractsAvailable,
    durationLimits,
    defaultStake,
    isLoading: symbolsLoading,
  } = useActiveSymbols(ws, isConnected, contractTypes);

  const { currentTick, prices: tickPrices, pipSize } = useTicks(ws, isConnected, activeSymbol);

  // Rolling window of the last 10 ticks maintained from real-time WebSocket
  // tick events. The engine reads this synchronously (via ref) so every single
  // tick is captured for the Pattern Flip Disruptor without render lag.
  const tickWindowRef = useRef<number[]>([]);
  const [tickWindowVersion, setTickWindowVersion] = useState(0);
  useEffect(() => {
    if (!currentTick) return;
    tickWindowRef.current = [...tickWindowRef.current, currentTick.quote].slice(-10);
    setTickWindowVersion((v) => v + 1);
  }, [currentTick]);
  // Reset the rolling window when the symbol stream restarts.
  useEffect(() => {
    tickWindowRef.current = [];
  }, [activeSymbol?.underlying_symbol]);
  const enginePrices = useMemo(
    () => tickWindowRef.current.slice(-10),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version bumps on every captured tick
    [tickWindowVersion]
  );
  // Fall back to the history-backed prices until enough live ticks arrive.
  const prices = enginePrices.length >= 2 ? enginePrices : tickPrices;

  // Surface WS-level errors as toasts. Buy and sell errors are handled by
  // their own hooks and are excluded here to avoid double-reporting.
  useEffect(() => {
    if (!ws || !isConnected) return;
    return ws.onMessage(data => {
      if (!data.error) return;
      const msgType = data.msg_type as string | undefined;
      if (msgType === 'buy' || msgType === 'sell') return;
      const err = data.error as Record<string, string>;
      // A duplicate subscription is an internal stream-lifecycle event that the
      // subscription layer recovers from on its own, so it is a developer
      // signal rather than an app error. Matched on the code only — the message
      // is server-localized and interpolates the symbol.
      if (err.code === 'AlreadySubscribed') {
        console.warn('[useBaseTrading] duplicate subscription reported by the API', {
          code: err.code,
          msgType,
          message: err.message,
        });
        return;
      }
      toast.error(localize('Error'), {
        // API message when present; app-authored fallback otherwise.
        description: err.message ?? localize('Unexpected error occurred. Please try again.'),
      });
    });
  }, [ws, isConnected, localize]);

  const { positions: openPositions } = useOpenPositions(ws, isConnected, isAuthenticated);

  const { positions: closedPositions, refresh: refreshClosedPositions } = useClosedPositions(
    ws,
    isConnected,
    isAuthenticated
  );

  const {
    sellContract: sellContractRaw,
    sellingId,
    sellError,
    clearSellError,
  } = useSellContract(ws, isConnected);

  // Refresh the closed-positions table after each successful sell.
  const sellContract = useCallback(
    async (contractId: number, bidPrice: string) => {
      await sellContractRaw(contractId, bidPrice);
      await refreshClosedPositions();
    },
    [sellContractRaw, refreshClosedPositions]
  );

  return {
    ws,
    isConnected,
    isLoading: !isConnected || symbolsLoading,
    error: null,
    symbols,
    activeSymbol,
    selectSymbol,
    currentTick,
    prices,
    enginePrices,
    currentTickEpoch: currentTick?.epoch ?? null,
    pipSize,
    contracts,
    contractsAvailable,
    durationLimits,
    defaultStake,
    openPositions,
    closedPositions,
    refreshClosedPositions,
    sellContract,
    sellingId,
    sellError,
    clearSellError,
  };
}
