/**
 * Bounded asynchronous export-job model (WD-008; FR-063, NFR-003).
 *
 * Technical specification: "Large exports are queued with explicit row/time
 * limits and expiring authorized downloads. Export jobs cannot outlive a
 * revoked permission without a new authorization check. Proxy protected
 * downloads through the application so each new download request checks
 * current grants; do not issue an independent reusable storage URL that
 * bypasses revocation."
 *
 * Model:
 * - Lifecycle queued -> running -> succeeded | failed (terminal).
 * - BOUNDS: the requested window must satisfy the series window cap and the
 *   estimated row count must fit MAX_EXPORT_ROWS (checked at creation with a
 *   typed rejection, so nothing is "silently truncated" - FR-063); a running
 *   job is failed by tick() or complete() once it exceeds JOB_TIME_CAP_MS.
 * - THE SAME GRANT GATE AS CHART APIS: creation, execution (complete) and
 *   every download re-run grantCheck.readStreamsGrant. A grant revoked after
 *   the artifact exists fails the job CLOSED on the next download: the job
 *   transitions to failed and the denial (403, policyReason
 *   DENY_ASSIGNMENT_REVOKED) is returned; the bytes are never handed out.
 * - DOWNLOADS EXPIRE: the manifest carries expiresAt; a later download is a
 *   typed 410 and must be re-requested.
 * - REAUTHORIZATION-ON-DOWNLOAD HOOK (for the future HTTP layer): GET
 *   /api/v1/exports/{id} must call ExportJobManager.download(jobId, actor)
 *   with the manager's injected clock - never a presigned storage URL - so the per-download grant check
 *   above cannot be bypassed. Artifacts for private records are served with
 *   Cache-Control: private, no-store by the transport.
 * - Determinism: job ids are sequence-derived and the clock is injected, so
 *   the same operation script produces byte-identical results (see tests).
 */
import { effectivePoints } from '../series/aggregate.ts';
import { checkWindow } from '../series/aggregate.ts';
import { readStreamsGrant, type ReadDenial } from '../series/grantCheck.ts';
import type { SeriesStore } from '../series/load.ts';
import type { DomainResult, EffectivePoint, ProcessingBasis } from '../series/types.ts';
import { denial } from '../series/types.ts';
import { CSV_COLUMNS, renderObservationCsv, type RenderedCsv } from './csv.ts';

export const EXPORT_LIMITS = {
  /** Hard row cap per job; larger selections are rejected, never truncated. */
  maxRows: 20_000,
  /** Wall-clock cap for a running job; exceeded -> failed(TIME_CAP). */
  jobTimeCapMs: 5 * 60 * 1000,
  /** A manifest (and its download) expires after this long. */
  downloadTtlMs: 15 * 60 * 1000,
} as const;

export type ExportJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ExportRequest {
  readonly streamIds: readonly string[];
  readonly start: string;
  readonly end: string;
  readonly basis: ProcessingBasis;
}

export interface ExportManifest {
  readonly jobId: string;
  readonly requestedBy: string | null;
  readonly streamIds: readonly string[];
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly basis: ProcessingBasis;
  readonly rowCount: number;
  readonly byteLength: number;
  readonly columns: readonly string[];
  readonly completedAt: string;
  readonly expiresAt: string;
}

export interface ExportJob {
  readonly id: string;
  readonly status: ExportJobStatus;
  readonly request: ExportRequest;
  readonly requestedBy: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failure: { code: string; message: string; status: number; policyReason?: string } | null;
  readonly estimatedRows: number;
  readonly manifest: ExportManifest | null;
}

export type ExportJobResult<T> = DomainResult<T>;

export interface ExportDownload {
  readonly csv: string;
  readonly manifest: ExportManifest;
}

export interface ExportJobDeps {
  readonly store: SeriesStore;
  /** Injected clock (ISO instant strings) - never Date.now(). */
  readonly now: () => string;
}

export class ExportJobManager {
  private readonly jobs: ExportJob[] = [];
  private readonly artifacts = new Map<string, RenderedCsv>();
  private readonly store: SeriesStore;
  private readonly now: () => string;
  private sequence = 0;

  constructor(deps: ExportJobDeps) {
    this.store = deps.store;
    this.now = deps.now;
  }

  /** All jobs in creation order (status listing for the UI). */
  list(): readonly ExportJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  job(jobId: string): ExportJob | null {
    const job = this.jobs.find((entry) => entry.id === jobId);
    return job ? { ...job } : null;
  }

  /**
   * Create a queued export job. The SAME grant gate as chart APIs runs for
   * every requested stream; bounds are checked before anything is queued.
   */
  create(request: ExportRequest, actorId: string | null): ExportJobResult<ExportJob> {
    const grants = readStreamsGrant(this.store, actorId, request.streamIds, this.now());
    if (grants.outcome === 'denied') return grants;

    if (request.streamIds.length === 0) {
      return denial(422, 'EMPTY_SELECTION', 'an export needs at least one stream');
    }
    const window = checkWindow({ start: request.start, end: request.end });
    if (window.outcome === 'denied') return window;

    let estimatedRows = 0;
    for (const streamId of request.streamIds) {
      const stream = this.store.streamById(streamId);
      if (!stream) return denial(404, 'NOT_FOUND', `stream "${streamId}" not found`);
      const lookBackMs = Math.min(stream.cadenceMinutes, 31 * 24 * 60) * 60_000;
      estimatedRows += effectivePoints(this.store, stream, window.value.startMs - lookBackMs, window.value.endMs, request.basis).length;
    }
    if (estimatedRows > EXPORT_LIMITS.maxRows) {
      return denial(
        413,
        'EXPORT_ROW_CAP_EXCEEDED',
        `estimated ${estimatedRows} rows exceed the export cap of ${EXPORT_LIMITS.maxRows}; narrow the window or streams`,
      );
    }

    this.sequence += 1;
    const job: ExportJob = {
      id: `exp-${this.sequence}`,
      status: 'queued',
      request: { ...request, streamIds: [...request.streamIds] },
      requestedBy: actorId,
      createdAt: this.now(),
      startedAt: null,
      completedAt: null,
      failure: null,
      estimatedRows,
      manifest: null,
    };
    this.jobs.push(job);
    return { outcome: 'allowed', value: { ...job } };
  }

  /** Worker picks the job up: queued -> running. */
  start(jobId: string): ExportJobResult<ExportJob> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) return denial(404, 'NOT_FOUND', `export job "${jobId}" not found`);
    if (job.status !== 'queued') {
      return denial(409, 'INVALID_STATE', `job "${jobId}" is ${job.status}, only queued jobs start`);
    }
    job.status = 'running';
    job.startedAt = this.now();
    return { outcome: 'allowed', value: { ...job } };
  }

  /**
   * Worker time-cap hook: fails a running job that exceeded JOB_TIME_CAP_MS.
   * Called by the worker loop's tick; returns the (possibly failed) job.
   */
  tick(jobId: string): ExportJobResult<ExportJob> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) return denial(404, 'NOT_FOUND', `export job "${jobId}" not found`);
    if (job.status === 'running') this.enforceTimeCap(job, this.now());
    return { outcome: 'allowed', value: { ...job } };
  }

  /**
   * Worker completes the job: re-runs the grant gate (a grant revoked while
   * queued/running fails the job closed), renders the CSV and the manifest.
   */
  complete(jobId: string): ExportJobResult<ExportJob> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) return denial(404, 'NOT_FOUND', `export job "${jobId}" not found`);
    if (job.status !== 'running') {
      return denial(409, 'INVALID_STATE', `job "${jobId}" is ${job.status}, only running jobs complete`);
    }
    const now = this.now();
    const expired = this.enforceTimeCap(job, now);
    if (expired) return expired;
    const grants = readStreamsGrant(this.store, job.requestedBy, job.request.streamIds, now);
    if (grants.outcome === 'denied') {
      return this.failClosed(job, grants);
    }
    const window = checkWindow({ start: job.request.start, end: job.request.end });
    if (window.outcome === 'denied') {
      job.status = 'failed';
      job.completedAt = this.now();
      job.failure = { code: window.code, message: window.message, status: window.status };
      return { outcome: 'denied', status: window.status, code: window.code, message: window.message };
    }
    const pointsByStream = new Map<string, EffectivePoint[]>();
    let rowCount = 0;
    for (const streamId of job.request.streamIds) {
      const stream = this.store.streamById(streamId);
      if (!stream) {
        job.status = 'failed';
        job.completedAt = this.now();
        job.failure = { code: 'NOT_FOUND', message: `stream "${streamId}" disappeared`, status: 404 };
        return denial(404, 'NOT_FOUND', `stream "${streamId}" disappeared`);
      }
      const lookBackMs = Math.min(stream.cadenceMinutes, 31 * 24 * 60) * 60_000;
      const points = effectivePoints(this.store, stream, window.value.startMs - lookBackMs, window.value.endMs, job.request.basis)
        .filter((point) => {
          const at = Date.parse(point.observedAt);
          return at >= window.value.startMs && at < window.value.endMs;
        });
      pointsByStream.set(streamId, points);
      rowCount += points.length;
    }
    if (rowCount > EXPORT_LIMITS.maxRows) {
      job.status = 'failed';
      job.completedAt = this.now();
      job.failure = { code: 'EXPORT_ROW_CAP_EXCEEDED', message: 'rendered rows exceeded the cap', status: 413 };
      return denial(413, 'EXPORT_ROW_CAP_EXCEEDED', 'rendered rows exceeded the cap');
    }
    const rendered = renderObservationCsv(
      job.request.streamIds.map((streamId) => {
        const stream = this.store.streamById(streamId)!;
        return {
          stationId: stream.stationId,
          stationDisplayName: stream.stationDisplayName,
          streamId: stream.id,
          observedPropertyId: stream.observedPropertyId,
          unitId: stream.unitId,
          points: pointsByStream.get(streamId) ?? [],
        };
      }),
    );
    const completedAt = this.now();
    const elapsed = this.enforceTimeCap(job, completedAt);
    if (elapsed) return elapsed;
    this.artifacts.set(jobId, rendered);
    job.status = 'succeeded';
    job.completedAt = completedAt;
    job.manifest = {
      jobId: job.id,
      requestedBy: job.requestedBy,
      streamIds: [...job.request.streamIds],
      windowStart: new Date(window.value.startMs).toISOString(),
      windowEnd: new Date(window.value.endMs).toISOString(),
      basis: job.request.basis,
      rowCount: rendered.rowCount,
      byteLength: rendered.byteLength,
      columns: CSV_COLUMNS,
      completedAt,
      expiresAt: new Date(Date.parse(completedAt) + EXPORT_LIMITS.downloadTtlMs).toISOString(),
    };
    return { outcome: 'allowed', value: { ...job } };
  }

  /**
   * REAUTHORIZATION-ON-DOWNLOAD: the only way to obtain the bytes. Re-runs
   * the grant gate against the CURRENT world; a revoked grant fails the job
   * closed (terminal failed) and returns the typed denial. Expired
   * manifests are a typed 410.
   */
  download(jobId: string, actorId: string | null): ExportJobResult<ExportDownload> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) return denial(404, 'NOT_FOUND', `export job "${jobId}" not found`);
    if (job.status === 'failed') {
      return denial(job.failure?.status ?? 500, job.failure?.code ?? 'EXPORT_FAILED', job.failure?.message ?? 'export failed');
    }
    if (job.status !== 'succeeded' || !job.manifest) {
      return denial(409, 'INVALID_STATE', `job "${jobId}" is ${job.status}; download requires a succeeded job`);
    }
    if (Date.parse(this.now()) >= Date.parse(job.manifest.expiresAt)) {
      return denial(410, 'DOWNLOAD_EXPIRED', 'the export manifest expired; request the export again');
    }
    // A requester losing authority invalidates its artifact. A different
    // caller's denial must not delete a still-authorized requester's job.
    const grants = readStreamsGrant(this.store, job.requestedBy, job.request.streamIds, this.now());
    if (grants.outcome === 'denied') {
      return this.failClosed(job, grants);
    }
    if (actorId !== job.requestedBy) {
      const callerGrants = readStreamsGrant(this.store, actorId, job.request.streamIds, this.now());
      if (callerGrants.outcome === 'denied') return callerGrants;
    }
    const artifact = this.artifacts.get(jobId);
    if (!artifact) {
      return denial(500, 'ARTIFACT_MISSING', 'succeeded job has no artifact');
    }
    return { outcome: 'allowed', value: { csv: artifact.csv, manifest: { ...job.manifest } } };
  }

  private enforceTimeCap(job: ExportJob, now: string): ExportJobResult<never> | null {
    if (job.startedAt === null || Date.parse(now) - Date.parse(job.startedAt) <= EXPORT_LIMITS.jobTimeCapMs) return null;
    job.status = 'failed';
    job.completedAt = now;
    job.failure = { code: 'EXPORT_TIME_CAP_EXCEEDED', message: `job exceeded ${EXPORT_LIMITS.jobTimeCapMs} ms`, status: 500 };
    this.artifacts.delete(job.id);
    return denial(job.failure.status, job.failure.code, job.failure.message);
  }

  private failClosed(job: ExportJob, grants: ReadDenial): ExportJobResult<never> {
    job.status = 'failed';
    job.completedAt = this.now();
    job.failure = { code: grants.code, message: grants.message, status: grants.status, ...(grants.policyReason ? { policyReason: grants.policyReason } : {}) };
    this.artifacts.delete(job.id);
    return {
      outcome: 'denied',
      status: grants.status,
      code: grants.code,
      message: grants.message,
      ...(grants.policyReason !== undefined ? { policyReason: grants.policyReason } : {}),
    };
  }
}
