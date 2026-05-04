# BizLens v2 — Setup Guide

## What's in this package

```
bizlens-v2/
  server.js          ← backend server (holds your API key, manages devices)
  package.json       ← dependencies
  public/
    index.html       ← the app you share with clients
    admin.html       ← your private admin panel (only you use this)
```

---

## How it works

1. You deploy the server to Railway (free, ~10 min, one time)
2. A client opens index.html — their device is fingerprinted and flagged as "pending"
3. You open admin.html, see the pending device, click Approve
4. That device can now use the full AI dashboard
5. If you ever want to cut someone off — click Revoke in the admin panel

---

## Step 1 — Get your Anthropic API key

Go to https://console.anthropic.com, sign up, and create an API key.
Keep it somewhere safe — you'll need it in Step 3.

---

## Step 2 — Deploy to Railway

1. Go to https://railway.app and create a free account
2. Click "New Project" → "Deploy from GitHub" OR drag the entire bizlens-v2 folder
3. Railway will detect it's a Node.js app and deploy automatically
4. Wait ~2 minutes for the first deploy to finish

---

## Step 3 — Set your environment variables

In Railway, click your service → "Variables" tab → add these:

| Variable            | Value                        |
|---------------------|------------------------------|
| ANTHROPIC_API_KEY   | sk-ant-your-key-here         |
| ADMIN_PASSWORD      | choose a strong password     |

Click "Deploy" after saving variables.

---

## Step 4 — Get your URL and update the client file

1. In Railway → Settings → Networking → click "Generate Domain"
2. You'll get a URL like: https://bizlens-production.up.railway.app
3. Open public/index.html in a text editor
4. Find this line near the top of the <script> section:
   const SERVER = 'YOUR_RAILWAY_URL_HERE';
5. Replace it with your actual URL:
   const SERVER = 'https://bizlens-production.up.railway.app';
6. Save the file and re-upload it to Railway (or redeploy)

---

## Step 5 — Access your admin panel

Go to: https://your-railway-url.up.railway.app/admin.html
Enter the ADMIN_PASSWORD you set in Step 3.

Bookmark this — it's your control panel.

---

## Step 6 — Share the client with clients

Share the file public/index.html with any client.
When they open it, they'll see "Waiting for authorization."
You'll see them appear in your admin panel within seconds.
Click Approve and they're in.

---

## Day-to-day usage

- New client? Send them index.html, approve them in admin.html
- Want to cut someone off? Click Revoke in admin.html — instant
- Want to see who's using it? Check admin.html anytime
- Admin panel auto-refreshes every 15 seconds

---

## Estimated costs

Railway free tier: $5 credit/month (plenty for low traffic)
Anthropic API: ~$0.01-0.02 per dashboard generation
100 clients, 10 uses/month each: ~$10-20/month total

---

## Troubleshooting

"Waiting for authorization" won't go away
→ Open admin.html and approve the device

"Could not connect to server"
→ Check that your Railway server is running (Railway dashboard)
→ Make sure SERVER URL in index.html matches your Railway URL exactly

Admin panel says wrong password
→ Check ADMIN_PASSWORD in Railway Variables tab

Server starts but AI doesn't work
→ Check ANTHROPIC_API_KEY in Railway Variables tab
