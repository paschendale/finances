#!/usr/bin/env node
// One-time Gmail OAuth consent for the advisor's mailbox watcher.
//
//   node advisor/ops/gmail-auth.mjs --client-json <downloaded client_secret_*.json> [--out <file>] [--port 8765] [--modify]
//   node advisor/ops/gmail-auth.mjs <client_id> <client_secret> [--out <file>] [--port 8765] [--modify]
//
// Google Cloud setup: enable the Gmail API, publish the OAuth consent screen (an app left in "Testing"
// gets refresh tokens that expire after 7 days), then create an OAuth client. A *Desktop app* client
// accepts the loopback redirect as is; a *Web application* client must list
// http://127.0.0.1:<port>/callback under "Authorized redirect URIs" (this script prints the exact value).
//
// The three variables are written to --out (default ~/.config/finances-advisor/gmail.env, mode 600),
// never to the terminal.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const has = (name) => args.includes(name);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--client-json', '--out', '--port'].includes(args[i - 1])));

let clientId;
let clientSecret;
const clientJson = flag('--client-json');
if (clientJson) {
  const raw = JSON.parse(fs.readFileSync(clientJson, 'utf8'));
  const body = raw.installed ?? raw.web ?? raw;
  clientId = body.client_id;
  clientSecret = body.client_secret;
  if (!clientId || !clientSecret) fail(`no client_id/client_secret in ${clientJson}`);
  if (raw.web) console.log('Client type: Web application. Its "Authorized redirect URIs" must include the redirect below.');
  else if (raw.installed) console.log('Client type: Desktop app.');
} else {
  [clientId, clientSecret] = positional;
  if (!clientId || !clientSecret) fail('usage: node advisor/ops/gmail-auth.mjs --client-json <file> [--out <file>] [--port 8765] [--modify]');
}

const port = Number(flag('--port', '8765'));
const out = flag('--out', path.join(os.homedir(), '.config', 'finances-advisor', 'gmail.env'));
const scope = has('--modify') ? 'https://www.googleapis.com/auth/gmail.modify' : 'https://www.googleapis.com/auth/gmail.readonly';
const redirect = `http://127.0.0.1:${port}/callback`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: 'code',
  scope,
  access_type: 'offline',
  prompt: 'consent',
}).toString();

console.log(`\nRedirect URI used by this script: ${redirect}`);
console.log('\nOpen this URL in a browser logged into the mailbox to watch:\n\n' + authUrl.toString() + '\n');
console.log(`Waiting for Google to call back on ${redirect} … (Ctrl+C to abort)`);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', redirect);
  if (u.pathname !== '/callback') {
    res.end('waiting for the Google callback');
    return;
  }
  const err = u.searchParams.get('error');
  if (err) {
    res.end(`Google returned an error: ${err}. Check the terminal.`);
    console.error(`\nGoogle returned: ${err} ${u.searchParams.get('error_description') ?? ''}`);
    return;
  }
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
    res.end('No refresh token returned. Revoke the app at myaccount.google.com/permissions and retry. Check the terminal.');
    console.error('\nToken exchange did not return a refresh_token:', { error: j.error, error_description: j.error_description, scope: j.scope });
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, `GMAIL_CLIENT_ID=${clientId}\nGMAIL_CLIENT_SECRET=${clientSecret}\nGMAIL_REFRESH_TOKEN=${j.refresh_token}\n`, { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  res.end('Done. You can close this tab.');
  console.log(`\nSaved GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN to ${out} (mode 600). Scope: ${j.scope ?? scope}`);
  server.close();
});
server.on('error', (e) => fail(`could not listen on ${redirect}: ${e.message}`));
server.listen(port, '127.0.0.1');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
