/**
 * Status indicators that never rely on color alone (FR-062, technical
 * specification: "Status must use text or shape as well as color"). Every
 * indicator renders a distinct shape glyph plus its text label; color is
 * reinforcement only.
 */
import type { Freshness, PointFlag, ProcessingLevelFlag } from './indicatorTypes';

export interface IndicatorSpec {
  shape: string;
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

const FRESHNESS: Record<Freshness, IndicatorSpec> = {
  current: { shape: '●', label: 'Reporting', tone: 'good' },
  stale: { shape: '◆', label: 'Stale', tone: 'warn' },
  inactive: { shape: '■', label: 'Inactive', tone: 'neutral' },
  'no-data': { shape: '□', label: 'No data', tone: 'neutral' },
};

const PROCESSING: Record<ProcessingLevelFlag, IndicatorSpec> = {
  raw: { shape: '○', label: 'Raw', tone: 'neutral' },
  provisional: { shape: '◐', label: 'Provisional', tone: 'warn' },
  reviewed: { shape: '●', label: 'Reviewed', tone: 'good' },
  'best-available': { shape: '◉', label: 'Best available', tone: 'good' },
};

const FLAGS: Record<PointFlag, IndicatorSpec> = {
  'out-of-range': { shape: '▲', label: 'Above valid range', tone: 'bad' },
  negative: { shape: '▼', label: 'Negative', tone: 'bad' },
  'suspect-zero': { shape: '⚑', label: 'Suspect zero', tone: 'warn' },
  'late-arrival': { shape: '⏱', label: 'Late arrival', tone: 'warn' },
  'duplicate-timestamp': { shape: '⧉', label: 'Duplicate timestamp', tone: 'warn' },
  estimated: { shape: '≈', label: 'Estimated', tone: 'warn' },
  revised: { shape: '↺', label: 'Revised', tone: 'good' },
  'null-frame': { shape: '∅', label: 'No value reported', tone: 'neutral' },
};

export function StatusIndicator({ spec, className }: { spec: IndicatorSpec; className?: string }) {
  return (
    <span className={`status-indicator tone-${spec.tone}${className ? ` ${className}` : ''}`}>
      <span className="indicator-shape" aria-hidden>
        {spec.shape}
      </span>
      {spec.label}
    </span>
  );
}

export function FreshnessIndicator({ value }: { value: Freshness }) {
  return <StatusIndicator spec={FRESHNESS[value]} />;
}

export function ProcessingIndicator({ value }: { value: ProcessingLevelFlag }) {
  return <StatusIndicator spec={PROCESSING[value]} />;
}

export function FlagIndicator({ value }: { value: PointFlag }) {
  return <StatusIndicator spec={FLAGS[value]} className="indicator-flag" />;
}

export function freshnessSpec(value: Freshness): IndicatorSpec {
  return FRESHNESS[value];
}

export function processingSpec(value: ProcessingLevelFlag): IndicatorSpec {
  return PROCESSING[value];
}

export function flagSpec(value: PointFlag): IndicatorSpec {
  return FLAGS[value];
}
