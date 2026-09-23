'use client';

/**
 * Trading Stats Dashboard module for the Maximum Power Even/Odd Engine.
 *
 * A dedicated, clean statistic tracking card showing:
 *  - Total Trades Taken (incremented instantly on contract placement)
 *  - Total Wins vs Total Losses
 *  - Total Profit / Loss (dynamically updating USD currency container)
 * Plus the Martingale capital-architecture inputs: Base Stake, Martingale
 * Multiplier (default 2.1x to clear Deriv asset payout spreads), Target
 * Profit and Stop Loss — and the live engine telemetry (rolling digit window,
 * streak variance, current execution stake / martingale level).
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Activity, RotateCcw, Zap } from 'lucide-react';
import type { UseEvenOddAutoTraderReturn } from '@/hooks/use-even-odd-auto-trader';

interface EvenOddDashboardProps {
  engine: UseEvenOddAutoTraderReturn;
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
  baseStake: number;
  onBaseStakeChange: (value: number) => void;
  martingaleMultiplier: number;
  onMartingaleMultiplierChange: (value: number) => void;
  targetProfit: number;
  onTargetProfitChange: (value: number) => void;
  stopLoss: number;
  onStopLossChange: (value: number) => void;
  isAuthenticated: boolean;
}

const usd = (value: number) =>
  `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;

function StatTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted/40 px-2 py-3">
      <span className={`text-lg font-bold tabular-nums ${accent ?? 'text-foreground'}`}>{value}</span>
      <span className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
  min: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const parsed = parseFloat(e.target.value);
          if (!Number.isNaN(parsed)) onChange(Math.max(min, parsed));
        }}
        className="h-8 text-sm tabular-nums"
      />
    </label>
  );
}

export function EvenOddDashboard({
  engine,
  enabled,
  onToggleEnabled,
  baseStake,
  onBaseStakeChange,
  martingaleMultiplier,
  onMartingaleMultiplierChange,
  targetProfit,
  onTargetProfitChange,
  stopLoss,
  onStopLossChange,
  isAuthenticated,
}: EvenOddDashboardProps) {
  const { stats, currentStake, martingaleLevel, lastDecision, digitWindow, isHalted, haltReason, resetSession } =
    engine;

  const plAccent = stats.profitLoss > 0 ? 'text-emerald-600 dark:text-emerald-400' : stats.profitLoss < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground';

  return (
    <Card data-testid="even-odd-dashboard" className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4 text-amber-500" />
          Even/Odd Engine — Trading Stats
          <Button
            size="sm"
            variant={enabled ? 'destructive' : 'default'}
            className="ml-auto h-7 text-xs"
            disabled={!isAuthenticated}
            onClick={() => onToggleEnabled(!enabled)}
          >
            {enabled ? 'Stop Engine' : 'Start Engine'}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={resetSession} title="Reset session stats">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Core statistics */}
        <div className="grid grid-cols-4 gap-2">
          <StatTile label="Total Trades" value={String(stats.totalTrades)} />
          <StatTile label="Wins" value={String(stats.wins)} accent="text-emerald-600 dark:text-emerald-400" />
          <StatTile label="Losses" value={String(stats.losses)} accent="text-red-600 dark:text-red-400" />
          <StatTile label="Profit / Loss" value={usd(stats.profitLoss)} accent={plAccent} />
        </div>

        {/* Martingale capital architecture inputs */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberField label="Base Stake (USD)" value={baseStake} onChange={onBaseStakeChange} step={0.5} min={0.35} />
          <NumberField label="Martingale Multiplier" value={martingaleMultiplier} onChange={onMartingaleMultiplierChange} step={0.1} min={1} />
          <NumberField label="Target Profit (USD)" value={targetProfit} onChange={onTargetProfitChange} step={1} min={0} />
          <NumberField label="Stop Loss (USD)" value={stopLoss} onChange={onStopLossChange} step={1} min={0} />
        </div>

        {/* Live engine telemetry */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 font-semibold text-foreground">
            <Activity className="h-3.5 w-3.5" />
            {isHalted ? `HALTED: ${haltReason}` : enabled ? (isAuthenticated ? 'ENGINE RUNNING' : 'LOG IN TO ARM ENGINE') : 'Engine idle'}
          </span>
          <span>
            Execution stake: <strong className="tabular-nums text-foreground">{usd(currentStake)}</strong>
          </span>
          <span>
            Martingale level: <strong className="tabular-nums text-foreground">{martingaleLevel}</strong>
          </span>
          <span>
            Last digits:{' '}
            <strong className="font-mono tabular-nums text-foreground">
              {digitWindow.length ? digitWindow.join(' ') : '—'}
            </strong>
          </span>
          {lastDecision && (
            <span className="w-full truncate">
              Signal: <strong className="text-foreground">{lastDecision.reason}</strong>
              {' · '}streak variance{' '}
              <strong className="tabular-nums text-foreground">{lastDecision.streakVariance.toFixed(2)}</strong>
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
