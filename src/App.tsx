import { useState, useEffect, Fragment, type ReactNode } from 'react';
import { kvGet, kvSet, kvDelete } from './kv';

// These globals are injected by the Cribl platform at runtime.
// See AGENTS.md for the full list of platform-provided globals.
declare global {
  interface Window {
    CRIBL_API_URL?: string;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

// Search job lifecycle: idle → submitting → polling → done (or error at any step)
type SearchPhase = 'idle' | 'submitting' | 'polling' | 'done' | 'error';

interface ChartRow {
  label: string;
  value: number;
}

interface CurrentWeather {
  temperature: number;
  windspeed: number;
  weathercode: number;
}

// Map WMO weather codes to a human-readable label and emoji.
function describeWeather(code: number): { label: string; icon: string } {
  if (code === 0)            return { label: 'Clear sky',      icon: '☀️' };
  if (code <= 3)             return { label: 'Partly cloudy',  icon: '⛅' };
  if (code <= 48)            return { label: 'Foggy',          icon: '🌫️' };
  if (code <= 55)            return { label: 'Drizzle',        icon: '🌦️' };
  if (code <= 65)            return { label: 'Rain',           icon: '🌧️' };
  if (code <= 77)            return { label: 'Snow',           icon: '❄️' };
  if (code <= 82)            return { label: 'Rain showers',   icon: '🌦️' };
  if (code <= 86)            return { label: 'Snow showers',   icon: '🌨️' };
  return                            { label: 'Thunderstorm',   icon: '⛈️' };
}

// ─── Pipeline complexity types and helpers ────────────────────────────────────

interface PipelineFunction {
  id?: string;
  // Functions can theoretically nest (e.g. future composite types)
  functions?: PipelineFunction[];
}

interface Pipeline {
  id: string;
  conf?: {
    functions?: PipelineFunction[];
  };
}

interface PipelineRow {
  id: string;
  count: number;
}

// Recursively count every function entry in the array and any nested arrays.
function walkFns(fns: PipelineFunction[]): number {
  return fns.reduce<number>((sum, fn) => {
    const nested = Array.isArray(fn.functions) ? walkFns(fn.functions) : 0;
    return sum + 1 + nested;
  }, 0);
}

function countFunctions(pipeline: Pipeline): number {
  return walkFns(pipeline.conf?.functions ?? []);
}

interface Settings {
  greeting: string;
  developerName: string;
  favoriteProduct: string;
}

// KV keys used by this app — listed here so they're easy to find
const KV_COUNTER = 'counter';
const KV_SETTINGS = 'settings';

const DEFAULT_SETTINGS: Settings = {
  greeting: 'Hello, Cribl!',
  developerName: '',
  favoriteProduct: 'Stream',
};

// ─── Small layout component ───────────────────────────────────────────────────

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`section${className ? ` ${className}` : ''}`}>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function App() {
  // Section 2 — counter
  const [count, setCount] = useState(0);
  const [countLoaded, setCountLoaded] = useState(false);

  // Section 3 — settings
  // `settings` = last-saved value (shown in the preview)
  // `form`     = current form state (may differ before Save is clicked)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Section 4 — platform API demo
  const [groups, setGroups] = useState<string[] | null>(null);
  const [groupsStatus, setGroupsStatus] = useState<'loading' | 'ok' | 'error'>('loading');

  // Section 5 — weather widget (external API via proxy)
  const [weather, setWeather] = useState<CurrentWeather | null>(null);
  const [weatherStatus, setWeatherStatus] = useState<'loading' | 'ok' | 'error'>('loading');

  // Section 7 — Cribl Stream pipeline complexity
  const [topPipelines, setTopPipelines] = useState<PipelineRow[]>([]);
  const [pipelinesStatus, setPipelinesStatus] = useState<'loading' | 'done' | 'empty' | 'error'>('loading');

  // Section 6 — Cribl Search visualization
  const [searchPhase, setSearchPhase] = useState<SearchPhase>('idle');
  const [chartRows, setChartRows] = useState<ChartRow[]>([]);
  const [searchErrMsg, setSearchErrMsg] = useState('');

  // The query uses the `range` operator — a data-generating operator that
  // creates rows from scratch with no dataset or existing data required.
  const SEARCH_QUERY = 'range n from 1 to 8 | extend value = n * 15';

  async function runSearch() {
    const base = window.CRIBL_API_URL;
    if (!base) {
      setSearchPhase('error');
      setSearchErrMsg('CRIBL_API_URL is not set. This feature requires the app to be running inside Cribl.');
      return;
    }

    setSearchPhase('submitting');
    setChartRows([]);
    setSearchErrMsg('');

    try {
      // Step 1: Create the search job.
      // Search endpoints always use the `default_search` group — see AGENTS.md.
      const createRes = await fetch(`${base}/m/default_search/search/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: SEARCH_QUERY,
          earliest: '-15m',
          latest: 'now',
          sampleRate: 1,
        }),
      });
      if (!createRes.ok) throw new Error(`Job creation failed (HTTP ${createRes.status})`);

      const createData = await createRes.json() as { items?: Array<{ id: string }> };
      const jobId = createData.items?.[0]?.id;
      if (!jobId) throw new Error('No job ID returned from search API');

      // Step 2: Poll the status endpoint every second until completed (max 20s).
      setSearchPhase('polling');
      let completed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));
        const statusRes = await fetch(`${base}/m/default_search/search/jobs/${jobId}/status`);
        if (!statusRes.ok) throw new Error(`Status check failed (HTTP ${statusRes.status})`);
        const statusData = await statusRes.json() as { items?: Array<{ status: string }> };
        const status = statusData.items?.[0]?.status;
        if (status === 'completed') { completed = true; break; }
        if (status === 'failed') throw new Error('Search job reported failure');
      }
      if (!completed) throw new Error('Search timed out after 20 seconds');

      // Step 3: Fetch results. The response is NDJSON — one JSON object per line.
      // The very first line is a metadata object; skip it and parse the data rows.
      const resultsRes = await fetch(
        `${base}/m/default_search/search/jobs/${jobId}/results?offset=0&limit=50`,
        { headers: { Accept: 'application/x-ndjson' } }
      );
      if (!resultsRes.ok) throw new Error(`Results fetch failed (HTTP ${resultsRes.status})`);

      const text = await resultsRes.text();
        const rows: ChartRow[] = text
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(1)  // first line is metadata, not a data row
        .map((line) => {
          const row = JSON.parse(line) as { n?: number; value?: number };
          return { label: String(row.n ?? '?'), value: Number(row.value ?? 0) };
        });

      setChartRows(rows);
      setSearchPhase('done');
    } catch (err) {
      setSearchErrMsg(err instanceof Error ? err.message : String(err));
      setSearchPhase('error');
    }
  }

  // Load counter from KV when the app mounts
  useEffect(() => {
    kvGet<number>(KV_COUNTER).then((val) => {
      setCount(val ?? 0);
      setCountLoaded(true);
    });
  }, []);

  // Load settings from KV when the app mounts
  useEffect(() => {
    kvGet<Settings>(KV_SETTINGS).then((val) => {
      if (val) {
        setSettings(val);
        setForm(val);
      }
    });
  }, []);

  // Platform API demo — list config groups (read-only, graceful failure).
  // This call may fail for users without the required role, or when running
  // in local dev mode where CRIBL_API_URL is not set. Either way the rest
  // of the app keeps working.
  useEffect(() => {
    if (!window.CRIBL_API_URL) {
      setGroupsStatus('error');
      return;
    }
    fetch(`${window.CRIBL_API_URL}/master/groups`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ items?: Array<{ id: string }> }>;
      })
      .then((data) => {
        setGroups((data.items ?? []).map((g) => g.id));
        setGroupsStatus('ok');
      })
      .catch(() => setGroupsStatus('error'));
  }, []);

  // Weather widget — calls Open-Meteo with the full external URL.
  // Inside Cribl the platform rewrites this fetch to route through the app's
  // proxy (declared in config/proxies.yml). In local dev it goes directly to
  // the API — Open-Meteo supports CORS so both modes work.
  useEffect(() => {
    const SF_LAT = 37.7749;
    const SF_LON = -122.4194;
    fetch(
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${SF_LAT}&longitude=${SF_LON}&current_weather=true`
    )
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ current_weather: CurrentWeather }>;
      })
      .then((data) => {
        setWeather(data.current_weather);
        setWeatherStatus('ok');
      })
      .catch(() => setWeatherStatus('error'));
  }, []);

  // Cribl Stream pipeline complexity panel.
  // Step 1: resolve a worker group from /master/groups.
  // Step 2: fetch /m/{groupId}/pipelines and rank by function count.
  // Any failure (no CRIBL_API_URL, no groups, 403, 404) shows the amber note.
  useEffect(() => {
    const base = window.CRIBL_API_URL;
    if (!base) {
      setPipelinesStatus('error');
      return;
    }

    async function load() {
      try {
        // Resolve a worker group — pick the first group that isn't the search group
        const groupsRes = await fetch(`${base}/master/groups`);
        if (!groupsRes.ok) throw new Error(`HTTP ${groupsRes.status}`);
        const groupsData = await groupsRes.json() as { items?: Array<{ id: string }> };
        const allGroups = groupsData.items ?? [];
        const workerGroup = allGroups.find((g) => g.id !== 'default_search') ?? allGroups[0];
        if (!workerGroup) throw new Error('No config groups found');

        // Fetch all pipelines from that group
        const pipesRes = await fetch(`${base}/m/${workerGroup.id}/pipelines`);
        if (!pipesRes.ok) throw new Error(`HTTP ${pipesRes.status}`);
        const pipesData = await pipesRes.json() as { items?: Pipeline[] };

        const ranked: PipelineRow[] = (pipesData.items ?? [])
          .map((p) => ({ id: p.id, count: countFunctions(p) }))
          .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
          .slice(0, 5);

        if (ranked.length === 0) {
          setPipelinesStatus('empty');
        } else {
          setTopPipelines(ranked);
          setPipelinesStatus('done');
        }
      } catch {
        setPipelinesStatus('error');
      }
    }

    void load();
  }, []);

  // ── Counter actions ──

  const increment = async () => {
    const next = count + 1;
    setCount(next);          // update UI immediately
    await kvSet(KV_COUNTER, next);
  };

  const resetCounter = async () => {
    setCount(0);
    await kvDelete(KV_COUNTER);
  };

  // ── Settings actions ──

  const saveSettings = async () => {
    setSaving(true);
    await kvSet(KV_SETTINGS, form);
    setSettings(form);       // commit form to saved state
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveBtnLabel = saving ? 'Saving…' : saved ? 'Saved!' : 'Save settings';

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <div className="app-inner">

        {/* ── Section 1: Welcome ── */}
        <Section title="Hello Cribl App" className="span-2">
          <p className="body-text">
            This is a working example of a <strong>Cribl App</strong> — a small web application
            that runs inside the Cribl platform in a sandboxed iframe. It has its own UI, can call
            Cribl REST APIs, and can persist data using the platform KV store.
          </p>
          <p className="body-text">
            This reference app is intentionally small. Each section below demonstrates one core concept.
          </p>
          <div className="info-block">
            <h3 className="info-title">What this app teaches</h3>
            <ul className="bullet-list">
              <li>Apps run inside Cribl in a sandboxed iframe</li>
              <li>Apps can have interactive UI built with React (or any framework)</li>
              <li>Apps can persist simple state using the platform KV store</li>
              <li>Apps can call external APIs by declaring them in <code>proxies.yml</code></li>
              <li>Apps build upon Cribl by calling APIs across the Cribl product suite</li>
            </ul>
          </div>
        </Section>

        {/* ── Section 2: Counter ── */}
        <Section title="Interactive Counter">
          <p className="body-text muted">
            Click <strong>Increment</strong> to increase the counter. The value is written to the
            Cribl KV store on every click, so it survives page refreshes.
          </p>
          <div className="counter-center">
            <span className="count-value">
              {countLoaded ? count : <span className="count-loading">…</span>}
            </span>
            <div className="btn-group">
              <button className="btn btn-primary btn-lg" onClick={increment}>Increment</button>
              <button className="btn btn-ghost btn-lg" onClick={resetCounter}>Reset</button>
            </div>
          </div>
          <p className="hint">
            KV key: <code>counter</code> — written via{' '}
            <code>PUT {'${CRIBL_API_URL}'}/kvstore/counter</code>
          </p>
        </Section>

        {/* ── Section 3: Settings ── */}
        <Section title="App Settings">
          <p className="body-text muted">
            These settings are also persisted in the KV store as a single JSON object.
            Edit the fields and click <strong>Save settings</strong>.
          </p>
          <div className="settings-form">
            <label className="field-label">
              Greeting
              <input
                className="field-input"
                value={form.greeting}
                onChange={(e) => setForm({ ...form, greeting: e.target.value })}
                placeholder="Hello, Cribl!"
              />
            </label>
            <label className="field-label">
              Your name
              <input
                className="field-input"
                value={form.developerName}
                onChange={(e) => setForm({ ...form, developerName: e.target.value })}
                placeholder="Developer name"
              />
            </label>
            <label className="field-label">
              Favorite Cribl product
              <select
                className="field-input"
                value={form.favoriteProduct}
                onChange={(e) => setForm({ ...form, favoriteProduct: e.target.value })}
              >
                <option value="Stream">Stream</option>
                <option value="Search">Search</option>
                <option value="Lake">Lake</option>
                <option value="Edge">Edge</option>
              </select>
            </label>
            <div>
              <button
                className={`btn btn-primary${saving ? ' btn-disabled' : ''}`}
                onClick={saveSettings}
                disabled={saving}
              >
                {saveBtnLabel}
              </button>
            </div>
          </div>

          {/* Live preview of saved values */}
          {settings.developerName && (
            <div className="settings-preview">
              <strong>{settings.greeting}</strong>
              {' '}— written by <em>{settings.developerName}</em>,
              fan of Cribl {settings.favoriteProduct}.
            </div>
          )}

          <p className="hint">
            KV key: <code>settings</code> — a single JSON object stored with one{' '}
            <code>PUT</code> call
          </p>
        </Section>

        {/* ── Section 4: Platform API demo ── */}
        <Section title="Platform API — Config Groups">
          <p className="body-text muted">
            This section makes one read-only call to{' '}
            <code>GET {'${CRIBL_API_URL}'}/master/groups</code> to list config group IDs.
            No input is required. It may not succeed for all users depending on their role —
            if it fails, the rest of the app keeps working normally.
          </p>

          <div className="groups-center">
            {groupsStatus === 'loading' && (
              <p className="hint italic">Loading config groups…</p>
            )}

            {groupsStatus === 'error' && (
              <div className="note-amber">
                This example depends on access your current user may not have, or requires
                the app to be running inside Cribl (not in local dev mode).
                The rest of the app still works.
              </div>
            )}

            {groupsStatus === 'ok' && groups && (
              groups.length === 0 ? (
                <p className="hint italic">No config groups found.</p>
              ) : (
                <div className="groups-viz-panel">
                  <div className="groups-viz">
                    {groups.map((g, i) => (
                      <Fragment key={g}>
                        {i > 0 && <div className="group-connector" />}
                        <div className="group-node">
                          <div className="group-node-dots">
                            <span className="group-dot dot-red" />
                            <span className="group-dot dot-yellow" />
                            <span className="group-dot dot-green" />
                          </div>
                          <span className="group-node-name">{g}</span>
                          <div className="group-status">
                            <span className="group-status-dot" />
                            <span className="group-status-label">online</span>
                          </div>
                        </div>
                      </Fragment>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
        </Section>

        {/* ── Section 5: Weather widget — external API via proxy ── */}
        <Section title="External API — San Francisco Weather">
          <p className="body-text muted">
            This section calls{' '}
            <a href="https://open-meteo.com" target="_blank" rel="noopener noreferrer">
              Open-Meteo
            </a>
            {' '}— a free, no-key weather API — to show how external calls work in a Cribl App.
          </p>
          <div className="info-block">
            <h3 className="info-title">How external calls work</h3>
            <ol className="numbered-list">
              <li>
                Declare the domain in <code>config/proxies.yml</code> (already done for{' '}
                <code>api.open-meteo.com</code>)
              </li>
              <li>
                Call <code>fetch()</code> with the full external URL — no special wrapper needed
              </li>
              <li>
                Inside Cribl, the platform rewrites the URL to route through your app's proxy
                endpoint and enforces the allowlist from <code>proxies.yml</code>
              </li>
            </ol>
          </div>

          {weatherStatus === 'loading' && (
            <p className="hint italic">Fetching weather…</p>
          )}

          {weatherStatus === 'error' && (
            <div className="note-amber">
              Could not load weather data. Check that <code>api.open-meteo.com</code> is reachable
              and declared in <code>config/proxies.yml</code>.
            </div>
          )}

          {weatherStatus === 'ok' && weather && (() => {
            const { label, icon } = describeWeather(weather.weathercode);
            return (
              <div className="weather-card">
                <div className="weather-icon">{icon}</div>
                <div className="weather-details">
                  <div className="weather-city">San Francisco, CA</div>
                  <div className="weather-condition">{label}</div>
                  <div className="weather-stats">
                    <span>{weather.temperature}°C</span>
                    <span className="weather-sep">·</span>
                    <span>Wind {weather.windspeed} km/h</span>
                  </div>
                </div>
              </div>
            );
          })()}

          <p className="hint">
            Fetch URL: <code>https://api.open-meteo.com/v1/forecast?latitude=37.77&longitude=-122.42&current_weather=true</code>
          </p>
        </Section>

        {/* ── Product examples divider ── */}
        <div className="product-divider span-2">
          <span className="product-divider-label">Product Examples</span>
        </div>

        {/* ── Cribl Search: Visualization from a query ── */}
        <Section title="Cribl Search — Visualization from a Query" className="span-2">
          <p className="body-text muted">
            This section creates a Cribl Search job, polls for completion, and renders the
            results as a bar chart. The query uses the{' '}
            <code>range</code> operator — a data-generating operator that produces rows from
            scratch with no existing dataset required.
          </p>

          <div className="code-block">
            <span className="code-label">Query</span>
            <code className="code-full">{SEARCH_QUERY}</code>
          </div>

          <div className="info-block">
            <h3 className="info-title">How it works</h3>
            <ol className="numbered-list">
              <li>
                <code>POST {'{CRIBL_API_URL}'}/m/default_search/search/jobs</code> — creates the job, returns a job ID
              </li>
              <li>
                <code>GET …/jobs/{'{jobId}'}/status</code> — polled every second until{' '}
                <code>status === "completed"</code>
              </li>
              <li>
                <code>GET …/jobs/{'{jobId}'}/results</code> — returns NDJSON; first line is
                metadata, the rest are data rows
              </li>
            </ol>
          </div>

          <div>
            <button
              className={`btn btn-primary${searchPhase === 'submitting' || searchPhase === 'polling' ? ' btn-disabled' : ''}`}
              onClick={runSearch}
              disabled={searchPhase === 'submitting' || searchPhase === 'polling'}
            >
              {searchPhase === 'submitting' || searchPhase === 'polling' ? 'Running…' : 'Run query'}
            </button>
          </div>

          {/* Animated "running" indicator shown while the job is in flight */}
          {(searchPhase === 'submitting' || searchPhase === 'polling') && (
            <div className="search-running">
              <span className="search-pulse-dot" />
              {searchPhase === 'submitting' ? 'Creating search job…' : 'Waiting for results…'}
            </div>
          )}

          {searchPhase === 'error' && (
            <div className="note-amber">{searchErrMsg}</div>
          )}

          {/* Dark-panel animated column chart */}
          {searchPhase === 'done' && chartRows.length > 0 && (() => {
            const maxValue = Math.max(...chartRows.map((r) => r.value));
            return (
              <div className="viz-panel">
                <div className="viz-header">
                  <div>
                    <div className="viz-title">Search Results</div>
                    <div className="viz-meta">{chartRows.length} events · <em>{SEARCH_QUERY}</em></div>
                  </div>
                  <div className="viz-live-badge">
                    <span className="viz-live-dot" />
                    Live
                  </div>
                </div>
                <div className="viz-body">
                  <div className="viz-chart">
                    {chartRows.map((row, i) => {
                      // Scale to 10–92% so even the smallest bar is clearly visible
                      const heightPct = maxValue > 0 ? 10 + (row.value / maxValue) * 82 : 10;
                      return (
                        <div key={i} className="viz-col">
                          <span
                            className="viz-value"
                            style={{ animationDelay: `${i * 0.08 + 0.42}s` }}
                          >
                            {row.value}
                          </span>
                          <div
                            className="viz-bar"
                            style={{
                              height: `${heightPct}%`,
                              animationDelay: `${i * 0.08}s`,
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="viz-footer">
                  {chartRows.map((row, i) => (
                    <span key={i} className="viz-xlabel">{row.label}</span>
                  ))}
                </div>
              </div>
            );
          })()}

          <p className="hint">
            Search endpoints always use <code>groupId = default_search</code> — see AGENTS.md
          </p>
        </Section>

        {/* ── Cribl Stream: Top 5 most complex pipelines ── */}
        <Section title="Cribl Stream — Top 5 Most Complex Pipelines" className="span-2">
          <p className="body-text muted">
            Fetches all pipelines from the first available Stream worker group and ranks them by
            total function count. Complexity = number of entries in{' '}
            <code>pipeline.conf.functions</code>.
          </p>

          {pipelinesStatus === 'loading' && (
            <div className="pipe-skeleton">
              {[1, 2, 3, 4, 5].map((i) => <div key={i} className="pipe-skel-row" />)}
            </div>
          )}

          {pipelinesStatus === 'error' && (
            <div className="note-amber">
              This panel depends on Stream access your current user may not have, or requires
              the app to be running inside Cribl. The rest of the app still works.
            </div>
          )}

          {pipelinesStatus === 'empty' && (
            <p className="hint italic">No pipelines found in the selected worker group.</p>
          )}

          {pipelinesStatus === 'done' && topPipelines.length > 0 && (() => {
            const maxCount = topPipelines[0].count; // already sorted desc
            return (
              <div className="pipe-table">
                <div className="pipe-thead">
                  <span className="pipe-th">#</span>
                  <span className="pipe-th">Pipeline</span>
                  <span className="pipe-th pipe-th-right">Functions</span>
                </div>
                {topPipelines.map((row, i) => (
                  <div key={row.id} className="pipe-row">
                    <span className={`pipe-rank-badge${i === 0 ? ' pipe-rank-first' : ''}`}>
                      {i + 1}
                    </span>
                    <span className="pipe-id">{row.id}</span>
                    <div className="pipe-count-cell">
                      <div className="pipe-mini-bar-track">
                        <div
                          className="pipe-mini-bar"
                          style={{ width: `${maxCount > 0 ? (row.count / maxCount) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="pipe-count-num">{row.count}</span>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          <p className="hint">
            API: <code>GET {'${CRIBL_API_URL}'}/m/{'${groupId}'}/pipelines</code> →{' '}
            complexity = <code>countFunctions(pipeline)</code> in <code>src/App.tsx</code>
          </p>
        </Section>

      </div>
    </div>
  );
}

export default App;
