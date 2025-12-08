export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/leads') {
      return handleLeads(url, env);
    }
    if (url.pathname === '/enrich') {
      return handleEnrich(url);
    }
    return withCors(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));
  },
};

function withCors(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  return response;
}

async function handleLeads(url, env) {
  const country = url.searchParams.get('country');
  const keyword = url.searchParams.get('keyword');
  const num = Math.min(Number(url.searchParams.get('num') || 10), 10);
  const start = Math.max(1, Number(url.searchParams.get('start') || 1));

  if (!country || !keyword) {
    return withCors(new Response(JSON.stringify({ error: 'country and keyword are required' }), { status: 400 }));
  }
  if (!env.GOOGLE_API_KEY || !env.GOOGLE_CSE_ID) {
    return withCors(new Response(JSON.stringify({ error: 'Missing GOOGLE_API_KEY or GOOGLE_CSE_ID' }), { status: 500 }));
  }

  const query = `${keyword} ${country}`;
  const googleUrl = new URL('https://www.googleapis.com/customsearch/v1');
  googleUrl.searchParams.set('key', env.GOOGLE_API_KEY);
  googleUrl.searchParams.set('cx', env.GOOGLE_CSE_ID);
  googleUrl.searchParams.set('q', query);
  googleUrl.searchParams.set('num', num.toString());
  googleUrl.searchParams.set('start', start.toString());

  try {
    const resp = await fetch(googleUrl.toString());
    if (!resp.ok) {
      const text = await resp.text();
      return withCors(new Response(JSON.stringify({ error: 'Google API error', detail: text }), { status: 502 }));
    }
    const data = await resp.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const seen = new Set();
    const leads = [];

    for (const item of items) {
      if (!item.link) continue;
      const origin = normalizeOrigin(item.link);
      if (!origin || seen.has(origin)) continue;
      seen.add(origin);
      leads.push({
        Country: country,
        Company: item.title || origin,
        Website: origin,
        Address: '',
        Phone: '',
        Email: '',
      });
    }

    return withCors(new Response(JSON.stringify({ query, leads }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (error) {
    return withCors(new Response(JSON.stringify({ error: 'Worker error', detail: error.message }), { status: 500 }));
  }
}

async function handleEnrich(url) {
  const website = url.searchParams.get('website');
  if (!website) {
    return withCors(new Response(JSON.stringify({ error: 'website is required' }), { status: 400 }));
  }

  const targets = ['/', '/contact', '/contact-us', '/about'];
  const found = { Email: '', Phone: '' };
  const origin = normalizeOrigin(website);

  for (const path of targets) {
    try {
      const resp = await fetch(origin + path);
      if (!resp.ok) continue;
      const html = await resp.text();
      if (!found.Email) {
        const emailMatch = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        if (emailMatch) found.Email = emailMatch[0];
      }
      if (!found.Phone) {
        const phoneMatch = html.match(/\+?\d[\d\s().-]{7,}\d/);
        if (phoneMatch) found.Phone = phoneMatch[0].trim();
      }
      if (found.Email && found.Phone) break;
    } catch (e) {
      // ignore fetch errors during enrichment
    }
  }

  return withCors(new Response(JSON.stringify({ Website: origin, Email: found.Email, Phone: found.Phone }), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

function normalizeOrigin(link) {
  try {
    const url = new URL(link);
    return url.origin;
  } catch (e) {
    return '';
  }
}
