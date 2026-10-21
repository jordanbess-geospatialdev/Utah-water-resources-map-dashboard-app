/**
 * AsOfPanel - the FR-044 historical as-of reconstruction view (WD-023-R2).
 *
 * "Given a supported as-of timestamp, a query returns the revisions known
 * at that timestamp and distinguishes observation time from revision time;
 * exports state the as-of basis and reproduce the fixture result after
 * later corrections."
 *
 * Pick a stream, an acting persona and an as-of instant (UTC): the panel
 * shows the T-view series with gaps where the observation was not yet
 * received at T, the visible basis block (as-of instant, basis revision,
 * excluded-later count + the same label the export embeds), and the
 * authorization states - including the hidden-object denial a cross-scope
 * actor gets on a restricted stream.
 *
 * Mountable, shell-free component (WD-023-R2 must not edit the shell's
 * App.tsx): the demo loader assembles the T-view from the fixture-mirrored
 * constants in extensionsModel; an API-backed loader replaces it through
 * the `loader` prop without touching this component.
 */
import { useMemo, useState, type FormEvent } from 'react';
import {
  DEMO_PERSONAS,
  DEMO_STREAMS,
  asOfBasisLabel,
  asOfRows,
  demoAsOfLoad,
  excludedLaterNote,
  formatInstantUtc,
  type AsOfDecisionView,
  type AsOfSeriesView,
} from './extensionsModel';

export interface AsOfPanelProps {
  /** Streams offered by the picker (demo defaults mirror the fixtures). */
  readonly streams?: typeof DEMO_STREAMS;
  /** Acting personas; the server decides authorization, the panel only displays it. */
  readonly personas?: typeof DEMO_PERSONAS;
  /** API-backed loader; defaults to the deterministic demo assembly. */
  readonly loader?: (streamId: string, personaId: string, asOfUtc: string) => AsOfDecisionView;
}

const DEFAULT_AS_OF = '2026-03-08T15:30'; // the exact rev-corinne-2001 boundary instant (UTC)

type PanelState =
  | { kind: 'idle' }
  | { kind: 'ready'; series: AsOfSeriesView }
  | { kind: 'denied'; status: number; code: string; message: string }
  | { kind: 'error'; message: string };

export default function AsOfPanel({ streams = DEMO_STREAMS, personas = DEMO_PERSONAS, loader }: AsOfPanelProps) {
  const [streamId, setStreamId] = useState(streams[0]?.id ?? '');
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? '');
  const [asOfLocal, setAsOfLocal] = useState(DEFAULT_AS_OF);
  const [state, setState] = useState<PanelState>({ kind: 'idle' });

  const rows = useMemo(() => (state.kind === 'ready' ? asOfRows(state.series) : []), [state]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // datetime-local carries no zone; the label states UTC and we send it as UTC.
    const asOfUtc = `${asOfLocal.length === 16 ? `${asOfLocal}:00` : asOfLocal}Z`;
    try {
      const decision = loader ? loader(streamId, personaId, asOfUtc) : demoAsOfLoad(streamId, personaId, asOfUtc);
      if (decision.outcome === 'ok') setState({ kind: 'ready', series: decision });
      else setState({ kind: 'denied', status: decision.status, code: decision.code, message: decision.message });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section className="panel" aria-label="As-of reconstruction">
      <div className="panel-heading">
        <div>
          <h2>As-of reconstruction</h2>
          <span>
            Observation state as known at a chosen instant · recorded-time boundary closed on T · later revisions excluded and counted ·
            exports embed the basis label
          </span>
        </div>
        <span className="mini-pill">FR-044</span>
      </div>

      <form onSubmit={onSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '10px 19px', alignItems: 'flex-end' }}>
        <div>
          <label htmlFor="asof-stream" style={{ display: 'block', fontSize: 10 }}>
            Stream
          </label>
          <select id="asof-stream" value={streamId} onChange={(event) => setStreamId(event.target.value)} style={{ fontSize: 11 }}>
            {streams.map((stream) => (
              <option key={stream.id} value={stream.id}>
                {stream.label} · {stream.visibility}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="asof-persona" style={{ display: 'block', fontSize: 10 }}>
            Acting persona
          </label>
          <select id="asof-persona" value={personaId} onChange={(event) => setPersonaId(event.target.value)} style={{ fontSize: 11 }}>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="asof-instant" style={{ display: 'block', fontSize: 10 }}>
            As-of instant (UTC)
          </label>
          <input
            id="asof-instant"
            type="datetime-local"
            value={asOfLocal}
            onChange={(event) => setAsOfLocal(event.target.value)}
            style={{ fontSize: 11 }}
          />
        </div>
        <button type="submit" className="button small">
          Reconstruct
        </button>
      </form>

      <p role="status" aria-live="polite" className="sr-only">
        {state.kind === 'ready'
          ? `T-view assembled: ${state.series.knownCount} known points, ${state.series.gapCount} gaps.`
          : state.kind === 'denied'
            ? `As-of query denied (${state.code}).`
            : state.kind === 'error'
              ? `As-of query failed: ${state.message}`
              : 'No as-of query run yet.'}
      </p>

      {state.kind === 'idle' && (
        <p style={{ padding: '10px 19px', fontSize: 10, color: '#7b8982', margin: 0 }}>
          Pick a stream and an as-of instant, then reconstruct. Try 2026-03-08 15:30 UTC - the exact instant the Corinne correction was
          recorded - or one second earlier to see the raw spike that was known before it.
        </p>
      )}

      {state.kind === 'denied' && (
        <p style={{ padding: '10px 19px', fontSize: 10, color: '#8a4b3c', margin: 0 }}>
          <strong>
            Denied {state.status} {state.code}
          </strong>{' '}
          — {state.message}. Restricted streams stay hidden from out-of-scope actors: the denial never confirms the data exists.
        </p>
      )}

      {state.kind === 'error' && (
        <p style={{ padding: '10px 19px', fontSize: 10, color: '#8a4b3c', margin: 0 }}>
          <strong>Query failed</strong> — {state.message}
        </p>
      )}

      {state.kind === 'ready' && (
        <>
          <div
            aria-label="As-of basis"
            style={{
              margin: '0 19px 10px',
              padding: '8px 10px',
              border: '1px solid #e9ede8',
              borderRadius: 6,
              fontSize: 10,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 14,
            }}
          >
            <span>
              <strong>As-of (UTC):</strong> {formatInstantUtc(state.series.basis.asOf)}
            </span>
            <span>
              <strong>Basis revision:</strong> {state.series.basis.latestConsideredRevisionId ?? 'raw original'}
            </span>
            <span>
              <strong>Excluded later:</strong> {excludedLaterNote(state.series.basis)}
            </span>
            <span>
              <strong>Export label:</strong> <code>{asOfBasisLabel(state.series.basis)}</code>
            </span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="site-table">
              <caption className="sr-only">
                T-view series for {state.series.streamId}: each observation&apos;s state as known at the as-of instant, with gaps where
                nothing had been received yet.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Observed (UTC)</th>
                  <th scope="col">State</th>
                  <th scope="col">Value</th>
                  <th scope="col">Level</th>
                  <th scope="col">Qualifiers</th>
                  <th scope="col">Revision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={row.isGap ? 'muted' : undefined}>
                    <th scope="row">{row.observedAt}</th>
                    <td>
                      <span aria-hidden style={{ marginRight: 5, fontWeight: 700 }}>
                        {row.marker}
                      </span>
                      {row.stateText}
                      {row.isGap ? ' · not received by as-of' : ''}
                    </td>
                    <td>{row.valueText}</td>
                    <td>{row.levelText}</td>
                    <td>{row.qualifierText}</td>
                    <td>{row.revisionText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ padding: '10px 19px', fontSize: 9, color: '#9caa97', margin: 0 }}>
            {state.series.knownCount} known · {state.series.gapCount} gaps · window {formatInstantUtc(state.series.from)} to{' '}
            {formatInstantUtc(state.series.to)}. The T-view reproduces after later corrections: a correction recorded after the as-of
            instant never moves it.
          </p>
        </>
      )}
    </section>
  );
}
