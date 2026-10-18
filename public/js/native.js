// Only runs inside the TEgo iPhone app (Capacitor, see capacitor.config.json
// and docs/IOS_APP.md). Loaded by notifications.js when it sees the app.
//
// Phone notifications in the app use Apple push, not web push: the app asks
// for permission, gets an Apple device token and saves it with
// register_ios_push_device (migration 20261018000000). push.js then sends to
// it through apns.js. Tapping a notification opens the page it links to.
//
// Exposes window.TEgoNative = { pushStatus, enablePush, disablePush } for the
// notifications panel.

(function () {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || window.TEgoNative) return;
  const Push = cap.Plugins && cap.Plugins.PushNotifications;
  const TOKEN_KEY = 'tego-push-token';

  const store = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
    set(v) { try { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode */ } },
  };

  // register() answers through the 'registration' event, so wrap it in a promise.
  let waiting = null;
  function registerForToken() {
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      Push.register().catch(reject);
      setTimeout(() => { if (waiting) { waiting = null; reject(new Error('Apple did not answer. Check the phone has internet and try again.')); } }, 20000);
    });
  }

  async function saveToken(token) {
    const { error } = await supabaseClient.rpc('register_ios_push_device', { p_token: token, p_user_agent: navigator.userAgent.slice(0, 200) });
    if (error) throw error;
    store.set(token);
  }

  async function permission() {
    const p = await Push.checkPermissions();
    return p.receive;
  }

  async function pushStatus() {
    if (!Push) return 'unsupported';
    const p = await permission();
    if (p === 'denied') return 'denied';
    if (p === 'granted' && store.get()) return 'on';
    return 'off';
  }

  async function enablePush() {
    let p = await permission();
    if (p === 'prompt' || p === 'prompt-with-rationale') p = (await Push.requestPermissions()).receive;
    if (p !== 'granted') throw new Error('Notifications are turned off for TEgo. Turn them on in the iPhone Settings app, under TEgo, then Notifications.');
    await saveToken(await registerForToken());
  }

  async function disablePush() {
    const token = store.get();
    if (token) await supabaseClient.from('push_subscriptions').delete().eq('endpoint', token);
    store.set(null);
    await Push.unregister().catch(() => {});
  }

  if (Push) {
    Push.addListener('registration', (t) => {
      const w = waiting; waiting = null;
      if (w) w.resolve(t.value);
      else saveToken(t.value).catch(err => console.error('Saving the push token failed:', err));
    });
    Push.addListener('registrationError', (e) => {
      const w = waiting; waiting = null;
      if (w) w.reject(new Error((e && e.error) || 'Could not turn on notifications'));
    });
    // Tapped a notification: open the page it points at.
    Push.addListener('pushNotificationActionPerformed', (a) => {
      const url = a && a.notification && a.notification.data && a.notification.data.url;
      if (url) window.location.href = url;
    });

    // Apple can change a device's token, and a shared iPhone may now be signed
    // in as someone else, so re-save it once per app session and person.
    (async () => {
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const who = session && session.user.id;
        if (who && sessionStorage.getItem('tego-push-synced') !== who && store.get() && (await permission()) === 'granted') {
          await Push.register();
          sessionStorage.setItem('tego-push-synced', who);
        }
      } catch (e) { /* not critical */ }
    })();
  }

  window.TEgoNative = { pushStatus, enablePush, disablePush };
})();
