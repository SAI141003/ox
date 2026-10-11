// OSINT investigation module for ox.
//
// Public API (each returns { ok, data, error }):
//   searchEmail(email)
//   searchUsername(username)
//   searchDomain(domain)
//   searchIP(ip)
//   searchBreach(email)
//   searchShodan(query)
//   searchVirusTotal(target)
//   searchCensys(target)
//   searchAbuseIPDB(ip)
//   searchGitHub(query)
//   searchDNS(domain)
//   generateDorks(query)
//   searchFootprint(target)
//   searchPaste(query)
//   searchPhone(phone)
//   searchWhois(domain)
//   searchSubdomain(domain)
//   searchURL(url)
//   sanctionsCheck(name)

const HIBP_API = 'https://haveibeenpwned.com/api/v3';
const ABUSEIPDB_API = 'https://api.abuseipdb.com/api/v2';
const SHODAN_API = 'https://api.shodan.io';
const VT_API = 'https://www.virustotal.com/api/v3';
const CENSYS_API = 'https://search.censys.io/api/v1';
const GITHUB_API = 'https://api.github.com';
const OFAC_API = 'https://sanctionssearch.ofac.treas.gov/api';
const PASTE_SITES = [
  'https://pastebin.com/search?q=',
  'https://ghostbin.com/search?q=',
  'https://hastebin.com/search?q=',
];

const DORK_TEMPLATES = [
  (q) => `https://www.google.com/search?q="${q}" filetype:pdf`,
  (q) => `https://www.google.com/search?q="${q}" site:pastebin.com`,
  (q) => `https://www.google.com/search?q="${q}" intitle:"index of"`,
  (q) => `https://www.google.com/search?q="${q}" filetype:xlsx OR filetype:csv`,
  (q) => `https://www.google.com/search?q="${q}" inurl:admin`,
];

const USERNAME_PLATFORMS = [
  'github', 'twitter', 'reddit', 'instagram', 'linkedin',
  'youtube', 'twitch', 'medium', 'bitbucket', 'gitlab',
];

async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'ox-osint/1.0',
      'Accept': 'application/json',
      ...headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

function ok(data) {
  return { ok: true, data, error: null };
}

function fail(err) {
  return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
}

export function searchEmail(email) {
  return searchBreach(email);
}

export function searchUsername(username) {
  const results = {};
  const checks = USERNAME_PLATFORMS.map((platform) => {
    const url = `https://${platform}.com/${username}`;
    return fetch(url, { method: 'HEAD', redirect: 'manual' })
      .then((res) => {
        results[platform] = res.status === 200 ? 'found' : 'not_found';
      })
      .catch(() => {
        results[platform] = 'error';
      });
  });

  return Promise.all(checks).then(() => {
    const found = Object.entries(results).filter(([, v]) => v === 'found');
    return ok({ username, platforms: results, found: found.map(([k]) => k) });
  });
}

export function searchDomain(domain) {
  return Promise.all([
    searchDNS(domain),
    searchWhois(domain),
    searchSubdomain(domain),
  ]).then(([dns, whois, subs]) => {
    return ok({
      domain,
      dns: dns.data,
      whois: whois.data,
      subdomains: subs.data,
    });
  });
}

export function searchIP(ip) {
  return Promise.all([
    searchAbuseIPDB(ip),
    searchShodan(ip),
  ]).then(([abuse, shodan]) => {
    return ok({
      ip,
      abuseIPDB: abuse.data,
      shodan: shodan.data,
    });
  });
}

export async function searchBreach(email) {
  try {
    const url = `${HIBP_API}/breachedaccount/${encodeURIComponent(email)}`;
    const data = await get(url, { 'hibp-api-key': 'REDACTED' });
    return ok({ email, breaches: data });
  } catch (err) {
    return fail(err);
  }
}

export async function searchShodan(query) {
  try {
    const url = `${SHODAN_API}/shodan/host/search?key=REDACTED&query=${encodeURIComponent(query)}`;
    const data = await get(url);
    return ok({ query, results: data.matches ?? data });
  } catch (err) {
    return fail(err);
  }
}

export async function searchVirusTotal(target) {
  try {
    const encoded = encodeURIComponent(target);
    const url = `${VT_API}/urls/${encoded}`;
    const data = await get(url, { 'x-apikey': 'REDACTED' });
    const stats = data.data?.attributes?.last_analysis_stats;
    return ok({
      target,
      verdict: stats ?? data,
      malicious: stats?.malicious ?? null,
      harmless: stats?.harmless ?? null,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function searchCensys(target) {
  try {
    const url = `${CENSYS_API}/search?q=${encodeURIComponent(target)}`;
    const data = await get(url, { Authorization: 'Basic REDACTED' });
    return ok({ target, results: data.results ?? data });
  } catch (err) {
    return fail(err);
  }
}

export async function searchAbuseIPDB(ip) {
  try {
    const url = `${ABUSEIPDB_API}/check?ipAddress=${encodeURIComponent(ip)}`;
    const data = await get(url, { Key: 'REDACTED' });
    const result = data.data ?? data;
    return ok({
      ip,
      abuseConfidenceScore: result.abuseConfidenceScore,
      countryCode: result.countryCode,
      isPublic: result.isPublic,
      isWhitelisted: result.isWhitelisted,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function searchGitHub(query) {
  try {
    const url = `${GITHUB_API}/search/users?q=${encodeURIComponent(query)}`;
    const data = await get(url, { Accept: 'application/vnd.github+json' });
    return ok({
      query,
      total: data.total_count,
      users: (data.items ?? []).map((u) => ({ login: u.login, url: u.html_url })),
    });
  } catch (err) {
    return fail(err);
  }
}

export async function searchDNS(domain) {
  try {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`;
    const data = await get(url);
    return ok({
      domain,
      records: data.Answer ?? [],
      status: data.Status,
    });
  } catch (err) {
    return fail(err);
  }
}

export function generateDorks(query) {
  const urls = DORK_TEMPLATES.map((t) => t(query));
  return ok({ query, dorks: urls });
}

export async function searchFootprint(target) {
  try {
    const [dns, github] = await Promise.all([
      searchDNS(target),
      searchGitHub(target),
    ]);

    const footprint = {
      target,
      hasDNS: dns.data?.records?.length > 0,
      githubUsers: github.data?.users?.length ?? 0,
      exposure: ((dns.data?.records?.length ?? 0) + (github.data?.users?.length ?? 0)) > 0 ? 'detected' : 'minimal',
    };

    return ok(footprint);
  } catch (err) {
    return fail(err);
  }
}

export function searchPaste(query) {
  const urls = PASTE_SITES.map((base) => `${base}${encodeURIComponent(query)}`);
  return ok({ query, urls });
}

export async function searchPhone(phone) {
  try {
    const cleaned = phone.replace(/\D/g, '');
    const url = `https://phonevalidation.abstractapi.com/v1/?api_key=REDACTED&phone=${encodeURIComponent(cleaned)}`;
    const data = await get(url);
    return ok({ phone, data });
  } catch (err) {
    return fail(err);
  }
}

export async function searchWhois(domain) {
  try {
    const url = `https://whois-api.nic.in/whois?domain=${encodeURIComponent(domain)}`;
    const data = await get(url);
    return ok({ domain, whois: data });
  } catch (err) {
    return fail(err);
  }
}

export async function searchSubdomain(domain) {
  try {
    const url = `https://crt.sh/?q=%.${encodeURIComponent(domain)}&output=json`;
    const data = await get(url);
    const subdomains = Array.isArray(data)
      ? [...new Set(data.map((entry) => entry.name_value?.split('\n')[0]).filter(Boolean))]
      : [];
    return ok({ domain, subdomains, count: subdomains.length });
  } catch (err) {
    return fail(err);
  }
}

export async function searchURL(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'ox-osint/1.0' },
      redirect: 'follow',
    });

    const text = await res.text();
    const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch ? titleMatch[1].trim() : '';

    return ok({
      url,
      status: res.status,
      title,
      contentType: res.headers.get('content-type') ?? 'unknown',
      contentLength: text.length,
      snippet: text.slice(0, 500),
    });
  } catch (err) {
    return fail(err);
  }
}

export async function sanctionsCheck(name) {
  try {
    const url = `${OFAC_API}/search?sdn=${encodeURIComponent(name)}`;
    const data = await get(url);
    return ok({ name, results: data.results ?? data, found: (data.results?.length ?? 0) > 0 });
  } catch (err) {
    return fail(err);
  }
}
