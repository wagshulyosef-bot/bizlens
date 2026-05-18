const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
const RAILWAY_PROJECT_ID = process.env.RAILWAY_PROJECT_ID;
const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID;
const RAILWAY_SERVICE_ID = process.env.RAILWAY_SERVICE_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://bizlens-production.up.railway.app';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DEVICE STORE
let devices = {};
let googleTokens = {};
let saveTimer = null;

function loadDevices() {
  try {
    const raw = process.env.DEVICES_JSON;
    if (raw) { devices = JSON.parse(raw); console.log(`Loaded ${Object.keys(devices).length} devices`); }
  } catch(e) { devices = {}; }
}

function loadGoogleTokens() {
  try {
    const raw = process.env.GOOGLE_TOKENS_JSON;
    if (raw) { googleTokens = JSON.parse(raw); console.log(`Loaded ${Object.keys(googleTokens).length} Google tokens`); }
  } catch(e) { googleTokens = {}; }
}

async function saveToRailway(vars) {
  if (!RAILWAY_API_TOKEN || !RAILWAY_PROJECT_ID || !RAILWAY_ENVIRONMENT_ID || !RAILWAY_SERVICE_ID) return;
  try {
    await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RAILWAY_API_TOKEN}` },
      body: JSON.stringify({
        query: `mutation UpsertVariables($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
        variables: { input: { projectId: RAILWAY_PROJECT_ID, environmentId: RAILWAY_ENVIRONMENT_ID, serviceId: RAILWAY_SERVICE_ID, variables: vars } }
      })
    });
  } catch(e) { console.error('Failed to save to Railway:', e); }
}

let saveTimer = null;
function saveDevices() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveToRailway({ DEVICES_JSON: JSON.stringify(devices) });
    console.log('Devices saved to Railway');
  }, 500);
}

let tokenSaveTimer = null;
function saveGoogleTokens() {
  if (tokenSaveTimer) clearTimeout(tokenSaveTimer);
  tokenSaveTimer = setTimeout(async () => {
    await saveToRailway({ GOOGLE_TOKENS_JSON: JSON.stringify(googleTokens) });
    console.log('Google tokens saved to Railway');
  }, 500);
}

loadDevices();
loadGoogleTokens();

function adminAuth(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function deviceAuth(req, res, next) {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });
  const device = devices[fingerprint];
  if (!device || device.status !== 'approved') return res.status(403).json({ error: 'Device not authorized' });
  next();
}

// GOOGLE OAUTH
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

app.get('/auth/google', (req, res) => {
  const { fingerprint } = req.query;
  if (!fingerprint) return res.status(400).send('Missing fingerprint');
  const state = Buffer.from(JSON.stringify({ fingerprint })).toString('base64');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`<script>window.opener.postMessage({type:'google_auth_error',error:'${error}'},'*');window.close();</script>`);
  try {
    const { fingerprint } = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: `${BASE_URL}/auth/google/callback`, grant_type: 'authorization_code' })
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description);
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const user = await userRes.json();
    googleTokens[fingerprint] = { ...tokens, email: user.email, connectedAt: new Date().toISOString() };
    saveGoogleTokens();
    res.send(`<script>window.opener.postMessage({type:'google_auth_success',email:'${user.email}'},'*');window.close();</script>`);
  } catch(e) {
    res.send(`<script>window.opener.postMessage({type:'google_auth_error',error:'${e.message}'},'*');window.close();</script>`);
  }
});

app.post('/api/google/status', deviceAuth, (req, res) => {
  const tokens = googleTokens[req.body.fingerprint];
  res.json({ connected: !!tokens, email: tokens?.email || null });
});

async function getValidAccessToken(fingerprint) {
  const tokens = googleTokens[fingerprint];
  if (!tokens) throw new Error('Not connected to Google');
  if (tokens.refresh_token) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' })
    });
    const refreshed = await res.json();
    if (!refreshed.error) { googleTokens[fingerprint] = { ...tokens, ...refreshed }; saveGoogleTokens(); return refreshed.access_token; }
  }
  return tokens.access_token;
}

// GMAIL
app.post('/api/gmail/send', deviceAuth, async (req, res) => {
  const { fingerprint, to, subject, body } = req.body;
  try {
    const accessToken = await getValidAccessToken(fingerprint);
    const email = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
    const encoded = Buffer.from(email).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded })
    });
    const data = await gmailRes.json();
    if (!gmailRes.ok) throw new Error(data.error?.message || 'Gmail error');
    res.json({ ok: true, messageId: data.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GOOGLE CALENDAR
app.post('/api/calendar/create', deviceAuth, async (req, res) => {
  const { fingerprint, title, description, start, end, attendees } = req.body;
  try {
    const accessToken = await getValidAccessToken(fingerprint);

    // Ensure datetime strings are in correct format for Pacific time
    // If the datetime doesn't have timezone info, treat it as Pacific time
    function toCalendarDateTime(dt) {
      if (!dt) return new Date().toISOString();
      // If already has timezone offset, use as-is
      if (dt.includes('+') || dt.includes('Z') || (dt.includes('-') && dt.lastIndexOf('-') > 7)) {
        return new Date(dt).toISOString();
      }
      // Otherwise treat as Pacific local time by appending offset
      // Pacific is UTC-7 (PDT) or UTC-8 (PST) — use -07:00 as default
      return new Date(dt + '-07:00').toISOString();
    }

    const startDT = toCalendarDateTime(start);
    const endDT = toCalendarDateTime(end);

    const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: title,
        description,
        start: { dateTime: startDT, timeZone: 'America/Los_Angeles' },
        end: { dateTime: endDT, timeZone: 'America/Los_Angeles' },
        attendees: attendees?.map(e => ({ email: e })) || []
      })
    });
    const data = await calRes.json();
    if (!calRes.ok) throw new Error(data.error?.message || 'Calendar error');
    res.json({ ok: true, eventId: data.id, link: data.htmlLink });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AI AGENT
app.post('/api/agent', deviceAuth, async (req, res) => {
  const { fingerprint, messages, businessContext } = req.body;
  const tokens = googleTokens[fingerprint];
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const today = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const todayISO = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const systemPrompt = `You are an AI business assistant for Clarity AI Pro. You help business owners with invoicing, scheduling, and customer follow-up.

BUSINESS CONTEXT:
${businessContext || 'No business context provided.'}

GOOGLE CONNECTION: ${tokens ? `Connected as ${tokens.email}` : 'Not connected to Google'}

TODAY IS: ${today} (${todayISO}) Pacific Time. Use this to calculate exact dates when the user says things like "next Friday" or "Thursday". Always use the correct YYYY-MM-DD date in your response.

You can help draft emails, calendar events, and invoices. When writing emails, write them the way a real person would — casual, direct, short sentences, no corporate fluff, no "I hope this email finds you well", no "please don't hesitate to reach out". Sound like the business owner themselves wrote it. When drafting something, respond ONLY with this JSON format:
{
  "message": "conversational response explaining what you drafted",
  "draft": {
    "type": "email|calendar|invoice|none",
    "email": { "to": "", "subject": "", "body": "" },
    "calendar": { "title": "", "description": "", "start": "2026-05-10T16:30:00", "end": "2026-05-10T17:30:00", "attendees": [] },
    "invoice": { "client": "", "items": [{"description": "", "amount": 0}], "total": 0, "dueDate": "" }
  }
}

For regular conversation with no draft, use type "none". Be concise and specific to their business.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1500, system: systemPrompt, messages })
    });
    const data = await aiRes.json();
    if (!aiRes.ok) throw new Error(data.error?.message || 'AI error');
    const text = data.content.map(b => b.text || '').join('');
    try { res.json(JSON.parse(text.replace(/```json|```/g,'').trim())); }
    catch { res.json({ message: text, draft: { type: 'none' } }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CLAUDE DIRECT CHAT
app.post('/api/chat', async (req, res) => {
  const { fingerprint, messages, businessContext } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });
  if (!devices[fingerprint] || devices[fingerprint].status !== 'approved') return res.status(403).json({ error: 'Device not authorized' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server API key not configured' });

  const system = `You are Claude, a helpful AI assistant built into Clarity AI Pro, a business intelligence platform. You help small business owners think through problems, get advice, and make better decisions.
${businessContext ? `\nContext about the user's business: ${businessContext}` : ''}
Be conversational, direct, and practical. Reference their business context when relevant.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, system, messages, stream: true })
    });

    if (!aiRes.ok) {
      const err = await aiRes.json();
      return res.status(aiRes.status).json({ error: err.error?.message || 'AI error' });
    }

    // Stream response to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = aiRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
          }
        } catch(e) {}
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DEVICE ROUTES
app.post('/api/device/register', async (req, res) => {
  const { fingerprint, label, timeWasters } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });
  const now = new Date().toISOString();
  if (!devices[fingerprint]) {
    devices[fingerprint] = { status: 'pending', label: label || 'Unknown device', timeWasters: timeWasters || '', firstSeen: now, lastSeen: now };
    saveDevices();
  } else {
    devices[fingerprint].lastSeen = now;
    if (label) devices[fingerprint].label = label;
    if (timeWasters) devices[fingerprint].timeWasters = timeWasters;
    saveDevices();
  }
  res.json({ status: devices[fingerprint].status });
});

app.post('/api/device/status', (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });
  const device = devices[fingerprint];
  if (!device) return res.json({ status: 'pending', exists: false });
  res.json({ status: device.status, exists: true });
});

app.post('/api/analyze', async (req, res) => {
  const { fingerprint, messages } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });
  if (!devices[fingerprint] || devices[fingerprint].status !== 'approved') return res.status(403).json({ error: 'Device not authorized' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server API key not configured' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2500, messages })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });
    res.json(data);
  } catch(err) { res.status(500).json({ error: 'Server error' }); }
});

// ADMIN ROUTES
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: ADMIN_PASSWORD });
});
app.get('/api/admin/devices', adminAuth, (req, res) => {
  res.json(Object.entries(devices).map(([fp, d]) => ({ fingerprint: fp, ...d })).sort((a,b) => new Date(b.firstSeen)-new Date(a.firstSeen)));
});
app.post('/api/admin/approve', adminAuth, async (req, res) => {
  if (!devices[req.body.fingerprint]) return res.status(404).json({ error: 'Not found' });
  devices[req.body.fingerprint].status = 'approved'; saveDevices(); res.json({ ok: true });
});
app.post('/api/admin/revoke', adminAuth, async (req, res) => {
  if (!devices[req.body.fingerprint]) return res.status(404).json({ error: 'Not found' });
  devices[req.body.fingerprint].status = 'revoked'; saveDevices(); res.json({ ok: true });
});
app.post('/api/admin/delete', adminAuth, async (req, res) => {
  delete devices[req.body.fingerprint]; saveDevices(); res.json({ ok: true });
});
app.post('/api/admin/label', adminAuth, async (req, res) => {
  if (!devices[req.body.fingerprint]) return res.status(404).json({ error: 'Not found' });
  devices[req.body.fingerprint].label = req.body.label; saveDevices(); res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok', devices: Object.keys(devices).length }));

app.listen(PORT, () => {
  console.log(`Clarity AI Pro server running on port ${PORT}`);
  console.log(`API key: ${ANTHROPIC_API_KEY ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`Admin password: ${ADMIN_PASSWORD !== 'changeme' ? '✓ set' : '⚠ using default'}`);
  console.log(`Google OAuth: ${GOOGLE_CLIENT_ID ? '✓ configured' : '⚠ not configured'}`);
  console.log(`Railway persistence: ${RAILWAY_API_TOKEN ? '✓ enabled' : '⚠ disabled'}`);
});
