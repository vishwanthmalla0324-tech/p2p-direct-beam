import fs from 'fs';
import { spawn } from 'child_process';

const envFile = fs.readFileSync('.env', 'utf8');
const secrets = {};
envFile.split('\n').forEach(line => {
  const m = line.match(/^([A-Z0-9_]+)="?([^"\r\n]+)"?/);
  if (m) secrets[m[1]] = m[2].trim();
});

const required = [
  'LEMONSQUEEZY_API_KEY',
  'LEMONSQUEEZY_STORE_ID',
  'LEMONSQUEEZY_WEBHOOK_SECRET',
  'LEMONSQUEEZY_VARIANT_ID'
];

async function putSecret(key, val) {
  return new Promise((resolve, reject) => {
    console.log(`Setting secret: ${key} (length: ${val.length})...`);
    // On Windows, use npx.cmd
    const child = spawn('npx', ['wrangler', 'secret', 'put', key], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    let stdout = '';

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    child.on('close', code => {
      if (code === 0) {
        console.log(`  -> Successfully set ${key}`);
        resolve();
      } else {
        console.error(`  -> Failed to set ${key}:`, stderr || stdout);
        reject(new Error(stderr || stdout));
      }
    });

    // Write value directly to stdin without trailing newline
    child.stdin.write(val);
    child.stdin.end();
  });
}

async function main() {
  for (const k of required) {
    const val = secrets[k];
    if (!val) {
      console.error(`Missing ${k} in .env!`);
      continue;
    }
    await putSecret(k, val);
  }
  console.log('\n✅ All Lemon Squeezy Cloudflare Worker secrets set successfully!');
}

main().catch(console.error);
