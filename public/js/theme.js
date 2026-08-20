// Theme handling for Navy Pro / Dark Trade.
//
// Every page also inlines a copy of applyThemeInstant()'s two lines
// directly in <head>, before this file has even loaded, so there's no
// flash of the wrong theme while the browser fetches this script. This
// version re-runs the same logic (harmless) and provides setTheme() /
// syncThemeFromProfile() for the rest of the app to use.
//
// syncThemeFromProfile() runs after login and pulls the saved value from
// Supabase, so the choice follows the user to a different device. If no
// profile row exists yet, one is created with whatever theme is currently
// showing.

const TE_THEME_KEY = 'te-theme';
const TE_THEME_DEFAULT = 'dark';

function applyThemeInstant() {
  const saved = localStorage.getItem(TE_THEME_KEY) || TE_THEME_DEFAULT;
  document.documentElement.setAttribute('data-theme', saved);
  return saved;
}

function setTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  localStorage.setItem(TE_THEME_KEY, name);
  document.dispatchEvent(new CustomEvent('te-theme-changed', { detail: name }));
  // Best-effort save to the user's profile. Table may not exist yet if
  // migration_006 hasn't been run - fail silently either way, local
  // storage still keeps this device working.
  if (typeof supabaseClient !== 'undefined') {
    supabaseClient.auth.getSession().then(({ data: { session } }) => {
      if (!session) return;
      supabaseClient
        .from('profiles')
        .upsert({ id: session.user.id, theme: name })
        .then(() => {});
    });
  }
}

async function syncThemeFromProfile() {
  if (typeof supabaseClient === 'undefined') return;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  const { data, error } = await supabaseClient
    .from('profiles')
    .select('theme')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error || !data) {
    // No profile row yet - create one from whatever's showing locally.
    const current = document.documentElement.getAttribute('data-theme') || TE_THEME_DEFAULT;
    supabaseClient.from('profiles').upsert({ id: session.user.id, theme: current }).then(() => {});
    return;
  }

  if (data.theme && data.theme !== localStorage.getItem(TE_THEME_KEY)) {
    document.documentElement.setAttribute('data-theme', data.theme);
    localStorage.setItem(TE_THEME_KEY, data.theme);
  }
}

applyThemeInstant();
