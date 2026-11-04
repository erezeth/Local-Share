'use strict';

/**
 * Client-side rendering rule: all user-controlled values go through
 * textContent or DOM properties (never innerHTML), and the server sends a
 * restrictive CSP. This keeps chat, names and file names non-executable.
 */
(() => {
  const $ = (id) => document.getElementById(id);

  /* refs */
  const chat = $('chat');
  const messages = $('messages');
  const textInput = $('textInput');
  const sendBtn = $('sendBtn');
  const fileBtn = $('fileBtn');
  const fileInput = $('fileInput');
  const userList = $('userList');
  const userCount = $('userCount');
  const myNameLabel = $('myNameLabel');
  const menuBtn = $('menuBtn');
  const myNameBtn = $('myNameBtn');
  const myNameText = $('myNameText');
  const drawer = $('drawer');
  const drawerClose = $('drawerClose');
  const drawerUserList = $('drawerUserList');
  const drawerCount = $('drawerCount');
  const nameOverlay = $('nameOverlay');
  const nameInput = $('nameInput');
  const nameOk = $('nameOk');
  const guestBtn = $('guestBtn');
  const authOverlay = $('authOverlay');
  const tokenInput = $('tokenInput');
  const tokenOk = $('tokenOk');
  const authError = $('authError');
  const qrModal = $('qrModal');
  const qrImg = $('qrImg');
  const qrUrl = $('qrUrl');
  const connStatus = $('connStatus');
  const connDot = $('connDot');
  const connLabel = $('connLabel');
  const dropzone = $('dropzone');
  const themeBtn = $('themeBtn');
  const themeBtn2 = $('themeBtn2');
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  const recipientBtn = $('recipientBtn');
  const recipientLabel = $('recipientLabel');
  const recipientMenu = $('recipientMenu');
  const recipientList = $('recipientList');
  const recipientAll = $('recipientAll');
  const toasts = $('toasts');

  /* config */
  const MAX_MESSAGES = 200;
  const MAX_OUTBOX = 100;
  const CHUNK = 16 * 1024;
  const HIGH_WATER = 512 * 1024;
  const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let maxFileSize = DEFAULT_MAX_FILE_SIZE;
  let maxChatLength = 2000;
  let maxNameLength = 20;

  /* storage */
  let storageWarningShown = false;
  function logWarning(...args) {
    console.warn('[local-share]', ...args);
  }

  /* theme */
  const THEME_KEY = 'ls_theme';
  const themeButtons = [themeBtn, themeBtn2].filter(Boolean);

  function storedTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (error) {
      logWarning('localStorage is unavailable; theme will not persist', error);
      return null;
    }
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (themeColorMeta) {
      themeColorMeta.content = theme === 'light' ? '#eff5f1' : '#0a1512';
    }
    const nextLabel = theme === 'light' ? 'Aktifkan mode gelap' : 'Aktifkan mode terang';
    for (const button of themeButtons) {
      button.title = nextLabel;
      button.setAttribute('aria-label', nextLabel);
    }
  }

  function chooseTheme(theme, persist = false) {
    applyTheme(theme);
    if (!persist) return;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (error) {
      logWarning('localStorage is unavailable; theme will not persist', error);
    }
  }

  const initialTheme =
    storedTheme() ||
    (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  chooseTheme(initialTheme);
  for (const button of themeButtons) {
    button.addEventListener('click', () => {
      chooseTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
    });
  }

  const store = {
    get(key) {
      try {
        return sessionStorage.getItem(key);
      } catch (error) {
        if (!storageWarningShown) {
          storageWarningShown = true;
          logWarning('sessionStorage is unavailable; session state will not persist', error);
        }
        return null;
      }
    },
    set(key, value) {
      try {
        sessionStorage.setItem(key, value);
      } catch (error) {
        if (!storageWarningShown) {
          storageWarningShown = true;
          logWarning('sessionStorage is unavailable; session state will not persist', error);
        }
      }
    },
    remove(key) {
      try {
        sessionStorage.removeItem(key);
      } catch (error) {
        if (!storageWarningShown) {
          storageWarningShown = true;
          logWarning('sessionStorage is unavailable; session state will not persist', error);
        }
      }
    },
  };

  /* token bootstrap */
  let accessToken = store.get('ls_token') || '';
  try {
    const currentUrl = new URL(location.href);
    const tokenFromUrl = currentUrl.searchParams.get('token');
    if (tokenFromUrl) {
      accessToken = tokenFromUrl;
      store.set('ls_token', accessToken);
      currentUrl.searchParams.delete('token');
      history.replaceState(
        null,
        '',
        currentUrl.pathname + (currentUrl.search || '') + currentUrl.hash
      );
    }
  } catch (error) {
    logWarning('Unable to process the access token from the URL', error);
  }

  /* state */
  let clientId = store.get('ls_cid');
  if (!clientId) {
    clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    store.set('ls_cid', clientId);
  }

  let myName = store.get('ls_name') || '';
  let selfId = '';
  let ws = null;
  let authOk = false;
  let authBlocked = false;
  let everConnected = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let lastMessageAt = 0;
  let guestTimer = null;
  let lastUsers = [];
  let unread = 0;

  const selectedTargets = new Set();
  const incoming = new Map();
  const outgoing = new Map();
  const blobUrls = new Set();
  const outbox = [];
  const pendingAcks = new Map();
  const transferViews = new Map();

  /* util */
  const fmtSize = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '?';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };

  const isPlainObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  function cleanName(value, max = maxNameLength) {
    return String(value ?? '')
      .replace(/[\u0000-\u001f\u007f<>]/g, '')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function cleanDisplayName(value) {
    return cleanName(value, 120) || 'file';
  }

  function safeMime(value) {
    return typeof value === 'string' &&
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
      ? value.toLowerCase().slice(0, 100)
      : 'application/octet-stream';
  }

  function toast(text) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = text;
    toasts.appendChild(node);
    setTimeout(() => node.remove(), 2200);
  }

  /* notifications */
  let notifyAsked = false;
  function maybeAskNotificationPermission() {
    if (notifyAsked) return;
    notifyAsked = true;
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch((error) => {
        logWarning('Notification permission request failed', error);
      });
    }
  }

  function updateTitle() {
    const base = myName ? `Local Share — ${myName}` : 'Local Share';
    document.title = unread ? `(${unread}) ${base}` : base;
  }

  function notify(from, body) {
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    unread += 1;
    updateTitle();
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const notification = new Notification(from || 'Local Share', {
          body,
          tag: 'local-share',
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch (error) {
        logWarning('Unable to show a notification', error);
      }
    }
  }

  function resetUnread() {
    if (!unread) return;
    unread = 0;
    updateTitle();
  }

  /* render */
  function appendMessage(node) {
    messages.appendChild(node);
    while (messages.children.length > MAX_MESSAGES) {
      const old = messages.firstChild;
      old.querySelectorAll?.('img,video,a').forEach((element) => {
        const href = element.src || element.href;
        if (href && href.startsWith('blob:')) {
          URL.revokeObjectURL(href);
          blobUrls.delete(href);
        }
      });
      messages.removeChild(old);
    }
    scrollBottomSoon();
  }

  let scrollQueued = false;
  function scrollBottomSoon() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      chat.scrollTop = chat.scrollHeight;
    });
  }

  function renderRichText(container, text) {
    let lastIndex = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      let url = match[0];
      const trailing = url.match(/[.,;:!?)\]]+$/);
      if (trailing) url = url.slice(0, -trailing[0].length);
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = url;
      container.appendChild(link);
      lastIndex = match.index + url.length;
    }
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Tersalin');
      return;
    } catch (error) {
      logWarning('Clipboard API failed; falling back to execCommand', error);
    }
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    toast(copied ? 'Tersalin' : 'Gagal menyalin');
  }

  function addText(from, text, me, toNames) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg' + (me ? ' me' : '');

    const head = document.createElement('div');
    head.className = 'from';
    head.textContent = toNames ? `${from} → ${toNames}` : from;

    const body = document.createElement('div');
    body.className = 'msg-text';
    renderRichText(body, text);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'msg-action';
    copy.textContent = 'Salin';
    copy.addEventListener('click', () => void copyText(text));
    actions.appendChild(copy);

    wrapper.append(head, body, actions);
    appendMessage(wrapper);
  }

  function addStatus(text, kind = '') {
    const status = document.createElement('div');
    status.className = 'status' + (kind ? ` ${kind}` : '');
    status.setAttribute('role', 'status');
    status.textContent = text;
    appendMessage(status);
    return status;
  }

  function addFile(from, name, mime, blob, me) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg' + (me ? ' me' : '');

    const head = document.createElement('div');
    head.className = 'from';
    head.textContent = from;
    wrapper.appendChild(head);

    let url;
    try {
      url = URL.createObjectURL(blob);
      blobUrls.add(url);
    } catch (error) {
      logWarning('Unable to create a preview URL for the received file', error);
      addStatus(`⚠️ Gagal menampilkan ${cleanDisplayName(name)}`, 'warn');
      return;
    }

    const safeMimeType = safeMime(mime);
    if (safeMimeType.startsWith('image/')) {
      const image = document.createElement('img');
      image.src = url;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.alt = cleanDisplayName(name);
      image.referrerPolicy = 'no-referrer';
      wrapper.appendChild(image);
    } else if (safeMimeType.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      wrapper.appendChild(video);
    }

    const link = document.createElement('a');
    link.href = url;
    link.download = cleanDisplayName(name);
    link.rel = 'noopener';
    link.textContent = `⬇️ ${cleanDisplayName(name)} (${fmtSize(blob.size)})`;
    wrapper.appendChild(link);

    appendMessage(wrapper);
  }

  function createTransferView({ fileId, direction, from, name, size, targetName }) {
    const key = `${direction}:${fileId}`;
    const existing = transferViews.get(key);
    if (existing) return existing;

    const wrapper = document.createElement('div');
    wrapper.className = 'status transfer';

    const label = document.createElement('div');
    label.className = 'transfer-text';

    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = 0;
    bar.setAttribute('aria-label', `Progres transfer ${cleanDisplayName(name)}`);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry-btn';
    retry.textContent = 'Coba lagi';
    retry.hidden = true;

    wrapper.append(label, bar, retry);
    appendMessage(wrapper);

    const prefix =
      direction === 'out'
        ? `Mengirim ${cleanDisplayName(name)}${targetName ? ` ke ${targetName}` : ''}`
        : `Menerima ${cleanDisplayName(name)} dari ${from || 'pengguna'}`;

    const view = {
      key,
      element: wrapper,
      update(received) {
        const safeReceived = Math.max(0, Number(received) || 0);
        const percent = size > 0 ? Math.min(100, Math.round((safeReceived / size) * 100)) : 0;
        wrapper.classList.remove('error');
        retry.hidden = true;
        bar.value = percent;
        label.textContent = `${prefix} • ${percent}% (${fmtSize(safeReceived)}/${fmtSize(size)})`;
      },
      complete() {
        bar.value = 100;
        wrapper.classList.add('ok');
        retry.hidden = true;
        label.textContent = `✅ Selesai: ${prefix.replace(/^(Mengirim|Menerima) /, '')} (${fmtSize(size)})`;
        setTimeout(() => transferViews.delete(key), 30000);
      },
      fail(reason, onRetry) {
        wrapper.classList.add('error');
        wrapper.classList.remove('ok');
        label.textContent = `⚠️ ${prefix} gagal: ${reason || 'dibatalkan'}`;
        if (onRetry) {
          retry.hidden = false;
          retry.onclick = () => {
            retry.hidden = true;
            onRetry();
          };
        }
        setTimeout(() => transferViews.delete(key), 30000);
      },
    };

    transferViews.set(key, view);
    view.update(0);
    return view;
  }

  /* name */
  function setMyName(name) {
    myName = name;
    if (myNameText) myNameText.textContent = name;
    if (myNameLabel) myNameLabel.textContent = name;
    updateTitle();
  }

  function showNamePrompt() {
    nameInput.value = myName || '';
    nameOverlay.hidden = false;
    setTimeout(() => nameInput.focus(), 80);
  }

  function sendHello() {
    if (!authOk) return;
    wsSend({ type: 'hello', clientId, name: myName || null });
  }

  function submitName() {
    const value = cleanName(nameInput.value);
    if (!value) {
      nameInput.focus();
      return;
    }
    setMyName(value);
    store.set('ls_name', value);
    nameOverlay.hidden = true;
    sendHello();
  }

  function resetGuestBtn() {
    clearTimeout(guestTimer);
    guestBtn.disabled = false;
    guestBtn.textContent = 'Continue as guest';
  }

  function requestGuest() {
    if (!authOk) {
      addStatus('⚠️ Tunggu koneksi siap dulu...', 'warn');
      return;
    }
    guestBtn.disabled = true;
    guestBtn.textContent = 'Menghubungkan...';
    clearTimeout(guestTimer);
    wsSend({ type: 'guest', clientId });
    guestTimer = setTimeout(resetGuestBtn, 6000);
  }

  nameOk.addEventListener('click', submitName);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitName();
    }
  });
  myNameBtn.addEventListener('click', showNamePrompt);
  $('editNameBtn').addEventListener('click', showNamePrompt);
  guestBtn.addEventListener('click', requestGuest);

  /* auth */
  function showAuthOverlay(message) {
    authBlocked = true;
    authOk = false;
    authError.textContent = message || '';
    authOverlay.hidden = false;
    setTimeout(() => tokenInput.focus(), 60);
  }

  function clearStoredToken() {
    accessToken = '';
    store.remove('ls_token');
  }

  function submitToken() {
    const value = tokenInput.value.trim();
    if (!value) {
      authError.textContent = 'Token tidak boleh kosong.';
      tokenInput.focus();
      return;
    }

    accessToken = value;
    store.set('ls_token', value);
    authBlocked = false;
    authError.textContent = '';
    authOverlay.hidden = true;
    reconnectAttempt = 0;
    connect();
  }

  tokenOk.addEventListener('click', submitToken);
  tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitToken();
    }
  });

  /* queue + socket */
  function socketSend(payload) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      // Binary chunks must not be JSON-encoded; ArrayBuffer goes straight to ws.send.
      const data =
        payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)
          ? payload
          : typeof payload === 'string'
            ? payload
            : JSON.stringify(payload);
      ws.send(data);
      return true;
    } catch (error) {
      logWarning('WebSocket send failed', error);
      return false;
    }
  }

  function wsSend(message) {
    if (authOk && socketSend(message)) return true;

    if (outbox.length >= MAX_OUTBOX) {
      outbox.shift();
      logWarning('Outbox is full; dropping the oldest queued message');
    }
    outbox.push(message);
    return false;
  }

  function flushOutbox() {
    while (outbox.length && authOk) {
      const message = outbox[0];
      if (!socketSend(message)) break;
      outbox.shift();
    }
  }

  function setOnline(state) {
    const online = state === 'online';
    const connecting = state === 'connecting';
    connDot.classList.toggle('online', online);
    connStatus.classList.toggle('online', online);
    connStatus.classList.toggle('connecting', connecting);
    connLabel.textContent = online ? 'Online' : connecting ? 'Menyambung…' : 'Offline';
    connStatus.title = `Status koneksi: ${connLabel.textContent}`;

    const chipDot = myNameBtn.querySelector('.dot');
    if (chipDot) chipDot.classList.toggle('online', online);
  }

  function scheduleReconnect() {
    if (authBlocked) return;
    reconnectAttempt += 1;
    const delay =
      Math.min(15000, 800 * 2 ** Math.min(reconnectAttempt - 1, 5)) +
      Math.floor(Math.random() * 400);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function startHeartbeat() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - lastMessageAt > 65000) {
        addStatus('⚠️ Koneksi tidak merespons, menyambung ulang...', 'warn');
        try {
          ws.close();
        } catch (error) {
          logWarning('Unable to close a stale WebSocket', error);
        }
        return;
      }
      socketSend({ type: 'ping' });
    }, 20000);
  }

  function connect() {
    if (authBlocked) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    clearTimeout(reconnectTimer);
    setOnline('connecting');

    let socket;
    try {
      socket = new WebSocket(WS_URL);
    } catch (error) {
      logWarning('Unable to create a WebSocket', error);
      setOnline('offline');
      scheduleReconnect();
      return;
    }

    // Browsers default to Blob; the binary chunk parser expects an ArrayBuffer.
    socket.binaryType = 'arraybuffer';
    ws = socket;
    authOk = false;
    lastMessageAt = Date.now();

    const watchdog = setTimeout(() => {
      if (socket === ws && socket.readyState !== WebSocket.OPEN) {
        logWarning('WebSocket connection timed out');
        try {
          socket.close();
        } catch (error) {
          logWarning('Unable to close a timed-out WebSocket', error);
        }
      }
    }, 6000);

    socket.addEventListener('open', () => {
      clearTimeout(watchdog);
      if (socket !== ws) return;
      lastMessageAt = Date.now();
      socket.send(JSON.stringify({ type: 'auth', token: accessToken || '' }));
    });

    socket.addEventListener('message', (event) => {
      lastMessageAt = Date.now();
      if (typeof event.data === 'string') {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          logWarning('Ignoring invalid JSON from the server', error);
          return;
        }
        handleControl(message);
      } else {
        handleBinary(event.data);
      }
    });

    socket.addEventListener('close', (event) => {
      clearTimeout(watchdog);
      clearInterval(pingTimer);
      pingTimer = null;
      if (socket !== ws) return;
      ws = null;
      authOk = false;
      setOnline('offline');

      for (const pending of pendingAcks.values()) {
        pending.resolve({ ok: false, message: 'Koneksi terputus' });
      }
      pendingAcks.clear();

      for (const transfer of incoming.values()) {
        transfer.view.fail('Koneksi terputus');
      }
      incoming.clear();

      for (const record of outgoing.values()) {
        record.view.fail('Koneksi terputus', () => retryTransfer(record, true));
      }

      if (event.code === 4401) {
        clearStoredToken();
        showAuthOverlay(event.reason || 'Token akses tidak valid.');
        return;
      }
      if (event.code === 4403) {
        addStatus('⚠️ Origin koneksi ditolak oleh server.', 'warn');
      } else if (event.code === 4429) {
        addStatus('⚠️ Terlalu banyak percobaan. Coba lagi sebentar lagi.', 'warn');
      }

      if (everConnected) addStatus('🔌 Terputus, menyambung ulang...', 'warn');
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      logWarning('WebSocket connection error');
      setOnline('offline');
    });
  }

  function applyLimits(limits) {
    if (!isPlainObject(limits)) return;
    if (Number.isSafeInteger(limits.maxFileSize) && limits.maxFileSize >= 0) {
      maxFileSize = limits.maxFileSize;
    }
    if (Number.isSafeInteger(limits.maxChatLength) && limits.maxChatLength > 0) {
      maxChatLength = limits.maxChatLength;
    }
    if (Number.isSafeInteger(limits.maxNameLength) && limits.maxNameLength > 0) {
      maxNameLength = limits.maxNameLength;
      nameInput.maxLength = maxNameLength;
    }
  }

  function handleControl(message) {
    if (!isPlainObject(message) || typeof message.type !== 'string') return;
    if (!authOk && !['auth-ok', 'auth-error', 'error'].includes(message.type)) {
      return;
    }

    switch (message.type) {
      case 'auth-ok':
        authOk = true;
        authBlocked = false;
        applyLimits(message.limits);
        authOverlay.hidden = true;
        authError.textContent = '';
        tokenInput.value = '';
        setOnline('online');
        reconnectAttempt = 0;
        everConnected = true;
        clearInterval(pingTimer);
        startHeartbeat();
        sendHello();
        flushOutbox();
        break;

      case 'auth-error':
        authOk = false;
        clearStoredToken();
        showAuthOverlay(message.message || 'Token akses tidak valid.');
        break;

      case 'welcome':
        if (typeof message.id === 'string') selfId = message.id;
        if (typeof message.name === 'string' && message.name) {
          setMyName(cleanName(message.name));
          store.set('ls_name', myName);
        }
        nameOverlay.hidden = true;
        authOverlay.hidden = true;
        resetGuestBtn();
        if (lastUsers.length) renderUsers(lastUsers);
        break;

      case 'need-name':
        resetGuestBtn();
        if (authOk) showNamePrompt();
        break;

      case 'users':
        if (Array.isArray(message.users)) renderUsers(message.users);
        break;

      case 'chat':
        if (typeof message.text === 'string' && message.text) {
          const from = typeof message.from === 'string' ? cleanName(message.from) : '?';
          addText(from, message.text.slice(0, maxChatLength), message.fromId === selfId, null);
          if (message.fromId !== selfId) notify(from, message.text.slice(0, 120));
        }
        break;

      case 'pong':
        break;

      case 'error':
        handleServerError(message);
        break;

      case 'file-start-ack':
        if (typeof message.fileId === 'string') {
          resolveAck(message.fileId, {
            ok: true,
            recipients: Number.isSafeInteger(message.recipients) ? message.recipients : 0,
            offset: Number.isSafeInteger(message.offset) ? message.offset : 0,
          });
        }
        break;

      case 'file-end-ack':
        if (typeof message.fileId === 'string') {
          resolveAck(message.fileId, { ok: true });
        }
        break;

      case 'file-start':
        handleFileStart(message);
        break;

      case 'file-end':
        handleFileEnd(message);
        break;

      case 'file-cancel':
        handleFileCancel(message);
        break;

      default:
        break;
    }
  }

  function handleServerError(message) {
    const label = message.message || message.code || 'Terjadi kesalahan';
    addStatus(`⚠️ ${label}`, 'warn');
    if (typeof message.fileId === 'string') {
      const record = outgoing.get(message.fileId);
      if (record) {
        record.failed = { code: message.code, message: label };
        if (Number.isSafeInteger(message.receivedBytes)) record.offset = message.receivedBytes;
      }
      resolveAck(message.fileId, { ok: false, code: message.code, message: label });
    }
  }

  /* users + recipients */
  function createUserItem(user, isMe) {
    const item = document.createElement('li');
    if (isMe) item.className = 'me';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = [...String(user.name).trim()][0] || '?';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    avatar.append(dot);
    const label = document.createElement('span');
    label.className = 'user-name';
    label.textContent = user.name + (isMe ? ' (Anda)' : '');
    item.append(avatar, label);
    return item;
  }

  function renderRecipientMenu() {
    const fragment = document.createDocumentFragment();
    for (const user of lastUsers) {
      if (user.id === selfId) continue;
      const label = document.createElement('label');
      label.className = 'check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = user.id;
      checkbox.checked = selectedTargets.has(user.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedTargets.add(user.id);
        else selectedTargets.delete(user.id);
        updateRecipientLabel();
      });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = user.name;
      label.append(checkbox, name);
      fragment.appendChild(label);
    }
    recipientList.replaceChildren(fragment);
  }

  function updateRecipientLabel() {
    const count = selectedTargets.size;
    recipientAll.checked = count === 0;
    if (count === 0) {
      recipientLabel.textContent = 'Semua';
    } else if (count === 1) {
      recipientLabel.textContent = targetLabel([...selectedTargets][0]);
    } else {
      recipientLabel.textContent = `${count} penerima`;
    }
  }

  function renderUsers(users) {
    lastUsers = users
      .filter(
        (user) =>
          isPlainObject(user) &&
          typeof user.id === 'string' &&
          typeof user.name === 'string' &&
          user.name
      )
      .map((user) => ({ id: user.id, name: cleanName(user.name) }))
      .filter((user) => user.name);

    userCount.textContent = lastUsers.length;
    drawerCount.textContent = lastUsers.length;

    const sidebarFragment = document.createDocumentFragment();
    const drawerFragment = document.createDocumentFragment();
    for (const user of lastUsers) {
      const isMe = user.id === selfId || (!selfId && user.name === myName);
      sidebarFragment.appendChild(createUserItem(user, isMe));
      drawerFragment.appendChild(createUserItem(user, isMe));
    }
    userList.replaceChildren(sidebarFragment);
    drawerUserList.replaceChildren(drawerFragment);

    const onlineIds = new Set(lastUsers.map((user) => user.id));
    for (const target of selectedTargets) {
      if (!onlineIds.has(target)) selectedTargets.delete(target);
    }
    renderRecipientMenu();
    updateRecipientLabel();
  }

  function targetLabel(targetId) {
    const target = lastUsers.find((user) => user.id === targetId);
    return target ? target.name : 'penerima';
  }

  function targetNames(targets) {
    return targets.map((id) => (id === selfId ? 'Anda' : targetLabel(id))).join(', ');
  }

  recipientBtn.addEventListener('click', () => {
    const open = recipientMenu.hidden;
    recipientMenu.hidden = !open;
    recipientBtn.setAttribute('aria-expanded', String(open));
    if (open) renderRecipientMenu();
  });

  recipientAll.addEventListener('change', () => {
    if (recipientAll.checked) selectedTargets.clear();
    renderRecipientMenu();
    updateRecipientLabel();
  });

  document.addEventListener('click', (event) => {
    if (recipientMenu.hidden) return;
    if (recipientBtn.contains(event.target) || recipientMenu.contains(event.target)) return;
    recipientMenu.hidden = true;
    recipientBtn.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || recipientMenu.hidden) return;
    recipientMenu.hidden = true;
    recipientBtn.setAttribute('aria-expanded', 'false');
  });

  /* text */
  function resizeInput() {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(150, textInput.scrollHeight) + 'px';
  }

  function sendText() {
    const text = textInput.value.trim().slice(0, maxChatLength);
    if (!text) return;

    const targets = [...selectedTargets];
    const queued = wsSend({
      type: 'chat',
      text,
      ...(targets.length ? { targets } : {}),
    });

    addText(myName || 'saya', text, true, targets.length ? targetNames(targets) : null);
    if (!queued) addStatus('📨 Menunggu koneksi...', 'warn');
    textInput.value = '';
    resizeInput();
    textInput.focus();
  }

  sendBtn.addEventListener('click', sendText);
  textInput.addEventListener('input', resizeInput);
  textInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendText();
  });
  document.addEventListener('click', maybeAskNotificationPermission, { once: true });

  /* files */
  function makeFileId() {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function waitForAck(fileId, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(fileId);
        resolve({ ok: false, message: 'Server tidak merespons' });
      }, timeoutMs);

      pendingAcks.set(fileId, {
        resolve(result) {
          clearTimeout(timer);
          pendingAcks.delete(fileId);
          resolve(result);
        },
      });
    });
  }

  function resolveAck(fileId, result) {
    const pending = pendingAcks.get(fileId);
    if (pending) pending.resolve(result);
  }

  function readBlob(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsArrayBuffer(blob);
    });
  }

  function retryTransfer(record, freshStart) {
    const resume = !freshStart && record.offset > 0 && ws && ws.readyState === 1;
    const fileId = resume ? record.fileId : makeFileId();
    const offset = resume ? record.offset : 0;
    outgoing.delete(record.fileId);
    void sendFile(record.file, {
      targets: record.targets,
      fileId,
      offset,
      view: record.view,
    });
  }

  async function sendFile(
    file,
    { targets = [...selectedTargets], fileId, offset = 0, view = null } = {}
  ) {
    if (!authOk || !ws || ws.readyState !== 1) {
      addStatus('⚠️ Tunggu koneksi siap dulu...', 'warn');
      return;
    }

    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      addStatus('⚠️ Ukuran file tidak valid.', 'warn');
      return;
    }
    if (size > maxFileSize) {
      addStatus(
        `⚠️ ${cleanDisplayName(file.name)} melebihi batas ${fmtSize(maxFileSize)}.`,
        'warn'
      );
      return;
    }

    const id = fileId || makeFileId();
    const record = {
      file,
      fileId: id,
      targets,
      offset,
      failed: null,
      view:
        view ||
        createTransferView({
          fileId: id,
          direction: 'out',
          from: myName,
          name: file.name,
          size,
          targetName: targets.length ? targetNames(targets) : null,
        }),
    };
    outgoing.set(id, record);

    const startMessage = {
      type: 'file-start',
      fileId: id,
      name: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      size,
      offset,
    };
    if (targets.length) startMessage.targets = targets;

    if (!socketSend(startMessage)) {
      record.view.fail('Koneksi terputus', () => retryTransfer(record, true));
      return;
    }

    const ack = await waitForAck(id);
    if (!ack.ok) {
      if (offset > 0 && ack.code === 'RESUME_UNKNOWN') {
        retryTransfer(record, true);
        return;
      }
      record.view.fail(ack.message || 'Ditolak server', () => retryTransfer(record, false));
      return;
    }
    if (!ack.recipients) {
      outgoing.delete(id);
      record.view.fail('Tidak ada penerima online');
      return;
    }

    let sent = Number.isSafeInteger(ack.offset) ? ack.offset : offset;
    record.offset = sent;
    record.failed = null;

    const idBytes = new TextEncoder().encode(id);
    const headerLength = 1 + idBytes.length;
    let index = 0;

    try {
      while (sent < size) {
        if (!ws || ws.readyState !== 1) throw new Error('Koneksi terputus');
        if (record.failed) throw new Error(record.failed.message);

        const buffer = await readBlob(file.slice(sent, sent + CHUNK));
        if (!buffer || buffer.byteLength === 0) throw new Error('Gagal membaca file');

        const packet = new Uint8Array(headerLength + buffer.byteLength);
        packet[0] = idBytes.length;
        packet.set(idBytes, 1);
        packet.set(new Uint8Array(buffer), headerLength);

        while (ws.bufferedAmount > HIGH_WATER) {
          if (!ws || ws.readyState !== 1) throw new Error('Koneksi terputus');
          await sleep(20);
        }

        if (!socketSend(packet.buffer)) throw new Error('Gagal mengirim chunk');
        sent += buffer.byteLength;
        record.offset = sent;
        record.view.update(sent);
        index += 1;
        if (index % 8 === 0) await sleep(0);
      }

      if (record.failed) throw new Error(record.failed.message);
      if (!socketSend({ type: 'file-end', fileId: id })) {
        throw new Error('Koneksi terputus saat menyelesaikan file');
      }
      const endAck = await waitForAck(id);
      if (!endAck.ok) throw new Error(endAck.message || 'Server menolak file');
      outgoing.delete(id);
      record.view.complete();
      addFile(myName || 'saya', file.name, file.type || 'application/octet-stream', file, true);
    } catch (error) {
      logWarning('File transfer failed', error);
      record.view.fail(error.message || 'Transfer gagal', () => retryTransfer(record, false));
    }
  }

  function handleFileStart(message) {
    if (
      typeof message.fileId !== 'string' ||
      !/^[A-Za-z0-9_-]{4,32}$/.test(message.fileId) ||
      !Number.isSafeInteger(message.size) ||
      message.size < 0 ||
      message.size > maxFileSize ||
      incoming.has(message.fileId)
    ) {
      logWarning('Ignoring invalid file-start message', message);
      return;
    }

    const name = cleanDisplayName(message.name);
    const mime = safeMime(message.mime);
    const from = typeof message.from === 'string' ? cleanName(message.from) : '?';
    const view = createTransferView({
      fileId: message.fileId,
      direction: 'in',
      from,
      name,
      size: message.size,
      targetName: null,
    });

    incoming.set(message.fileId, {
      name,
      mime,
      size: message.size,
      from,
      chunks: [],
      received: 0,
      view,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    notify(from, `Mengirim file ${name}`);
  }

  function handleBinary(buffer) {
    const view = new Uint8Array(buffer);
    if (view.length < 2) return;

    const idLength = view[0];
    if (idLength < 4 || idLength > 32 || view.length < 1 + idLength) return;

    const fileId = new TextDecoder().decode(view.subarray(1, 1 + idLength));
    const transfer = incoming.get(fileId);
    if (!transfer) return;

    const chunk = view.subarray(1 + idLength);
    if (transfer.received + chunk.byteLength > transfer.size) {
      transfer.view.fail('Data melebihi ukuran yang dideklarasikan');
      incoming.delete(fileId);
      return;
    }

    transfer.chunks.push(chunk.slice());
    transfer.received += chunk.byteLength;
    transfer.lastActivityAt = Date.now();
    transfer.view.update(transfer.received);
  }

  function handleFileEnd(message) {
    if (typeof message.fileId !== 'string') return;
    const transfer = incoming.get(message.fileId);
    if (!transfer) return;
    incoming.delete(message.fileId);

    if (transfer.received !== transfer.size) {
      transfer.view.fail(
        `Ukuran tidak cocok (${fmtSize(transfer.received)} dari ${fmtSize(transfer.size)})`
      );
      return;
    }

    try {
      const blob = new Blob(transfer.chunks, { type: transfer.mime });
      transfer.view.complete();
      addFile(transfer.from, transfer.name, transfer.mime, blob, false);
    } catch (error) {
      logWarning('Unable to assemble the received file', error);
      transfer.view.fail('Gagal menyusun file');
    }
  }

  function handleFileCancel(message) {
    if (typeof message.fileId !== 'string') return;
    const transfer = incoming.get(message.fileId);
    if (!transfer) return;
    incoming.delete(message.fileId);
    transfer.view.fail(
      message.reason === 'timeout' ? 'Waktu transfer habis' : 'Dibatalkan pengirim'
    );
  }

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = fileInput.files;
    if (!files || !files.length) return;
    const targets = [...selectedTargets];
    for (let index = 0; index < files.length; index += 1) {
      await sendFile(files[index], { targets });
    }
    fileInput.value = '';
  });

  /* drag & drop */
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dropzone.hidden = false;
  });

  document.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget || !document.contains(event.relatedTarget)) {
      dropzone.hidden = true;
    }
  });

  document.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dropzone.hidden = true;
    const targets = [...selectedTargets];
    for (const file of Array.from(event.dataTransfer.files)) {
      await sendFile(file, { targets });
    }
  });

  /* qr */
  async function showQr() {
    try {
      const headers = accessToken ? { 'X-Access-Token': accessToken } : {};
      const response = await fetch('/qr', { headers, cache: 'no-store' });
      if (response.status === 401) {
        showAuthOverlay('Token akses tidak valid atau sudah berubah.');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (typeof data.qr !== 'string' || !data.qr.startsWith('data:image/')) {
        throw new Error('Invalid QR response');
      }
      qrImg.src = data.qr;
      qrUrl.textContent = typeof data.url === 'string' ? data.url : '';
      qrModal.hidden = false;
    } catch (error) {
      logWarning('Unable to load the QR code', error);
      addStatus('⚠️ Gagal ambil QR', 'warn');
    }
  }

  $('qrBtn').addEventListener('click', showQr);
  $('qrBtn2').addEventListener('click', showQr);
  $('qrClose').addEventListener('click', () => {
    qrModal.hidden = true;
  });
  qrModal.addEventListener('click', (event) => {
    if (event.target === qrModal) qrModal.hidden = true;
  });

  /* drawer */
  menuBtn.addEventListener('click', () => drawer.classList.add('open'));
  drawerClose.addEventListener('click', () => drawer.classList.remove('open'));
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) drawer.classList.remove('open');
  });

  /* housekeeping */
  setInterval(() => {
    const now = Date.now();
    for (const [fileId, transfer] of incoming) {
      if (now - transfer.lastActivityAt > 5 * 60 * 1000) {
        transfer.view.fail('Waktu transfer habis');
        incoming.delete(fileId);
      }
    }
  }, 30000);

  /* boot */
  if (myName) setMyName(myName);
  setOnline('offline');
  updateRecipientLabel();

  async function boot() {
    if (!accessToken) {
      try {
        const response = await fetch('/healthz', { cache: 'no-store' });
        if (response.ok) {
          const info = await response.json();
          if (info && info.authRequired) {
            showAuthOverlay('Masukkan token akses dari terminal server.');
            return;
          }
        }
      } catch (error) {
        logWarning('Unable to check server configuration', error);
      }
    }
    connect();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    resetUnread();
    if (authBlocked) return;
    if (!ws || ws.readyState > WebSocket.OPEN) {
      reconnectAttempt = 0;
      connect();
    }
  });
  window.addEventListener('focus', resetUnread);

  void boot();
})();
