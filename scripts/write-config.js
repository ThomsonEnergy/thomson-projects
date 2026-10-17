// Netlify build step. Points non-production deploys (branch deploys, deploy
// previews) at the staging Supabase branch instead of the live database.
//
// public/js/supabase-client.js holds the live URL and anon key. On a
// non-production deploy with SUPABASE_URL and SUPABASE_ANON_KEY set for that
// deploy context in Netlify, this swaps them in the build copy only (the repo
// file is never committed changed). Production deploys are left untouched.
const fs = require('fs');
const path = require('path');

const context = process.env.CONTEXT || 'local';
const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const file = path.join(__dirname, '..', 'public', 'js', 'supabase-client.js');

if (context === 'production') {
  console.log('write-config: production deploy, live Supabase values kept');
  process.exit(0);
}
if (!url || !anonKey) {
  console.log(`write-config: ${context} deploy has no SUPABASE_URL / SUPABASE_ANON_KEY, live values kept`);
  process.exit(0);
}

const URL_RE = /^const SUPABASE_URL = '[^']*';/m;
const KEY_RE = /^const SUPABASE_ANON_KEY = '[^']*';/m;
const src = fs.readFileSync(file, 'utf8');
if (!URL_RE.test(src) || !KEY_RE.test(src)) {
  console.error('write-config: could not find the Supabase constants in supabase-client.js');
  process.exit(1);
}
const out = src
  .replace(URL_RE, `const SUPABASE_URL = '${url}';`)
  .replace(KEY_RE, `const SUPABASE_ANON_KEY = '${anonKey}';`);
if (out === src) {
  console.log(`write-config: ${context} deploy env matches the live values, nothing to change (set staging values for this context to use staging)`);
  process.exit(0);
}
fs.writeFileSync(file, out);
console.log(`write-config: ${context} deploy now points at ${url}`);
