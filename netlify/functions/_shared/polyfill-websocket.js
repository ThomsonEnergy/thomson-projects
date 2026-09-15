// @supabase/supabase-js's createClient() eagerly builds a Realtime client
// (via @supabase/realtime-js) even when nothing here ever subscribes to a
// realtime channel, and doing so requires a native WebSocket global - which
// Node only ships by default from v22 onward. This project is pinned to
// Node 18 (see .nvmrc/package.json - needed for AWS Lambda's Amazon Linux
// 2023 runtime), so every single function calling createClient() started
// throwing "Node.js detected but native WebSocket not found" the moment
// @supabase/supabase-js picked up a newer realtime-js with this behaviour -
// a site-wide outage, not specific to any one function.
//
// Require this before requiring @supabase/supabase-js, in every file that
// calls createClient() directly (grep for "@supabase/supabase-js" if
// adding a new one) - satisfies realtime-js's check with the `ws` package
// (already a project dependency) instead of a real native WebSocket.
globalThis.WebSocket = require('ws');
