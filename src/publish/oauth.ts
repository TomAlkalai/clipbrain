import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { exec } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import { SECRETS } from '../config.js';
import { log } from '../log.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

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

  const client = new OAuth2Client({ clientId: creds.client_id, clientSecret: creds.client_secret, redirectUri });
  const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  log('Open this URL to authorize clipbrain (opening your browser now):');
  log(authUrl);
  openUrl(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url ?? '/', redirectUri);
        const err = url.searchParams.get('error');
        const c = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>clipbrain: authorized. You can close this tab.</body></html>');
        if (err) {
          reject(new Error(`OAuth consent error: ${err}`));
        } else if (c) {
          resolve(c);
        }
      } catch (e) {
        reject(e);
      }
    });
  });
  server.close();

  const { tokens } = await client.getToken(code);
  fs.mkdirSync(SECRETS, { recursive: true });
  fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2));
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
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(tPath, JSON.stringify(merged, null, 2));
  });
  return client;
}
