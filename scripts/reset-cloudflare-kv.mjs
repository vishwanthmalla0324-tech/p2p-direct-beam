import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const NAMESPACE_ID = '6226ab1f246c49f3a40fe36fdfed552b';
const TEMP_FILE = path.join(process.cwd(), 'temp_user_val.json');

function runWrangler(cmd) {
  return execSync(`npx wrangler ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

async function main() {
  console.log('Fetching remote KV keys...');
  const keysOutput = runWrangler(`kv key list --remote --namespace-id=${NAMESPACE_ID}`);
  const keys = JSON.parse(keysOutput);

  console.log(`Found ${keys.length} total remote keys in USERS_KV.`);

  const userKeys = keys.filter(k => k.name.startsWith('user:'));
  const orderKeys = keys.filter(k => k.name.startsWith('order:'));
  const paymentKeys = keys.filter(k => k.name.startsWith('payment:'));

  console.log(`\n--- Resetting ${userKeys.length} Users (Pro -> false, transfersCount -> 0) ---`);
  for (const uk of userKeys) {
    try {
      const userRaw = runWrangler(`kv key get --remote --namespace-id=${NAMESPACE_ID} "${uk.name}"`);
      const user = JSON.parse(userRaw);
      
      console.log(`Updating ${uk.name} (${user.email}). Current: transfersCount=${user.transfersCount}, pro=${user.pro}`);

      user.transfersCount = 0;
      user.freeSharesUsed = 0;
      user.pro = false;
      user.isPro = false;
      user.plan = 'FREE';

      delete user.proPaymentId;
      delete user.proOrderId;
      delete user.proPaymentGateway;
      delete user.proActivatedAt;
      delete user.lemonSqueezyOrderId;
      delete user.lemonSqueezyCustomerId;
      delete user.licenseKey;

      fs.writeFileSync(TEMP_FILE, JSON.stringify(user), 'utf8');

      // Put updated user back to KV using --path to avoid shell quoting problems
      runWrangler(`kv key put --remote --namespace-id=${NAMESPACE_ID} "${uk.name}" --path="${TEMP_FILE}"`);
      console.log(`  -> Successfully reset ${uk.name} to FREE with 0/3 transfers used.`);
    } catch (err) {
      console.error(`  -> Error processing ${uk.name}:`, err.message);
    }
  }

  if (fs.existsSync(TEMP_FILE)) {
    fs.unlinkSync(TEMP_FILE);
  }

  console.log(`\n--- Deleting ${orderKeys.length} Test Orders ---`);
  for (const ok of orderKeys) {
    try {
      runWrangler(`kv key delete --remote --namespace-id=${NAMESPACE_ID} "${ok.name}"`);
      console.log(`  Deleted ${ok.name}`);
    } catch (err) {
      console.error(`  Error deleting ${ok.name}:`, err.message);
    }
  }

  console.log(`\n--- Deleting ${paymentKeys.length} Test Payments ---`);
  for (const pk of paymentKeys) {
    try {
      runWrangler(`kv key delete --remote --namespace-id=${NAMESPACE_ID} "${pk.name}"`);
      console.log(`  Deleted ${pk.name}`);
    } catch (err) {
      console.error(`  Error deleting ${pk.name}:`, err.message);
    }
  }

  console.log('\n✅ Remote KV Launch Reset Complete! All users have 0/3 trials used (3 free trials ready).');
}

main().catch(err => {
  if (fs.existsSync(TEMP_FILE)) {
    fs.unlinkSync(TEMP_FILE);
  }
  console.error('Migration script failed:', err);
  process.exit(1);
});
