// Fetches a third-party integration key (ServiceM8, Anthropic, Pylon, ...)
// from the api_keys table instead of a baked-in environment variable, so
// an admin can rotate a key from Settings without a redeploy.
//
// Usage from any other function:
//   const { getIntegrationKey } = require('./_shared/get-integration-key');
//   const smKey = await getIntegrationKey('servicem8');
//
// Falls back to an environment variable of the same name (uppercased,
// e.g. SERVICEM8_API_KEY) if no row exists yet — so this can be dropped
// in without breaking anything before the Settings UI has been used.

const { getAdminClient } = require('./require-admin');

async function getIntegrationKey(keyName) {
  const supabaseAdmin = getAdminClient();
  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('key_value')
    .eq('key_name', keyName)
    .maybeSingle();

  if (!error && data?.key_value) return data.key_value;

  const envFallback = process.env[`${keyName.toUpperCase()}_API_KEY`];
  if (envFallback) return envFallback;

  throw new Error(`No API key configured for "${keyName}" — set it in Settings > API Keys.`);
}

module.exports = { getIntegrationKey };
