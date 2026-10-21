/** Shared indicator value types (kept free of React imports so tests can use them). */
export type { Freshness, PointFlag } from '../shell/data/observations';
export type ProcessingLevelFlag = 'raw' | 'provisional' | 'reviewed' | 'best-available';
