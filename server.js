const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY DEVICE STORE ───────────────────────────────────
// In production you'd use a database — this persists until server restarts
// For a more permanent solution, use a simple JSON file
const fs = require('fs');
const DB_FILE = path.join(__dirname, 'devices.json');

function loadDevices() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveDevices(devices) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(devices, null, 2)); } catch(e) {}
}

let devices = loadDevices();
// devices = { [fingerprint]: { status: 'pending'|'approved'|'revoked', label: '', firstSeen: '', lastSeen: '' } }

// ─── HELPERS ──────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── CLIENT ROUTES ────────────────────────────────────────────

// Device registers itself — returns status
app.post('/api/device/register', (req, res) => {
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
    saveDevices(devices);
    console.log(`New device registered: ${fingerprint} (${label})`);
  } else {
    devices[fingerprint].lastSeen = now;
    if (label) devices[fingerprint].label = label;
    saveDevices(devices);
  }

  res.json({ status: devices[fingerprint].status });
});

// Device checks its status
app.post('/api/device/status', (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Missing fingerprint' });
  const device = devices[fingerprint];
  if (!device) return res.json({ status: 'pending' });
  res.json({ status: device.status });
});

// AI proxy — only for approved devices
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

// Admin login check
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: ADMIN_PASSWORD }); // token IS the password — simple but effective
});

// Get all devices
app.get('/api/admin/devices', adminAuth, (req, res) => {
  const list = Object.entries(devices).map(([fp, d]) => ({ fingerprint: fp, ...d }));
  list.sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));
  res.json(list);
});

// Approve a device
app.post('/api/admin/approve', adminAuth, (req, res) => {
  const { fingerprint } = req.body;
  if (!devices[fingerprint]) return res.status(404).json({ error: 'Device not found' });
  devices[fingerprint].status = 'approved';
  saveDevices(devices);
  console.log(`Approved device: ${fingerprint}`);
  res.json({ ok: true });
});

// Revoke a device
app.post('/api/admin/revoke', adminAuth, (req, res) => {
  const { fingerprint } = req.body;
  if (!devices[fingerprint]) return res.status(404).json({ error: 'Device not found' });
  devices[fingerprint].status = 'revoked';
  saveDevices(devices);
  console.log(`Revoked device: ${fingerprint}`);
  res.json({ ok: true });
});

// Delete a device entirely
app.post('/api/admin/delete', adminAuth, (req, res) => {
  const { fingerprint } = req.body;
  delete devices[fingerprint];
  saveDevices(devices);
  res.json({ ok: true });
});

// Update device label
app.post('/api/admin/label', adminAuth, (req, res) => {
  const { fingerprint, label } = req.body;
  if (!devices[fingerprint]) return res.status(404).json({ error: 'Device not found' });
  devices[fingerprint].label = label;
  saveDevices(devices);
  res.json({ ok: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', devices: Object.keys(devices).length });
});

app.listen(PORT, () => {
  console.log(`BizLens server running on port ${PORT}`);
  console.log(`API key: ${ANTHROPIC_API_KEY ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`Admin password: ${ADMIN_PASSWORD !== 'changeme' ? '✓ set' : '⚠ using default — change this!'}`);
});
