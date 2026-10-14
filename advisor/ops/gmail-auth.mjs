#!/usr/bin/env node
// One-time Gmail OAuth consent for the advisor's mailbox watcher.
// Usage: node advisor/ops/gmail-auth.mjs <client_id> <client_secret> [--modify]
// Creates a Desktop OAuth client in Google Cloud first (APIs & Services → Credentials), enable the Gmail API.
import http from 'node:http';
import { URL } from 'node:url';

const [clientId, clientSecret, ...flags] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('usage: node advisor/ops/gmail-auth.mjs <client_id> <client_secret> [--modify]');
  process.exit(1);
}
const scope = flags.includes('--modify') ? 'https://www.googleapis.com/auth/gmail.modify' : 'https://www.googleapis.com/auth/gmail.readonly';
const port = 8765;
const redirect = `http://127.0.0.1:${port}/callback`;
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent' }).toString();

console.log('\nOpen this URL in a browser logged into the mailbox to watch:\n\n' + authUrl.toString() + '\n');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', redirect);
  if (u.pathname !== '/callback') return res.end('waiting');
  const code = u.searchParams.get('code');
  if (!code) {
    res.end('missing code');
    return;
  }
  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await tok.json();
  if (!j.refresh_token) {
    res.end('no refresh token returned; revoke the app at myaccount.google.com/permissions and retry');
    console.error(j);
    process.exit(1);
  }
  res.end('Done. You can close this tab.');
  console.log('\nGMAIL_CLIENT_ID=' + clientId);
  console.log('GMAIL_CLIENT_SECRET=' + clientSecret);
  console.log('GMAIL_REFRESH_TOKEN=' + j.refresh_token + '\n');
  server.close();
});
server.listen(port, '127.0.0.1');
