import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
// fetch() rejects with a TypeError ("Failed to fetch") when the server can't be reached at all.
const isNetworkError = (e) => e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e?.message || '');
const elapsed = (d) => { const s = Math.max(0, Math.floor((Date.now() - new Date(d)) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const daysLeft = (d) => (d ? Math.ceil((new Date(d) - Date.now()) / 86_400_000) : null);
const ISSUE_LABELS = { broken_image: 'Image problem', broken_link: 'Broken link', page_error: 'Page error', site_error: 'Error message', expired_date: 'Expired date', outdated_banner: 'Outdated banner', outdated_content: 'Outdated content' };

function StatusDot({ status }) {
  return <span className={`dot dot-${status}`} title={status} />;
}

function Expiry({ date }) {
  const left = daysLeft(date);
  if (left === null) return <span className="muted">—</span>;
  const cls = left <= 7 ? 'bad' : left <= 30 ? 'warn' : '';
  return <span className={cls}>{left <= 0 ? 'Expired' : `${left} d`}<small className="muted"> · {fmtDate(date)}</small></span>;
}

function Overview({ data }) {
  if (!data) return null;
  const tiles = [
    ['Sites monitored', `${data.sites.total} / ${data.plan.sites}`],
    ['Up', data.sites.up, 'ok'],
    ['Down', data.sites.down, data.sites.down ? 'bad' : ''],
    ['Expiring ≤30 days', data.expiringSoon.ssl + data.expiringSoon.domain, data.expiringSoon.ssl + data.expiringSoon.domain ? 'warn' : ''],
    ['Open page issues', data.openIssues, data.openIssues ? 'warn' : '']
  ];
  return (
    <>
      <div className="tiles">
        {tiles.map(([label, value, cls]) => <div key={label} className="tile"><div className={`tile-value ${cls || ''}`}>{value}</div><div className="muted">{label}</div></div>)}
      </div>
      <div className="notice-row">
        <span>Plan: <b>{data.plan.label}</b> (₹{data.plan.price.toLocaleString('en-IN')}/mo)</span>
        <span>AI scan: <b className={data.ai.enabled ? 'ok' : 'warn'}>{data.ai.enabled ? data.ai.mode : 'rules only'}</b></span>
        <span>Email: <b className={data.channels.email ? 'ok' : 'warn'}>{data.channels.email ? 'on' : 'not set'}</b></span>
        <span>WhatsApp: <b className={data.channels.whatsapp ? 'ok' : 'warn'}>{data.channels.whatsapp ? 'on' : 'not set'}</b></span>
      </div>
    </>
  );
}

const EMPTY = { name: '', url: '', client_name: '', client_email: '', client_whatsapp: '', alert_client: false, paused: false };

function SiteForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState(initial || EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const saved = initial?.id ? await api(`/sites/${initial.id}`, { method: 'PUT', body: form }) : await api('/sites', { method: 'POST', body: form });
      onSaved(saved);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <form className="card form" onSubmit={submit}>
      <h3>{initial?.id ? 'Edit site' : 'Add a website'}</h3>
      <div className="grid2">
        <label>Site name (optional)<input value={form.name} onChange={set('name')} placeholder="Uses the domain if empty" /></label>
        <label>Website URL<input required value={form.url} onChange={set('url')} placeholder="acme.com" /></label>
        <label>Client name<input value={form.client_name || ''} onChange={set('client_name')} /></label>
        <label>Client email (monthly report)<input type="email" value={form.client_email || ''} onChange={set('client_email')} /></label>
        <label>Client WhatsApp<input value={form.client_whatsapp || ''} onChange={set('client_whatsapp')} placeholder="+919876543210" /></label>
        <div className="checks">
          <label className="inline"><input type="checkbox" checked={Boolean(form.alert_client)} onChange={set('alert_client')} /> Also alert the client (down / expiry)</label>
          <label className="inline"><input type="checkbox" checked={Boolean(form.paused)} onChange={set('paused')} /> Pause monitoring</label>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ResponseChart({ checks }) {
  if (!checks.length) return <p className="muted">No checks yet.</p>;
  const max = Math.max(...checks.map((c) => c.response_ms || 0), 500);
  const w = 600, h = 80, step = w / Math.max(checks.length, 72); // fixed slots: a few checks show as thin bars, not one block
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Response time history">
      {checks.map((c, i) => {
        const bh = c.ok ? Math.max(2, ((c.response_ms || 0) / max) * (h - 4)) : h;
        return <rect key={i} x={i * step} y={h - bh} width={Math.max(step - 1, 1)} height={bh} className={c.ok ? 'bar-ok' : 'bar-bad'}><title>{`${fmtTime(c.checked_at)} · ${c.ok ? `${c.response_ms} ms` : c.error}`}</title></rect>;
      })}
    </svg>
  );
}

function SiteDetail({ id, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  // Background refreshes: a dropped request (server restarting, laptop asleep) shows "reconnecting"
  // and clears itself on the next successful refresh instead of leaving "Failed to fetch" on screen.
  const [offline, setOffline] = useState(false);
  const load = useCallback(() => api(`/sites/${id}`).then((d) => { setData(d); setOffline(false); }).catch((e) => (isNetworkError(e) ? setOffline(true) : setMsg(e.message))), [id]);
  const scanActive = Boolean(data?.scan && !data.scan.finished_at);
  // Refresh every 3s while a scan runs (live progress), otherwise every 15s.
  useEffect(() => { load(); const t = setInterval(load, scanActive ? 3_000 : 15_000); return () => clearInterval(t); }, [load, scanActive]);
  const [, tickClock] = useState(0);
  useEffect(() => { if (!scanActive) return; const t = setInterval(() => tickClock((n) => n + 1), 1_000); return () => clearInterval(t); }, [scanActive]);
  if (!data) return <p className="muted">Loading…</p>;
  const { site, checks, incidents, alerts, scan, issues } = data;
  const scanRunning = scan && !scan.finished_at;

  async function act(kind) {
    setBusy(kind); setMsg('');
    try {
      if (kind === 'check') await api(`/sites/${id}/check`, { method: 'POST' });
      if (kind === 'scan') { await api(`/sites/${id}/scan`, { method: 'POST' }); setMsg('Scan started. It can take a few minutes; this page refreshes by itself.'); }
      if (kind === 'send') { const r = await api(`/sites/${id}/report/send`, { method: 'POST' }); setMsg(r.sent ? 'Report emailed to client.' : `Not sent: ${r.skipped || 'email not configured'}`); }
      if (kind === 'delete') { if (!confirm(`Stop monitoring ${site.name} and delete its history?`)) return; await api(`/sites/${id}`, { method: 'DELETE' }); onChanged(); onBack(); return; }
      await load(); onChanged();
    } catch (e) { setMsg(isNetworkError(e) ? 'Could not reach the SiteGuard server. Check that it is running, then try again.' : e.message); } finally { setBusy(''); }
  }

  if (editing) return <SiteForm initial={site} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChanged(); }} />;

  return (
    <div>
      <button className="link" onClick={onBack}>← All sites</button>
      <div className="detail-head">
        <div>
          <h2><StatusDot status={site.status} /> {site.name}</h2>
          <a href={site.url} target="_blank" rel="noreferrer" className="muted">{site.url}</a>
        </div>
        <div className="actions">
          <button onClick={() => act('check')} disabled={!!busy}>{busy === 'check' ? 'Checking…' : 'Check now'}</button>
          <button onClick={() => act('scan')} disabled={!!busy || scanRunning}>{scanRunning ? 'Scanning…' : 'Run AI page scan'}</button>
          <a className="button" href={`/api/sites/${id}/report`} target="_blank" rel="noreferrer">View monthly report</a>
          <button onClick={() => act('send')} disabled={!!busy}>Email report</button>
          <button onClick={() => setEditing(true)}>Edit</button>
          <button className="danger" onClick={() => act('delete')}>Delete</button>
        </div>
      </div>
      {offline && <p className="notice warn-box">⚠️ Lost connection to the SiteGuard server. Reconnecting automatically… (a running scan continues on the server)</p>}
      {msg && <p className="notice">{msg} <button className="link" onClick={() => setMsg('')} aria-label="Dismiss">✕</button></p>}

      <div className="tiles">
        <div className="tile"><div className="tile-value">{site.last_status_code || '—'}</div><div className="muted">Last HTTP status</div></div>
        <div className="tile"><div className="tile-value">{site.last_response_ms ? `${site.last_response_ms} ms` : '—'}</div><div className="muted">Response time</div></div>
        <div className="tile"><div className="tile-value"><Expiry date={site.ssl_expires_at} /></div><div className="muted">SSL {site.ssl_issuer ? `(${site.ssl_issuer})` : ''}</div></div>
        <div className="tile"><div className="tile-value"><Expiry date={site.domain_expires_at} /></div><div className="muted">Domain</div></div>
      </div>
      {site.last_error && <p className="error">Last error: {site.last_error}</p>}

      <div className="card"><h3>Response time (last {checks.length} checks)</h3><ResponseChart checks={checks} /></div>

      <div className="card">
        <h3>Daily page scan {scan && <small className="muted">· {fmtTime(scan.started_at)}{scan.finished_at ? (scan.ai_used ? ' · AI review on' : ' · rules only') : ''}</small>}</h3>
        {!scan && <p className="muted">No scan yet. It runs daily, or click "Run AI page scan".</p>}
        {scanRunning && (
          <div className="notice progress">
            <div><span className="spinner" aria-hidden="true" /> <b>{scan.progress || 'Starting scan…'}</b></div>
            <div className="muted small">Running for {elapsed(scan.started_at)} · usually takes 2–6 minutes · results appear here automatically</div>
          </div>
        )}
        {scan?.error && <p className="error">Scan failed: {scan.error}</p>}
        {scan?.summary && scan.finished_at && !scan.error && <p>{scan.summary}</p>}
        <IssueTable siteId={id} issues={issues} onChanged={load} />
      </div>

      <BackupCard site={site} onChanged={load} />

      <div className="grid2">
        <div className="card">
          <h3>Downtime incidents</h3>
          {incidents.length ? <ul className="list">{incidents.map((i) => <li key={i.id}><b>{fmtTime(i.started_at)}</b> → {i.resolved_at ? fmtTime(i.resolved_at) : <span className="bad">ongoing</span>}<div className="muted">{i.cause}</div></li>)}</ul> : <p className="muted">No incidents.</p>}
        </div>
        <div className="card">
          <h3>Alerts sent</h3>
          {alerts.length ? <ul className="list">{alerts.map((a, i) => <li key={i}>{a.subject}<div className="muted">{fmtTime(a.created_at)} · {a.channels || 'pending'}</div></li>)}</ul> : <p className="muted">No alerts yet.</p>}
        </div>
      </div>
    </div>
  );
}

// Issues from the latest scan, with Fixed / Ignore. NEW = not seen in the previous scan.
function IssueTable({ siteId, issues, onChanged }) {
  const [filter, setFilter] = useState('open');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const counts = {
    open: issues.filter((i) => !i.status).length,
    new: issues.filter((i) => !i.status && i.is_new).length,
    fixed: issues.filter((i) => i.status === 'fixed').length,
    ignored: issues.filter((i) => i.status === 'ignored').length
  };
  const shown = issues.filter((i) => (filter === 'open' ? !i.status : filter === 'new' ? !i.status && i.is_new : i.status === filter));
  async function mark(issue, status) {
    setBusyId(issue.id); setError('');
    try { await api(`/sites/${siteId}/issues/${issue.id}/status`, { method: 'POST', body: { status } }); await onChanged(); }
    catch (e) { setError(e.message); } finally { setBusyId(null); }
  }
  if (!issues.length) return null;
  return (
    <>
      <div className="tabs" role="tablist">
        {[['open', 'Open'], ['new', 'New'], ['fixed', 'Marked fixed'], ['ignored', 'Ignored']].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'tab active' : 'tab'} onClick={() => setFilter(key)}>{label} ({counts[key]})</button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {shown.length === 0 ? <p className="muted">{filter === 'open' ? '🎉 No open issues. Everything found has been fixed or ignored.' : 'Nothing here.'}</p> : (
        <table>
          <thead><tr><th>Severity</th><th>Type</th><th>Problem</th><th>Page</th><th></th></tr></thead>
          <tbody>{shown.map((i) => (
            <tr key={i.id}>
              <td><span className={`pill sev-${i.severity}`}>{i.severity}</span>{!i.status && i.is_new ? <span className="pill new">NEW</span> : null}</td>
              <td>{ISSUE_LABELS[i.type] || i.type}</td>
              <td>{i.detail}{i.evidence && (/^https?:\/\//.test(i.evidence)
                ? <div className="evidence"><a href={i.evidence} target="_blank" rel="noreferrer">{i.evidence}</a></div>
                : <div className="evidence">{i.evidence}</div>)}</td>
              <td><a href={i.page_url} target="_blank" rel="noreferrer">{new URL(i.page_url).pathname}</a></td>
              <td className="row-actions">
                {i.status
                  ? <button className="small" disabled={busyId === i.id} onClick={() => mark(i, 'open')}>Reopen</button>
                  : <>
                      <button className="small" disabled={busyId === i.id} onClick={() => mark(i, 'fixed')} title="Hide it. If the next scan still finds it, it comes back as NEW.">✓ Fixed</button>
                      <button className="small" disabled={busyId === i.id} onClick={() => mark(i, 'ignored')} title="Never count or alert about this again.">Ignore</button>
                    </>}
              </td>
            </tr>))}
          </tbody>
        </table>
      )}
    </>
  );
}

// Backup monitoring: the backup job calls a secret link after each backup.
function BackupCard({ site, onChanged }) {
  const [hours, setHours] = useState(site.backup_expected_hours || 24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const enabled = Boolean(site.backup_expected_hours);
  const link = site.backup_token ? `${location.origin}/api/backup-checkin/${site.backup_token}` : '';
  async function save(expected_hours) {
    setBusy(true); setError('');
    try { await api(`/sites/${site.id}/backup`, { method: 'PUT', body: { expected_hours } }); await onChanged(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function newLink() {
    if (!confirm('Make a new check-in link? The old link stops working, so update the backup job too.')) return;
    await api(`/sites/${site.id}/backup/new-link`, { method: 'POST' }); await onChanged();
  }
  const copy = () => { navigator.clipboard?.writeText(`curl -fsS ${link}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  const status = site.last_backup_status;
  return (
    <div className="card">
      <h3>Backups</h3>
      {!enabled ? (
        <>
          <p className="muted">Get an alert when this site's backup doesn't run. The backup job (cron, WordPress plugin, hosting panel) calls a secret link after every backup; if no backup checks in on time, the web team is alerted.</p>
          <div className="actions inline-form">
            <label>Backup expected every <input type="number" min="1" max="744" value={hours} onChange={(e) => setHours(e.target.value)} /> hours</label>
            <button className="primary" disabled={busy} onClick={() => save(Number(hours))}>Turn on backup monitoring</button>
          </div>
        </>
      ) : (
        <>
          <p>
            Status: <b className={status === 'ok' ? 'ok' : status ? 'bad' : 'warn'}>{status === 'ok' ? 'Backups OK' : status === 'fail' ? 'Last backup FAILED' : status === 'missed' ? 'Backup MISSED' : 'Waiting for first backup'}</b>
            {' · '}Last backup: <b>{site.last_backup_at ? fmtTime(site.last_backup_at) : 'none yet'}</b>
            {' · '}Expected every {site.backup_expected_hours} h
          </p>
          {site.last_backup_message && <p className="muted small">Message from backup job: {site.last_backup_message}</p>}
          <p className="small">Add this as the <b>last step of the backup job</b>:</p>
          <div className="code-row"><code>curl -fsS {link}</code><button className="small" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button></div>
          <p className="muted small">To report a failure: <code>curl -fsS "{link}?status=fail&amp;message=disk%20full"</code></p>
          <div className="actions">
            <label className="small">Every <input type="number" min="1" max="744" value={hours} onChange={(e) => setHours(e.target.value)} /> hours</label>
            <button className="small" disabled={busy} onClick={() => save(Number(hours))}>Save interval</button>
            <button className="small" onClick={newLink}>New link</button>
            <button className="small danger" disabled={busy} onClick={() => save(null)}>Turn off</button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function SiteList({ sites, onOpen }) {
  if (!sites.length) return <div className="card empty">No websites yet. Click <b>Add website</b> to start monitoring.</div>;
  return (
    <div className="card">
      <table>
        <thead><tr><th>Site</th><th>Status</th><th>Uptime 30d</th><th>Response</th><th>SSL</th><th>Domain</th><th>Page issues</th><th>Last check</th></tr></thead>
        <tbody>{sites.map((s) => (
          <tr key={s.id} className="clickable" onClick={() => onOpen(s.id)}>
            <td><b>{s.name}</b><div className="muted small">{s.client_name || new URL(s.url).hostname}</div></td>
            <td><StatusDot status={s.paused ? 'paused' : s.status} /> {s.paused ? 'paused' : s.status}</td>
            <td>{s.uptime30 != null ? `${Number(s.uptime30).toFixed(2)}%` : '—'}</td>
            <td>{s.last_response_ms ? `${s.last_response_ms} ms` : '—'}</td>
            <td><Expiry date={s.ssl_expires_at} /></td>
            <td><Expiry date={s.domain_expires_at} /></td>
            <td>{s.issue_count == null ? '—' : s.issue_count ? <span className="warn">{s.issue_count}</span> : '0'}</td>
            <td className="muted">{fmtTime(s.last_checked_at)}</td>
          </tr>))}
        </tbody>
      </table>
    </div>
  );
}

// The main entry point: type a website, press Analyze. Starts monitoring + the AI scan at once.
function AnalyzeBox({ onAdded, onMore }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true); setError('');
    try {
      const site = await api('/sites', { method: 'POST', body: { url } });
      setUrl('');
      onAdded(site);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className="card analyze" onSubmit={submit}>
      <h2>Check a website</h2>
      <p className="muted">Enter any website. SiteGuard checks uptime, SSL and domain expiry, then scans every page for broken links, missing images, errors, expired dates and outdated banners.</p>
      <div className="analyze-row">
        <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Enter website, e.g. example.com" aria-label="Website address" />
        <button className="primary" disabled={busy || !url.trim()}>{busy ? 'Starting…' : 'Analyze website'}</button>
      </div>
      {error && <p className="error">{error}</p>}
      <button type="button" className="link small-link" onClick={onMore}>+ Add with client details (email, WhatsApp, report)</button>
    </form>
  );
}

function SettingsPage({ onBack, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState(null);
  const load = useCallback(() => api('/settings').then((d) => { setData(d); setForm(d.values); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save(e) {
    e.preventDefault();
    setBusy('save'); setMsg(''); setError('');
    try { await api('/settings', { method: 'PUT', body: form }); setMsg('Saved.'); await load(); onSaved(); }
    catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  async function sendTest() {
    setBusy('test'); setTest(null); setError('');
    try { setTest(await api('/settings/test-alert', { method: 'POST' })); } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  const ch = data.channels;
  return (
    <div>
      <button className="link" onClick={onBack}>← All sites</button>
      <h2>Settings</h2>
      {msg && <p className="notice">{msg}</p>}
      {error && <p className="error">{error}</p>}

      <form className="card form" onSubmit={save}>
        <h3>Alerts go to (web team)</h3>
        <div className="grid2">
          <label>Team email (several: separate with commas)<input value={form.team_email || ''} onChange={set('team_email')} placeholder="webteam@company.com" /></label>
          <label>Team WhatsApp number<input value={form.team_whatsapp || ''} onChange={set('team_whatsapp')} placeholder="+919876543210" /></label>
        </div>
        <h3 style={{ marginTop: 18 }}>Branding (alerts and monthly client reports)</h3>
        <div className="grid2">
          <label>Brand name<input value={form.brand_name || ''} onChange={set('brand_name')} placeholder="SiteGuard" /></label>
          <label>Brand colour<span className="color-row"><input type="color" value={/^#[0-9a-f]{6}$/i.test(form.brand_color || '') ? form.brand_color : '#0f766e'} onChange={set('brand_color')} aria-label="Pick colour" /><input value={form.brand_color || ''} onChange={set('brand_color')} placeholder="#0f766e" /></span></label>
          <label>Logo URL (https://…)<input value={form.brand_logo_url || ''} onChange={set('brand_logo_url')} placeholder="https://yourdomain.com/logo.png" /></label>
        </div>
        <div className="actions"><button className="primary" disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button></div>
      </form>

      <div className="card">
        <h3>Alert channels</h3>
        <ul className="list">
          <li><b className={ch.email.ready ? 'ok' : 'warn'}>{ch.email.ready ? '✓ Email ready' : '✗ Email not ready'}</b>{ch.email.smtpHost && <span className="muted"> · SMTP {ch.email.smtpHost}</span>}{!ch.email.ready && <div className="muted small">Missing: {ch.email.missing.join(', ')}</div>}</li>
          <li><b className={ch.whatsapp.ready ? 'ok' : 'warn'}>{ch.whatsapp.ready ? '✓ WhatsApp ready' : '✗ WhatsApp not ready'}</b>{ch.whatsapp.provider && <span className="muted"> · {ch.whatsapp.provider}</span>}{!ch.whatsapp.ready && <div className="muted small">Missing: {ch.whatsapp.missing.join(', ')}</div>}</li>
          <li><b className={data.scheduler ? 'ok' : 'warn'}>{data.scheduler ? '✓ 24/7 monitoring is on' : '✗ 24/7 monitoring is off'}</b>{!data.scheduler && <div className="muted small">Set SCHEDULER_ENABLED=1 in the server .env and restart.</div>}</li>
        </ul>
        <p className="muted small">Mail server and WhatsApp keys are secrets, so they are set in the server's .env file (see README), not here.</p>
        <button onClick={sendTest} disabled={!!busy}>{busy === 'test' ? 'Sending…' : 'Send test alert now'}</button>
        {test && (
          <div className={`notice ${test.delivered?.length ? '' : 'warn-box'}`} style={{ marginTop: 10 }}>
            {test.delivered?.length ? <>✓ Sent by <b>{test.delivered.join(' and ')}</b>. Check your inbox / WhatsApp.</> : <>Nothing was delivered. The test alert is saved on the dashboard only.</>}
            {test.errors?.map((e, i) => <div key={i} className="error small">{e}</div>)}
          </div>
        )}
      </div>

    </div>
  );
}

function App() {
  const [overview, setOverview] = useState(null);
  const [sites, setSites] = useState([]);
  const [adding, setAdding] = useState(false);
  // Views live in the URL hash: #site-4 opens a site, #settings opens Settings.
  const viewFromHash = () => (location.hash === '#settings' ? 'settings' : Number(location.hash.match(/site-(\d+)/)?.[1]) || null);
  const [view, setView] = useState(viewFromHash);
  const openId = typeof view === 'number' ? view : null;
  const setOpenId = (id) => setView(id);
  const [error, setError] = useState('');
  const refresh = useCallback(() => Promise.all([api('/overview').then(setOverview), api('/sites').then(setSites)]).then(() => setError('')).catch((e) => setError(isNetworkError(e) ? '⚠️ Lost connection to the SiteGuard server. Reconnecting automatically…' : e.message)), []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 30_000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { const h = view === 'settings' ? 'settings' : view ? `site-${view}` : ''; if (location.hash.slice(1) !== h) location.hash = h; }, [view]);
  // Links like /#site-4 (from alert emails, or pasted while the app is open) open that site.
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const brand = overview?.brand?.name || 'SiteGuard';
  useEffect(() => { document.title = brand; }, [brand]);

  return (
    <div className="app">
      <header style={overview?.brand?.color ? { background: overview.brand.color } : undefined}>
        <button className="brand plain" onClick={() => setView(null)}>🛡️ {brand} <small>AI website health monitor</small></button>
        <div className="actions">
          {view && <button className="primary" onClick={() => setView(null)}>+ Check another website</button>}
          <button className="header-btn" onClick={() => setView('settings')}>⚙ Settings</button>
        </div>
      </header>
      <main>
        {error && !view && <p className="error">{error}</p>}
        {view === 'settings' ? (
          <SettingsPage onBack={() => setView(null)} onSaved={refresh} />
        ) : openId ? (
          <SiteDetail id={openId} onBack={() => setOpenId(null)} onChanged={refresh} />
        ) : (
          <>
            {adding
              ? <SiteForm onCancel={() => setAdding(false)} onSaved={(s) => { setAdding(false); refresh(); setOpenId(s.id); }} />
              : <AnalyzeBox onAdded={(s) => { refresh(); setOpenId(s.id); }} onMore={() => setAdding(true)} />}
            {sites.length > 0 && <Overview data={overview} />}
            {sites.length > 0 && <SiteList sites={sites} onOpen={setOpenId} />}
          </>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
