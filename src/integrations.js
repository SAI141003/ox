// The island's service pills: a read-only look at your deployments with your
// own token (`ox key VERCEL_TOKEN …`), nothing ever written. No token, no pill.

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

// For the day strip; a service that fails is left out, never shown as an error pill.
export async function servicePills(env = process.env, opts = {}) {
  const vercel = await vercelLatest(env.VERCEL_TOKEN, opts).catch((e) => ({ error: String(e?.message ?? e) }));
  return vercel ? { vercel } : {};
}
