import { useState } from 'react';
import { getEngine } from '../engineRef';
import { useUI } from '../store';
import { runBenchmark, downloadReport, type BenchmarkReport } from '../benchmark';

const NAMES: Record<string, string> = { canvas2d: 'Canvas 2D', webgl2: 'WebGL2' };

/** Runs the in-app benchmark and offers the JSON report (capabilities, per-scenario timings, budget checks). */
export function BenchmarkPanel() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const showToast = useUI((s) => s.showToast);

  const run = async () => {
    const e = getEngine();
    if (!e || running) return;
    setRunning(true);
    setReport(null);
    const n = Number(new URLSearchParams(location.search).get('benchframes')) || 240;
    try {
      const r = await runBenchmark(e, { frameCount: n, onProgress: (t, f) => setProgress(`${t} · ${Math.round(f * 100)}%`) });
      setReport(r);
      const hook = (window as unknown as { __lumenwild?: Record<string, unknown> }).__lumenwild;
      if (hook) hook.lastBenchmark = r;
    } catch (err) {
      showToast(`Benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      setProgress('');
    }
  };

  const copy = async () => {
    if (!report) return;
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); showToast('Benchmark report copied'); }
    catch { showToast('Copy is blocked here: use Download'); }
  };

  const scenarios = report ? [...new Set(report.results.map((r) => r.scenario))] : [];
  const presenters = report ? report.budgets.map((b) => b.presenter) : [];
  return (
    <section className="panel" data-testid="benchmark-panel">
      <h3>Benchmark</h3>
      <p className="muted">Measures this device: four scenes with each renderer (about 40 s). Your view and weather are restored afterwards.</p>
      <div className="row" style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn" onClick={run} disabled={running} data-testid="bench-run">{running ? 'Running…' : 'Run benchmark'}</button>
      </div>
      {running && <p className="muted" data-testid="bench-progress" style={{ marginTop: 6 }}>{progress}</p>}
      {report && (
        <div data-testid="bench-result" style={{ marginTop: 8 }}>
          <table className="bench-table">
            <thead><tr><th>fps (p95 ms)</th>{presenters.map((p) => <th key={p}>{NAMES[p] ?? p}</th>)}</tr></thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s}><td>{s}</td>{presenters.map((p) => {
                  const r = report.results.find((x) => x.scenario === s && x.presenter === p);
                  return <td key={p}>{r ? `${r.fps.toFixed(0)} (${r.frameMs.p95.toFixed(1)})` : '–'}</td>;
                })}</tr>
              ))}
              <tr><td>budget</td>{report.budgets.map((b) => <td key={b.presenter}>{b.medium ? 'MEDIUM ✓' : b.low ? 'LOW ✓' : 'below LOW'}</td>)}</tr>
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 6 }}>{report.capabilities.gpuRenderer ?? 'GPU unknown'}</p>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn" onClick={() => showToast(`Saved ${downloadReport(report)}`)} data-testid="bench-download">Download report</button>
            <button className="btn" onClick={copy}>Copy</button>
          </div>
        </div>
      )}
    </section>
  );
}
