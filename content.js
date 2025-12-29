(() => {
  'use strict';

  const CLS = {
    panel: 'cgpt-bulk-panel',
    checkboxWrap: 'cgpt-bulk-checkbox-wrap',
    checkbox: 'cgpt-bulk-checkbox',
  };

  const STR = {
    // UI name shown in the sidebar panel
    title: 'Chat Cleanup',
    help: 'Select chats and delete them in bulk.',
    selected: 'Selected',
    selectAll: 'Select all',
    clear: 'Clear',
    delete: 'Delete',
    statusIdle: '',
    statusNeedScroll: "Scroll the sidebar until 'Your chats' appears.",
    statusNoChats: "No chats found under 'Your chats'.",
    statusWorking: (done, total, ok, failed, pending) => `Deleting ${done}/${total} · ${ok} ok, ${failed} failed${pending ? ` · ${pending} pending` : ''}`,
    statusFallback: (n) => `Retrying ${n} item(s) via UI…`,
  };

  const state = {
    enabled: false,
    selections: new Set(),
    working: false,
    panelEl: null,
    lastStats: null,
    scanScheduled: false,
    navObserved: null,
    mo: null,
  };

  // Performance tuning (fast by default, with safety rails)
  const PERF = {
    maxConcurrency: 6,
    retryAttempts: 2,
    maxBackoffMs: 2000,
    verifyWindowMs: 4500,
    verifyPollMs: 220,
  };

  function normText(s) {
    return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---- Backend API helpers (more reliable than UI automation) ----
  let _cachedToken = null;
  let _tokenTs = 0;

  async function getAccessToken() {
    const now = Date.now();
    if (_cachedToken && (now - _tokenTs) < 2 * 60 * 1000) return _cachedToken;

    // NextAuth session endpoint used by ChatGPT web app.
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (!res.ok) throw new Error(`session fetch failed: ${res.status}`);
    const data = await res.json();

    const token =
      data?.accessToken ||
      data?.access_token ||
      data?.token ||
      data?.user?.accessToken ||
      null;

    if (!token) throw new Error('access token not found in session');
    _cachedToken = token;
    _tokenTs = now;
    return token;
  }

  async function apiRequest(path, { method = 'GET', body = null } = {}) {
    const token = await getAccessToken();
    const headers = { 'Authorization': `Bearer ${token}` };
    let payload = undefined;

    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: 'include',
    });

    // Some endpoints return 204 on success.
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, text: await safeText(res) };
  }

  async function safeText(res) {
    try { return await res.text(); } catch { return ''; }
  }

  // Cache the first successful delete strategy so subsequent deletes avoid trying multiple endpoints.
  let _deleteStrategy = null;

  async function deleteConversationByApi(conversationId) {
    // ChatGPT has used both singular and plural paths historically.
    const baseCandidates = [
      { path: `/backend-api/conversation/${conversationId}`, method: 'PATCH', body: { is_visible: false } },
      { path: `/backend-api/conversations/${conversationId}`, method: 'PATCH', body: { is_visible: false } },
      { path: `/backend-api/conversation/${conversationId}`, method: 'DELETE', body: null },
      { path: `/backend-api/conversations/${conversationId}`, method: 'DELETE', body: null },
    ];

    const same = (a, b) => a && b && a.method === b.method && a.path === b.path;
    const candidates = _deleteStrategy
      ? [_deleteStrategy, ...baseCandidates.filter(c => !same(c, _deleteStrategy))]
      : baseCandidates;

    let lastErr = null;
    for (const c of candidates) {
      try {
        const r = await apiRequest(c.path, { method: c.method, body: c.body });
        if (r.ok) {
          _deleteStrategy = { ...c };
          return { ok: true, status: r.status, method: c.method, path: c.path };
        }
        lastErr = new Error(`API ${c.method} ${c.path} -> ${r.status} ${r.text || ''}`.trim());
        lastErr.detail = { status: r.status, method: c.method, path: c.path, text: r.text || '' };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('API delete failed');
  }

  async function waitUntil(fn, timeoutMs = 8000, stepMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (fn()) return true;
      } catch {}
      await sleep(stepMs);
    }
    return false;
  }

  function getSidebarRoot() {
    return document.querySelector('#stage-slideover-sidebar')
      || document.querySelector('[id="stage-slideover-sidebar"]')
      || document.querySelector('nav[aria-label="Chat history"]')?.closest('#stage-slideover-sidebar')
      || null;
  }

  function getSidebarNav() {
    const root = getSidebarRoot();
    if (!root) return null;
    return root.querySelector('nav[aria-label="Chat history"]')
      || root.querySelector('nav[aria-label*="history"]')
      || root.querySelector('nav')
      || null;
  }

  function ensurePanel() {
    const nav = getSidebarNav();
    if (!nav) return;

    if (state.panelEl && nav.contains(state.panelEl)) return;

    const panel = document.createElement('div');
    panel.id = 'cgpt-bulk-panel';

    panel.innerHTML = `
      <div class="cgpt-row">
        <div class="cgpt-title"><span aria-hidden="true">🗑️</span><span>${STR.title}</span></div>
        <div id="cgpt-bulk-toggle" role="switch" aria-checked="false" data-on="0" tabindex="0"></div>
      </div>
      <div class="cgpt-sub">${STR.help}</div>
      <div class="cgpt-meta">
        <div><span>${STR.selected}:</span> <span id="cgpt-selected-count">0</span></div>
        <div class="cgpt-link" id="cgpt-select-all">${STR.selectAll}</div>
      </div>
      <div class="cgpt-progress" aria-hidden="true"><div id="cgpt-progress-bar"></div></div>
      <div class="cgpt-actions">
        <button class="cgpt-btn" id="cgpt-delete" disabled>${STR.delete}</button>
      </div>
      <div class="cgpt-status" id="cgpt-status"></div>
    `;

    // Insert panel after sticky header if possible, otherwise at top of nav.
    const stickyTop = nav.querySelector(':scope > div.sticky');
    if (stickyTop && stickyTop.parentElement === nav) stickyTop.insertAdjacentElement('afterend', panel);
    else nav.insertAdjacentElement('afterbegin', panel);

    state.panelEl = panel;

    const toggle = panel.querySelector('#cgpt-bulk-toggle');
    const btnDelete = panel.querySelector('#cgpt-delete');
    const linkSelectAll = panel.querySelector('#cgpt-select-all');

    function setToggle(on) {
      state.enabled = !!on;
      toggle.dataset.on = on ? '1' : '0';
      toggle.setAttribute('aria-checked', on ? 'true' : 'false');
      state.panelEl?.classList.toggle('cgpt-collapsed', !state.enabled);
      chrome.storage?.local?.set?.({ cgptBulkEnabled: state.enabled }, () => {});
      if (!state.enabled) {
        clearSelection();
        removeAllCheckboxes();
        setProgress(0, 0);
        setStatus('');
      }
      scheduleScan();
      updatePanel();
    }

    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      setToggle(!state.enabled);
    });
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setToggle(!state.enabled);
      }
    });

    linkSelectAll.addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.enabled) return;
      const info = getYourChatsItems();
      if (info.items.length === 0) return;
      const allSelected = info.items.every(it => state.selections.has(it.id));
      if (allSelected) {
        clearSelection();
      } else {
        info.items.forEach(it => state.selections.add(it.id));
      }
      syncCheckboxesWithState();
      updatePanel();
    });

    btnDelete.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!state.enabled || state.working) return;
      await runBulkDelete();
    });

    // Load persisted toggle state
    try {
      chrome.storage?.local?.get?.(['cgptBulkEnabled'], (res) => {
        if (typeof res?.cgptBulkEnabled === 'boolean') setToggle(res.cgptBulkEnabled);
        else setToggle(false);
      });
    } catch {
      setToggle(false);
    }
  }

  function setStatus(msg) {
    const el = state.panelEl?.querySelector('#cgpt-status');
    if (el) el.textContent = msg || '';
  }

  function setProgress(done, total) {
    const bar = state.panelEl?.querySelector('#cgpt-progress-bar');
    if (!bar) return;
    if (!total || total <= 0) {
      bar.style.width = '0%';
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    bar.style.width = `${pct}%`;
  }

  function updatePanel() {
    state.panelEl?.classList.toggle('cgpt-collapsed', !state.enabled);

    const countEl = state.panelEl?.querySelector('#cgpt-selected-count');
    if (countEl) countEl.textContent = String(state.selections.size);

    const btnDelete = state.panelEl?.querySelector('#cgpt-delete');
    if (btnDelete) btnDelete.disabled = !state.enabled || state.selections.size === 0 || state.working;

    const link = state.panelEl?.querySelector('#cgpt-select-all');
    if (link && state.enabled) {
      const info = getYourChatsItems();
      const allSelected = info.items.length > 0 && info.items.every(it => state.selections.has(it.id));
      link.textContent = allSelected ? STR.clear : STR.selectAll;
    }
  }

  function clearSelection() {
    state.selections.clear();
    updatePanel();
  }

  function findYourChatsHeading(nav) {
    const targets = new Set(['your chats', '你的聊天']);
    const nodes = Array.from(nav.querySelectorAll('div, span, p, h2, h3, h4'))
      .filter(el => el && el.childElementCount === 0);
    for (const el of nodes) {
      const t = normText(el.textContent);
      if (targets.has(t)) return el;
    }
    return null;
  }

  function getConversationLinks(nav) {
    const selector = [
      'a[href^="/c/"]',
      'a[href*="/c/"]',
      'a[href^="https://chatgpt.com/c/"]',
      'a[href^="https://chat.openai.com/c/"]',
    ].join(',');
    return Array.from(nav.querySelectorAll(selector));
  }

  function extractConvId(href) {
    if (!href) return null;
    const m = href.match(/\/c\/([0-9a-fA-F-]{16,})/);
    return m ? m[1] : null;
  }

  function getYourChatsItems() {
    const nav = getSidebarNav();
    if (!nav) return { nav: null, heading: null, items: [], stats: { reason: 'no_sidebar' } };

    const heading = findYourChatsHeading(nav);
    if (!heading) {
      return { nav, heading: null, items: [], stats: { reason: 'no_heading' } };
    }

    const links = getConversationLinks(nav);
    const after = links.filter(a => (heading.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING));

    const items = [];
    const seen = new Set();
    for (const a of after) {
      const id = extractConvId(a.getAttribute('href') || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Prefer <li> as the row container if present.
      const li = a.closest('li');
      const row = li || a.parentElement || a;

      items.push({ id, anchor: a, row });
    }

    return { nav, heading, items, stats: { reason: 'ok', totalLinks: links.length, afterHeading: after.length, items: items.length } };
  }

  function removeAllCheckboxes() {
    document.querySelectorAll(`.${CLS.checkboxWrap}`).forEach(el => el.remove());
  }

  function ensureCheckboxes() {
    if (!state.enabled) return;

    const info = getYourChatsItems();
    state.lastStats = info.stats;

    if (info.stats.reason === 'no_heading') {
      setStatus(STR.statusNeedScroll);
      updatePanel();
      return;
    }

    if (info.items.length === 0) {
      setStatus(STR.statusNoChats);
      updatePanel();
      return;
    }

    setStatus('');

    // Track which IDs are still present.
    const presentIds = new Set(info.items.map(it => it.id));

    // Drop selections that no longer exist in DOM.
    for (const id of Array.from(state.selections)) {
      if (!presentIds.has(id)) state.selections.delete(id);
    }

    // Inject checkboxes for each item.
    for (const it of info.items) {
      injectCheckbox(it);
    }

    // Remove orphan checkbox nodes (e.g., after navigation / list refresh).
    document.querySelectorAll(`.${CLS.checkboxWrap}[data-cgpt-id]`).forEach(wrap => {
      const id = wrap.getAttribute('data-cgpt-id');
      if (!presentIds.has(id)) wrap.remove();
    });

    syncCheckboxesWithState();
      updatePanel();
  }

  function injectCheckbox(item) {
    const { id, anchor } = item;

    // Find a stable insertion point: the first direct child container inside the anchor.
    const container = anchor.querySelector(':scope > div') || anchor;

    // If already injected, skip.
    if (container.querySelector(`.${CLS.checkboxWrap}[data-cgpt-id="${id}"]`)) return;

    const wrap = document.createElement('span');
    wrap.className = CLS.checkboxWrap;
    wrap.setAttribute('data-cgpt-id', id);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = CLS.checkbox;
    cb.checked = state.selections.has(id);

    // Prevent navigation when clicking the checkbox.
    cb.addEventListener('click', (e) => {
      // Stop bubbling into the row link; do NOT preventDefault or the checkbox won't toggle.
      e.stopPropagation();
    });

    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const checked = cb.checked;
      if (checked) state.selections.add(id);
      else state.selections.delete(id);
      updatePanel();
    });

    wrap.appendChild(cb);
    container.insertBefore(wrap, container.firstChild);
  }

  function syncCheckboxesWithState() {
    document.querySelectorAll(`.${CLS.checkboxWrap}[data-cgpt-id] .${CLS.checkbox}`).forEach(cb => {
      const wrap = cb.closest(`.${CLS.checkboxWrap}`);
      const id = wrap?.getAttribute('data-cgpt-id');
      if (!id) return;
      cb.checked = state.selections.has(id);
    });
  }

  function findMenuButtonForAnchor(anchor) {
    // In many builds the "..." button is a sibling inside <li>, sometimes hidden until hover.
    const li = anchor.closest('li');
    const scopes = [li, anchor.parentElement, anchor].filter(Boolean);
    const selectors = [
      'button[aria-haspopup="menu"]',
      'button[data-testid*="menu"]',
      'button[data-testid*="conversation-options"]',
      'button[aria-label*="options"]',
      'button[aria-label*="Options"]',
      'button[aria-label*="More"]',
      'button[aria-label*="more"]',
      'button[aria-label*="更多"]',
      'button[aria-label*="选项"]',
      'button[aria-label*="conversation"]',
    ];
    for (const scope of scopes) {
      for (const sel of selectors) {
        const b = scope.querySelector(sel);
        if (b) return b;
      }
    }
    return null;
  }

  function findClickableByText(texts, root) {
    const tset = texts.map(t => normText(t));
    const candidates = Array.from((root || document).querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"], div[role="menuitem"]'));
    for (const el of candidates) {
      const txt = normText(el.textContent);
      if (!txt) continue;
      if (tset.some(t => txt === t || txt.includes(t))) return el;
    }
    return null;
  }

  function getTopVisibleMenuRoot() {
    // Radix menus often use role="menu" portals.
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    for (let i = menus.length - 1; i >= 0; i--) {
      const m = menus[i];
      const rect = m.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) return m;
    }
    // fallback: popper wrapper
    const pop = Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]'));
    for (let i = pop.length - 1; i >= 0; i--) {
      const m = pop[i];
      const rect = m.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) return m;
    }
    return document;
  }

  async function runBulkDelete() {
    state.working = true;
    updatePanel();

    // Keep a stable, user-visible order (DOM order under 'Your chats' when possible)
    const info0 = getYourChatsItems();
    const ordered = info0.items.map(it => it.id).filter(id => state.selections.has(id));
    const ids = ordered.length ? ordered : Array.from(state.selections);
    const total = ids.length;
    let done = 0;
    let ok = 0;
    let failed = 0;
    setProgress(0, total);
    setStatus(STR.statusWorking(done, total, ok, failed, 0));

    // Snapshot titles for nicer feedback.
    const titleById = new Map();
    try {
      const info0 = getYourChatsItems();
      for (const it of info0.items) titleById.set(it.id, (it.anchor?.textContent || '').trim());
    } catch {}


    // Fast path: API delete with moderate concurrency + adaptive backoff.
    const queue = ids.slice();
    const pendingVerify = new Set();
    const uiFallback = [];
    const attempts = new Map();
    let backoffMs = 0;

    const bumpBackoff = (next) => {
      backoffMs = Math.min(PERF.maxBackoffMs, Math.max(backoffMs, next));
    };
    const decayBackoff = () => {
      backoffMs = Math.max(0, Math.floor(backoffMs * 0.75) - 30);
    };

    const worker = async (wi) => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;

        // 'done' tracks unique conversations that have been finalized (success or permanent failure),
        // not raw attempts (important when retries re-queue an id).
        let finalized = true;

        const title = titleById.get(id) || id;
        if (backoffMs > 0) await sleep(backoffMs);

        try {
          const r = await deleteConversationByApi(id);
          ok++;
          pendingVerify.add(id);
          // Optimistic UI: remove from selection immediately; if it still appears later we'll re-add.
          state.selections.delete(id);
          decayBackoff();
        } catch (e) {
          const status = e?.detail?.status;
          const prev = attempts.get(id) || 0;
          const next = prev + 1;
          attempts.set(id, next);

          // Rate limit / transient errors: backoff + retry a couple times
          if ((status === 429 || (status && status >= 500)) && next < PERF.retryAttempts) {
            bumpBackoff(status === 429 ? 900 : 450);
            // Requeue near the end
            queue.push(id);
            finalized = false;
          } else {
            uiFallback.push({ id, err: e });
            failed++;
          }
        } finally {
          if (finalized) {
            done++;
            setProgress(done, total);
          }
          updatePanel();
          setStatus(STR.statusWorking(done, total, ok, failed, pendingVerify.size));
          // tiny jitter to avoid burst alignment
          await sleep(18 + wi * 6);
        }
      }
    };

    const concurrency = Math.min(PERF.maxConcurrency, total);
    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

    // Verify in batches (non-blocking per-item) for a short window.
    const verifyStart = Date.now();
    while (pendingVerify.size > 0 && (Date.now() - verifyStart) < PERF.verifyWindowMs) {
      const info = getYourChatsItems();
      const visible = new Set(info.items.map(it => it.id));
      for (const id of Array.from(pendingVerify)) {
        if (!visible.has(id)) pendingVerify.delete(id);
      }
      setStatus(STR.statusWorking(done, total, ok, failed, pendingVerify.size));
      await sleep(PERF.verifyPollMs);
    }

    // Anything still visible gets retried via UI (more expensive but accurate)
    for (const id of Array.from(pendingVerify)) {
      uiFallback.push({ id, err: new Error('Still visible after API delete') });
      // Re-add so user can see/select it if fallback fails
      state.selections.add(id);
    }
    pendingVerify.clear();

    if (uiFallback.length > 0) {
      setStatus(STR.statusFallback(uiFallback.length));
      for (let i = 0; i < uiFallback.length; i++) {
        const f = uiFallback[i];
        const info = getYourChatsItems();
        const item = info.items.find(it => it.id === f.id);
        if (!item) {
          // already gone
          state.selections.delete(f.id);
          continue;
        }
        try {
          setStatus(`${STR.statusFallback(uiFallback.length)} (${i + 1}/${uiFallback.length})`);
          await deleteOneByUi(item);
          const removed = await waitUntil(() => {
            const inf = getYourChatsItems();
            return !inf.items.some(it => it.id === f.id);
          }, 9000, 180);
          if (removed) state.selections.delete(f.id);
        } catch (e) {
          // keep selected for retry
          state.selections.add(f.id);
          // eslint-disable-next-line no-console
          console.warn('[cgpt-bulk] UI fallback failed', f.id, e);
        }
        updatePanel();
        await sleep(220);
      }
    }

    // Final message
    setStatus(`Done. (${ok} ok, ${failed} failed${state.selections.size ? `, ${state.selections.size} remaining` : ''})`);
    setProgress(total, total);
    state.working = false;
    scheduleScan();
    updatePanel();
  }

  async function deleteOne(item) {
    const { id } = item;

    // Prefer backend API deletion (stable + fast). Fallback to UI automation if the API changes.
    try {
      await deleteConversationByApi(id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cgpt-bulk] API delete failed, falling back to UI', id, e);
      await deleteOneByUi(item);
    }

    // Verify: the conversation should disappear from the "Your chats" list.
    const removed = await waitUntil(() => {
      const info = getYourChatsItems();
      return !info.items.some(it => it.id === id);
    }, 12000, 200);

    if (!removed) throw new Error('Delete not reflected in sidebar (timeout)');

    // Ensure it doesn't re-appear after a virtualized re-render.
    await sleep(600);
    const info2 = getYourChatsItems();
    if (info2.items.some(it => it.id === id)) throw new Error('Conversation re-appeared after delete; treating as failure');
  }

  async function deleteOneByUi(item) {
    const { anchor, id } = item;

    // Hover to ensure the row menu button is rendered/visible.
    try {
      anchor.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      anchor.closest('li')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    } catch {}

    const menuBtn = findMenuButtonForAnchor(anchor);
    if (!menuBtn) throw new Error('Menu button not found for chat row');

    // Open row menu
    menuBtn.click();
    await sleep(150);

    const menuRoot = getTopVisibleMenuRoot();
    const del = findClickableByText(['Delete', '删除', '移除', 'Remove'], menuRoot);
    if (!del) throw new Error('Delete menu item not found');

    del.click();
    await sleep(250);

    // Confirm dialog (some UIs mount multiple dialogs; pick the top-most visible).
    const dialog = getTopVisibleDialogRoot();
    const confirm = findClickableByText(['Delete', '删除', 'Confirm', '确定', 'Remove'], dialog);
    if (!confirm) throw new Error('Confirm delete button not found');

    confirm.click();

    // Give the app time to process and re-render.
    await sleep(300);
  }

  function getTopVisibleDialogRoot() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], div[aria-modal="true"]'));
    // Pick the last visible one (usually on top).
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const d = dialogs[i];
      const r = d.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return d;
    }
    return document;
  }


  function scheduleScan() {
    if (state.scanScheduled) return;
    state.scanScheduled = true;
    setTimeout(() => {
      state.scanScheduled = false;
      try {
        ensurePanel();
        if (state.enabled) ensureCheckboxes();
        else setStatus('');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[cgpt-bulk] scan error', e);
      }
    }, 120);
  }

  function ensureObservers() {
    if (state.mo) return;
    state.mo = new MutationObserver(() => {
      ensurePanel();
      const nav = getSidebarNav();
      if (nav && nav !== state.navObserved) {
        state.navObserved = nav;
        // Re-scan when sidebar content changes.
        try {
          // Observe subtree for chat list rendering updates.
          const localMo = new MutationObserver(() => scheduleScan());
          localMo.observe(nav, { childList: true, subtree: true });
          // Store on element so it doesn't get GC'd.
          nav.__cgptBulkLocalMo = localMo;
        } catch {}
      }
      scheduleScan();
    });
    state.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Bootstrap
  ensureObservers();
  ensurePanel();
  scheduleScan();

})();
