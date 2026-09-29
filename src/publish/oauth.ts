import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import { SECRETS } from '../config.js';
import { log } from '../log.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_FILE_MODE = 0o600;

type GoogleClientJson = {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
};

function clientJsonPath(): string {
  return path.join(SECRETS, 'google-client.json');
}
function tokenPath(): string {
  return path.join(SECRETS, 'youtube-token.json');
}

function readClientCreds(): { client_id: string; client_secret: string } | null {
  const p = clientJsonPath();
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as GoogleClientJson;
  return raw.installed ?? raw.web ?? null;
}

// Tokens are credentials, not ordinary data — 0600 keeps them owner-read/write-only on POSIX.
// (Windows has no equivalent bit; chmodSync there is a best-effort no-op past the read-only flag.)
function writeTokenFile(tokens: unknown): void {
  fs.mkdirSync(SECRETS, { recursive: true });
  const p = tokenPath();
  fs.writeFileSync(p, JSON.stringify(tokens, null, 2), { mode: TOKEN_FILE_MODE });
  try {
    fs.chmodSync(p, TOKEN_FILE_MODE);
  } catch {
    /* best effort */
  }
}

function printSetupInstructions(): void {
  log(`No Google OAuth client found at ${clientJsonPath()}`);
  log('');
  log('Set one up (one-time):');
  log('  1. Open https://console.cloud.google.com/ and create (or pick) a project.');
  log('  2. APIs & Services -> Library: enable "YouTube Data API v3" and "YouTube Analytics API".');
  log('  3. APIs & Services -> OAuth consent screen: configure it (External is fine; add your own');
  log('     Google account as a test user while the app is unverified).');
  log('  4. APIs & Services -> Credentials -> Create credentials -> OAuth client ID');
  log('     -> Application type "Desktop app".');
  log('  5. Download the client JSON and save it as .secrets/google-client.json');
  log('');
  log('Then run `cb auth youtube` again.');
}

function openUrl(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'win32' ? `start "" "${url}"` : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best-effort — the URL is also printed for manual copy/paste */
  });
}

export type OAuthCallbackResult =
  | { ok: true; code: string }
  // state mismatch means this request isn't the real redirect (a stray/forged hit on the
  // loopback port) — the server keeps listening rather than failing the whole flow on it.
  | { ok: false; keepWaiting: true; reason: string }
  // these came from a request that DID carry our state, so they're a genuine terminal outcome
  // (the user declined consent, or a malformed redirect) and should end the flow.
  | { ok: false; keepWaiting: false; reason: string };

// Pure: validates one redirect hit against the state we handed to generateAuthUrl, independent
// of the http server so it's directly unit-testable.
export function parseOAuthCallback(searchParams: URLSearchParams, expectedState: string): OAuthCallbackResult {
  const state = searchParams.get('state');
  if (state !== expectedState) {
    return { ok: false, keepWaiting: true, reason: 'state mismatch' };
  }
  const err = searchParams.get('error');
  if (err) return { ok: false, keepWaiting: false, reason: `OAuth consent error: ${err}` };
  const code = searchParams.get('code');
  if (!code) return { ok: false, keepWaiting: false, reason: 'redirect had no authorization code' };
  return { ok: true, code };
}

// Installed-app (loopback) OAuth flow: reads the Desktop-app client JSON the user downloaded
// from Google Cloud Console, opens the consent page on a random 127.0.0.1 port, exchanges the
// authorization code and saves the resulting tokens to .secrets/youtube-token.json.
export async function authorize(): Promise<void> {
  const creds = readClientCreds();
  if (!creds) {
    printSetupInstructions();
    process.exitCode = 1;
    return;
  }

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const redirectUri = `http://127.0.0.1:${port}`;

  const state = crypto.randomBytes(16).toString('hex');
  const client = new OAuth2Client({ clientId: creds.client_id, clientSecret: creds.client_secret, redirectUri });
  const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });

  log('Open this URL to authorize clipbrain (opening your browser now):');
  log(authUrl);
  openUrl(authUrl);

  let code: string;
  try {
    code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`OAuth consent timed out after ${OAUTH_TIMEOUT_MS / 60000} minutes — run \`cb auth youtube\` again`));
      }, OAUTH_TIMEOUT_MS);
      timer.unref?.();

      server.on('request', (req, res) => {
        let url: URL;
        try {
          url = new URL(req.url ?? '/', redirectUri);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('bad request');
          return;
        }

        const result = parseOAuthCallback(url.searchParams, state);
        if (!result.ok) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(`clipbrain: ${result.reason}`);
          if (result.keepWaiting) return; // not our redirect — keep the server up
          clearTimeout(timer);
          reject(new Error(result.reason));
          return;
        }

        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>clipbrain: authorized. You can close this tab.</body></html>');
        resolve(result.code);
      });
    });
  } finally {
    server.close();
  }

  const { tokens } = await client.getToken(code);
  writeTokenFile(tokens);
  log(`Saved credentials to ${tokenPath()}`);
}

// null when there's no client config or no saved token yet. Refreshed tokens are persisted
// automatically via the 'tokens' event google-auth-library emits after a silent refresh.
export async function getClient(): Promise<OAuth2Client | null> {
  const creds = readClientCreds();
  const tPath = tokenPath();
  if (!creds || !fs.existsSync(tPath)) return null;

  const tokens = JSON.parse(fs.readFileSync(tPath, 'utf8'));
  const client = new OAuth2Client({ clientId: creds.client_id, clientSecret: creds.client_secret });
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    writeTokenFile({ ...tokens, ...newTokens });
  });
  return client;
}
