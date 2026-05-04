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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY DEVICE STORE ───────────────────────────────────
// Primary store is in memory, backed up to DEVICES_JSON env var via Railway API
let devices = {};

// Load devices from environment variable on startup
function loadDevices() {
  try {
    const raw = process.env.DEVICES_JSON;
    if (raw) {
      devices = JSON.parse(raw);
      console.log(`Loaded ${Object.keys(devices).length} devices from environment`);
    }
  } catch(e) {
    console.error('Failed to load devices:', e);
    devices = {};
  }
}

// Save devices to Railway environment variable via API
async function saveDevices() {
  if (!RAILWAY_API_TOKEN || !RAILWAY_PROJECT_ID || !RAILWAY_ENVIRONMENT_ID || !RAILWAY_SERVICE_ID) {
    console.warn('Railway API credentials not set — devices will not persist across restarts');
    return;
  }

  try {
    const mutation = `
      mutation UpsertVariables($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `;

    await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RAILWAY_API_TOKEN}`
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            projectId: RAILWAY_PROJECT_ID,
            environmentId: RAILWAY_ENVIRONMENT_ID,
            serviceId: RAILWAY_SERVICE_ID,
            variables: {
              DEVICES_JSON: JSON.stringify(devices)
            }
          }
        }
      })
    });
    console.log('Devices saved to Railway environment');
  } catch(e) {
    console.error('Failed to save devices to Railway:', e);
  }
}

loadDevices();

// ─── HELPERS ──────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── CLIENT ROUTES ────────────────────────────────────────────

app.post('/api/device/register', async (req, res) => {
  const { fingerprint, label } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });

  const now = new Date().toISOString();

  if (!devices[fingerprint]) {
    devices[fingerprint] = {
      status: 'pending',
      label: label || 'Unknown device',
      firstSeen: now,
      lastSeen: now
    };
    await saveDevices();
    console.log(`New device registered: ${fingerprint} (${label})`);
  } else {
    devices[fingerprint].lastSeen = now;
    if (label) devices[fingerprint].label = label;
    await saveDevices();
  }

  res.json({ status: devices[fingerprint].status });
});

app.post('/api/device/status', (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });
  const device = devices[fingerprint];
  if (!device) return res.json({ status: 'pending' });
  res.json({ status: device.status });
});

app.post('/api/analyze', async (req, res) => {
  const { fingerprint, messages } = req.body;

  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });

  const device = devices[fingerprint];
  if (!device || device.status !== 'approved') {
    return res.status(403).json({ error: 'Device not authorized' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server API key not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });
    res.json(data);
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: ADMIN_PASSWORD });
});

app.get('/api/admin/devices', adminAuth, (req, res) => {
  const list = Object.entries(devices).map(([fp, d]) => ({ fingerprint: fp, ...d }));
  list.sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));
  res.json(list);
});

app.post('/api/admin/approve', adminAuth, async (req, res) => {
  const { fingerprint } = req.body;
  if (!devices[fingerprint]) return res.status(404).json({ error: 'Device not found' });
  devices[fingerprint].status = 'approved';
  await saveDevices();
  console.log(`Approved device: ${fingerprint}`);
  res.json({ ok: true });
});

app.post('/api/admin/revoke', adminAuth, async (req, res) => {
  const { fingerprint } = req.body;
  if (!devices[fingerprint]) return res.status(404).json({ error: 'Device not found' });
  devices[fingerprint].status = 'revoked';
  await saveDevices();
  console.log(`Revoked device: ${fingerprint}`);
  res.json({ ok: true });
});

app.post('/api/admin/delete', adminAuth, async (req, res) => {
  const { fingerprint } = req.body;
  delete devices[fingerprint];
  await saveDevices();
  res.json({ ok: true });
});

app.post('/api/admin/label', adminAuth, async (req, res) => {
  const { fingerprint, label } = req.body;
  if (!devices[fingerprint]) return res.status(404).json({ error: 'Device not found' });
  devices[fingerprint].label = label;
  await saveDevices();
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', devices: Object.keys(devices).length });
});

app.listen(PORT, () => {
  console.log(`BizLens server running on port ${PORT}`);
  console.log(`API key: ${ANTHROPIC_API_KEY ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`Admin password: ${ADMIN_PASSWORD !== 'changeme' ? '✓ set' : '⚠ using default'}`);
  console.log(`Railway persistence: ${RAILWAY_API_TOKEN ? '✓ enabled' : '⚠ disabled — devices will not persist'}`);
});
