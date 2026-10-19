// The island's service pills (Coucou's integrations): read-only looks with your
// own keys, nothing ever written, open-source services only. No key, no pill.
//   Vercel   ox key VERCEL_TOKEN …          the newest deployment
//   Cal.com  ox key CALCOM_API_KEY …        your next booking (CALCOM_URL for a self-hosted one)
//   n8n      ox key N8N_API_KEY …  + N8N_URL   workflows that failed today

// The latest deployments: is the newest one up, building or broken?
export async function vercelLatest(token, { fetchImpl = fetch } = {}) {
  if (!token) return null;
  const r = await fetchImpl('https://api.vercel.com/v6/deployments?limit=5', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { error: r.status === 403 || r.status === 401 ? 'Vercel refused the token' : `Vercel answered ${r.status}` };
  const j = await r.json();
  const list = (j.deployments ?? []).map((d) => ({ name: d.name, state: String(d.state ?? d.readyState ?? '').toUpperCase(), url: d.url ? `https://${d.url}` : null, at: d.created ?? d.createdAt ?? null }));
  if (!list.length) return { state: null, list: [] };
  return { state: list[0].state, name: list[0].name, url: list[0].url, failing: list.filter((d) => d.state === 'ERROR').length, list };
}

// Cal.com: the next upcoming booking (v2 API; a self-hosted instance via CALCOM_URL).
export async function calNext(key, { base = 'https://api.cal.com', fetchImpl = fetch, now = Date.now() } = {}) {
  if (!key) return null;
  const r = await fetchImpl(`${base.replace(/\/+$/, '')}/v2/bookings?status=upcoming&take=5&sortStart=asc`, { headers: { authorization: `Bearer ${key}`, 'cal-api-version': '2024-08-13' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { error: r.status === 401 || r.status === 403 ? 'Cal.com refused the key' : `Cal.com answered ${r.status}` };
  const j = await r.json();
  const list = (Array.isArray(j.data) ? j.data : j.data?.bookings ?? []).map((b) => ({ title: b.title ?? b.eventType?.title ?? 'Booking', start: b.start ?? b.startTime, with: (b.attendees ?? [])[0]?.name ?? null }))
    .filter((b) => b.start && Date.parse(b.start) >= now - 5 * 60_000).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return list.length ? { ...list[0], count: list.length } : { count: 0 };
}

// n8n: executions that failed since midnight (public API, your own instance).
export async function n8nFailures(key, url, { fetchImpl = fetch, now = new Date() } = {}) {
  if (!key || !url) return null;
  const r = await fetchImpl(`${String(url).replace(/\/+$/, '')}/api/v1/executions?status=error&limit=50`, { headers: { 'X-N8N-API-KEY': key }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { error: r.status === 401 || r.status === 403 ? 'n8n refused the key' : `n8n answered ${r.status}` };
  const j = await r.json();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today = (j.data ?? []).filter((e) => Date.parse(e.startedAt ?? e.stoppedAt ?? 0) >= midnight);
  return { failed: today.length, workflows: [...new Set(today.map((e) => e.workflowData?.name ?? e.workflowId))].slice(0, 3), url: String(url).replace(/\/+$/, '') };
}

// For the day strip; a service that fails is left out, never shown as an error pill.
export async function servicePills(env = process.env, opts = {}) {
  const safe = (p) => p.catch((e) => ({ error: String(e?.message ?? e) }));
  const [vercel, cal, n8n] = await Promise.all([
    safe(vercelLatest(env.VERCEL_TOKEN, opts)),
    safe(calNext(env.CALCOM_API_KEY, { ...opts, ...(env.CALCOM_URL ? { base: env.CALCOM_URL } : {}) })),
    safe(n8nFailures(env.N8N_API_KEY, env.N8N_URL, opts)),
  ]);
  const out = {};
  if (vercel) out.vercel = vercel;
  if (cal && !cal.error) out.cal = cal;
  if (n8n && !n8n.error) out.n8n = n8n;
  return out;
}
