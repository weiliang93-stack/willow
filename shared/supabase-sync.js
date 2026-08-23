// Lightweight cross-device sync for the willow apps, backed by Supabase.
//
// Each app calls SupaSync.mountAuthGate(el, onReady) once at startup:
// it shows a sign-in/sign-up form in `el` until the user is authenticated,
// then calls onReady(user) so the app can boot. SupaSync.pullState/pushState
// read and write that user's state as a single JSON blob, keyed by an
// app name ("training", "expenses"). SupaSync.invokeFunction calls a
// user-authenticated Edge Function (the session's access token is
// attached automatically) — for functions like template-edit that need
// to know who's calling, unlike the sheet-sync functions' cron-only
// x-webhook-secret auth.
//
// Sync is whole-state, last-write-wins by timestamp — not a field-level
// merge. pullState returns the state's server-side updated_at alongside
// it so callers can compare against their own last-local-edit timestamp
// before deciding whether to adopt the remote copy or keep (and re-push)
// their own newer local changes. This is what stops a page reload from
// silently discarding an edit made while offline that hadn't synced yet.
// Failed pushes (e.g. made while offline) are retried once the browser
// reports it's back online.
//
// If shared/supabase-config.js hasn't been filled in yet, or the Supabase
// library itself failed to load (e.g. opened offline, before the CDN
// script has ever been cached), everything here becomes a no-op and
// mountAuthGate calls onReady(null) immediately, so both apps keep working
// exactly as they did before (local-only).
(function () {
  function isConfigured() {
    return (
      typeof SUPABASE_URL === "string" &&
      typeof SUPABASE_ANON_KEY === "string" &&
      !SUPABASE_URL.includes("YOUR-PROJECT") &&
      !SUPABASE_ANON_KEY.includes("YOUR-ANON")
    );
  }

  function createClient() {
    if (!isConfigured()) return null;
    if (typeof window.supabase === "undefined") {
      console.warn("SupaSync: Supabase library failed to load (offline?) — falling back to local-only mode.");
      return null;
    }
    try {
      return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (err) {
      console.error("SupaSync: failed to create Supabase client — falling back to local-only mode.", err);
      return null;
    }
  }

  const client = createClient();
  const configured = client !== null;

  // Returns { state, updatedAt } (the server's last-write timestamp) so
  // the caller can decide whether the remote copy is actually newer than
  // whatever it has locally — or null if there's nothing synced yet.
  async function pullState(app) {
    if (!client) return null;
    const { data, error } = await client.from("app_state").select("state, updated_at").eq("app", app).maybeSingle();
    if (error) {
      console.error("SupaSync pull failed:", error.message);
      return null;
    }
    return data ? { state: data.state, updatedAt: data.updated_at } : null;
  }

  async function doPush(app, state) {
    if (!client) return;
    const { data } = await client.auth.getUser();
    if (!data.user) return;
    const { error } = await client
      .from("app_state")
      .upsert({ user_id: data.user.id, app, state, updated_at: new Date().toISOString() });
    if (error) console.error("SupaSync push failed:", error.message);
  }

  // Remembers the latest state each app has asked to sync, so a failed
  // push (e.g. made while offline) can be retried once connectivity
  // returns, without the app having to track that itself.
  const lastPushState = {};
  let pushTimer = null;

  function pushState(app, state) {
    if (!client) return;
    lastPushState[app] = state;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doPush(app, state), 800);
  }

  if (client) {
    window.addEventListener("online", () => {
      Object.keys(lastPushState).forEach((app) => doPush(app, lastPushState[app]));
    });
  }

  function signOut() {
    return client ? client.auth.signOut() : Promise.resolve();
  }

  // Calls a Supabase Edge Function as the signed-in user (the client
  // library attaches the current session's access token automatically),
  // for functions that expect user auth rather than the cron-only
  // x-webhook-secret pattern the sheet-sync functions use. Returns
  // { ok: true, data } or { ok: false, error }.
  async function invokeFunction(name, body) {
    if (!client) return { ok: false, error: "not signed in" };
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      const message = (error.context && (await error.context.json().catch(() => null))?.error) || error.message;
      return { ok: false, error: message };
    }
    return { ok: true, data };
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Renders a sign-in/sign-up form into `mountEl` until a session exists,
  // then swaps it for a small "signed in as… / sign out" strip and calls
  // onReady(user) exactly once.
  function mountAuthGate(mountEl, onReady) {
    if (!client) {
      mountEl.style.display = "none";
      onReady(null);
      return;
    }

    let readyFired = false;

    function renderSignedIn(user) {
      mountEl.className = "auth-gate auth-gate-signedin";
      mountEl.innerHTML = `
        <span class="auth-signedin-label">Synced as ${escapeHtml(user.email)}</span>
        <button type="button" id="auth-signout-btn" class="auth-signout-btn">Sign out</button>
      `;
      mountEl.querySelector("#auth-signout-btn").addEventListener("click", signOut);
      if (!readyFired) {
        readyFired = true;
        onReady(user);
      }
    }

    function renderForm() {
      mountEl.className = "auth-gate";
      mountEl.innerHTML = `
        <div class="auth-box">
          <h2>Sign in to sync</h2>
          <p class="auth-hint">Your data syncs across devices once signed in.</p>
          <input id="auth-email" type="email" placeholder="Email" autocomplete="username">
          <input id="auth-password" type="password" placeholder="Password (min 6 characters)" autocomplete="current-password">
          <div class="auth-actions">
            <button type="button" id="auth-signin-btn">Sign in</button>
            <button type="button" id="auth-signup-btn" class="secondary">Sign up</button>
          </div>
          <div id="auth-error" class="auth-error"></div>
        </div>
      `;
      const emailEl = mountEl.querySelector("#auth-email");
      const pwEl = mountEl.querySelector("#auth-password");
      const errEl = mountEl.querySelector("#auth-error");

      async function attempt(action) {
        errEl.textContent = "";
        const email = emailEl.value.trim();
        const password = pwEl.value;
        if (!email || !password) {
          errEl.textContent = "Enter an email and password.";
          return;
        }
        const { error, data } = await action(email, password);
        if (error) {
          errEl.textContent = error.message;
        } else if (data && !data.session) {
          errEl.textContent = "Check your email to confirm signup, then sign in.";
        }
      }

      mountEl
        .querySelector("#auth-signin-btn")
        .addEventListener("click", () => attempt((email, password) => client.auth.signInWithPassword({ email, password })));
      mountEl
        .querySelector("#auth-signup-btn")
        .addEventListener("click", () => attempt((email, password) => client.auth.signUp({ email, password })));
      [emailEl, pwEl].forEach((input) => {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") mountEl.querySelector("#auth-signin-btn").click();
        });
      });
    }

    client.auth.onAuthStateChange((_event, session) => {
      if (session) renderSignedIn(session.user);
      else renderForm();
    });

    client.auth.getSession().then(({ data }) => {
      if (data.session) renderSignedIn(data.session.user);
      else renderForm();
    });
  }

  window.SupaSync = { configured, pullState, pushState, mountAuthGate, signOut, invokeFunction };
})();
