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
  const targetSelect = $('targetSelect');
  const dropzone = $('dropzone');
  const themeBtn = $('themeBtn');
  const themeBtn2 = $('themeBtn2');
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');

  /* config */
  const MAX_MESSAGES = 200;
  const MAX_OUTBOX = 100;
  const CHUNK = 16 * 1024;
  const HIGH_WATER = 512 * 1024;
  const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
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
      themeColorMeta.content = theme === 'light' ? '#f3f6fc' : '#080e1a';
    }

    const nextLabel = theme === 'light' ? 'Aktifkan mode gelap' : 'Aktifkan mode terang';
    for (const button of themeButtons) {
      button.textContent = theme === 'light' ? '🌙' : '☀️';
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

  const incoming = new Map();
  const blobUrls = new Set();
  const outbox = [];
  const pendingAcks = new Map();
  const failedTransfers = new Map();
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

  function addText(from, text, me, toName) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg' + (me ? ' me' : '');

    const head = document.createElement('div');
    head.className = 'from';
    head.textContent = toName ? `${from} → ${toName}` : from;

    const body = document.createElement('div');
    body.textContent = text;

    wrapper.append(head, body);
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

    wrapper.append(label, bar);
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
        bar.value = percent;
        label.textContent = `${prefix} • ${percent}% (${fmtSize(safeReceived)}/${fmtSize(size)})`;
      },
      complete() {
        bar.value = 100;
        wrapper.classList.add('ok');
        label.textContent = `✅ Selesai: ${prefix.replace(/^(Mengirim|Menerima) /, '')} (${fmtSize(size)})`;
        setTimeout(() => transferViews.delete(key), 30000);
      },
      fail(reason) {
        wrapper.classList.add('error');
        label.textContent = `⚠️ ${prefix} gagal: ${reason || 'dibatalkan'}`;
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
    document.title = name ? `Local Share — ${name}` : 'Local Share';
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
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
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
    if (!authOk && !['auth-ok', 'auth-error', 'auth-required', 'error'].includes(message.type)) {
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

      case 'auth-required':
        showAuthOverlay('Server membutuhkan token akses.');
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
          addText(
            typeof message.from === 'string' ? cleanName(message.from) : '?',
            message.text.slice(0, maxChatLength),
            message.fromId === selfId,
            null
          );
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
      failedTransfers.set(message.fileId, label);
      resolveAck(message.fileId, { ok: false, message: label });
    }
  }

  /* users + target */
  function createUserItem(user, isMe) {
    const item = document.createElement('li');
    if (isMe) item.className = 'me';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = user.name + (isMe ? ' (You)' : '');
    item.append(dot, label);
    return item;
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

    const previousTarget = targetSelect.value;
    const options = document.createDocumentFragment();
    options.appendChild(new Option('Semua', ''));
    for (const user of lastUsers) {
      if (user.id === selfId) continue;
      options.appendChild(new Option(user.name, user.id));
    }
    targetSelect.replaceChildren(options);

    if (previousTarget && lastUsers.some((user) => user.id === previousTarget)) {
      targetSelect.value = previousTarget;
    } else {
      targetSelect.value = '';
    }
  }

  function targetLabel(targetId) {
    const target = lastUsers.find((user) => user.id === targetId);
    return target ? target.name : 'penerima';
  }

  /* text */
  function sendText() {
    const text = textInput.value.trim().slice(0, maxChatLength);
    if (!text) return;

    const targetId = targetSelect.value || null;
    const queued = wsSend({
      type: 'chat',
      text,
      ...(targetId ? { target: targetId } : {}),
    });

    addText(myName || 'saya', text, true, targetId ? targetLabel(targetId) : null);
    if (!queued) addStatus('📨 Menunggu koneksi...', 'warn');
    textInput.value = '';
  }

  sendBtn.addEventListener('click', sendText);
  textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendText();
    }
  });

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

  async function sendFile(file) {
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

    const targetId = targetSelect.value || null;
    const targetName = targetId ? targetLabel(targetId) : null;
    const fileId = makeFileId();
    const view = createTransferView({
      fileId,
      direction: 'out',
      from: myName,
      name: file.name,
      size,
      targetName,
    });

    const startMessage = {
      type: 'file-start',
      fileId,
      name: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      size,
    };
    if (targetId) startMessage.target = targetId;

    if (!socketSend(startMessage)) {
      view.fail('Koneksi terputus');
      return;
    }

    const ack = await waitForAck(fileId);
    if (!ack.ok) {
      failedTransfers.delete(fileId);
      view.fail(ack.message || 'Ditolak server');
      return;
    }
    if (!ack.recipients) {
      failedTransfers.delete(fileId);
      view.fail('Tidak ada penerima online');
      return;
    }

    const idBytes = new TextEncoder().encode(fileId);
    const headerLength = 1 + idBytes.length;
    let offset = 0;
    let index = 0;

    try {
      while (offset < size) {
        if (!ws || ws.readyState !== 1) throw new Error('Koneksi terputus');
        if (failedTransfers.has(fileId)) throw new Error(failedTransfers.get(fileId));

        const buffer = await readBlob(file.slice(offset, offset + CHUNK));
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
        offset += buffer.byteLength;
        index += 1;
        view.update(offset);
        if (index % 8 === 0) await sleep(0);
      }

      if (!socketSend({ type: 'file-end', fileId })) {
        throw new Error('Koneksi terputus saat menyelesaikan file');
      }
      const endAck = await waitForAck(fileId);
      if (!endAck.ok) throw new Error(endAck.message || 'Server menolak file');
      view.complete();
      addFile(myName || 'saya', file.name, file.type || 'application/octet-stream', file, true);
    } catch (error) {
      logWarning('File transfer failed', error);
      view.fail(error.message || 'Transfer gagal');
      if (ws && ws.readyState === 1) socketSend({ type: 'file-cancel', fileId });
    } finally {
      failedTransfers.delete(fileId);
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
    for (let index = 0; index < files.length; index += 1) {
      await sendFile(files[index]);
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
    const files = Array.from(event.dataTransfer.files);
    for (const file of files) await sendFile(file);
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
    if (authBlocked) return;
    if (!ws || ws.readyState > WebSocket.OPEN) {
      reconnectAttempt = 0;
      connect();
    }
  });

  void boot();
})();
