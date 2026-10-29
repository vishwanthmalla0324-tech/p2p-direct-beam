/* ============================================================================
   DIRECT BEAM — HIGH-PERFORMANCE WEBRTC P2P ENGINE (COMPLETE APP CONTROLLER)
   ============================================================================ */

(() => {
  'use strict';

  // --- Configuration Constants ---
  const CHUNK_SIZE = 256 * 1024; // 256 KB per frame
  const BUFFER_CEILING = 8 * 1024 * 1024; // 8 MB buffer threshold
  const BUFFER_FLOOR = 1024 * 1024; // 1 MB backpressure resumption floor

  // --- Dynamic ICE Configuration (STUN + TURN Fallback) ---
  let RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };

  async function loadIceConfiguration() {
    try {
      const res = await fetch('/api/ice-servers');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          RTC_CONFIG.iceServers = data.iceServers;
        }
      }
    } catch (err) {
      console.warn('Using default STUN ICE servers:', err);
    }
  }

  loadIceConfiguration();

  // --- State Variables ---
  let socket = null;
  let currentRoomId = null;
  let isSender = false;
  let selectedFiles = [];
  let peerConnections = new Map(); // peerId -> { pc, dc, isTransferring }
  let html5QrCodeScanner = null;
  let currentFacingMode = 'environment';
  let receivedFilesArchive = []; // { name, blob, size }

  // --- Quick Beam State Variables ---
  let pendingQuickBeamText = null; // { text, selfDestruct }
  let activeQuickBeamTimers = new Map(); // id -> timerId
  let activeReceiverChannel = null;
  let quickBeamCount = 0;

  // --- Telemetry & WebGL Visualizer Bridge ---
  window.updateBeamTelemetry = function({ speed, latency, protocol, packetLoss, roomCode, status }) {
    if (speed !== undefined) {
      const speedEl = document.getElementById('throughput-value') || document.getElementById('telemetry-speed');
      const speedBar = document.getElementById('throughput-progress') || document.getElementById('telemetry-speed-bar');
      if (speedEl) speedEl.textContent = speed;
      if (speedBar) {
        const numSpeed = parseFloat(speed) || 0;
        const pct = Math.min(100, (numSpeed / 50) * 100);
        speedBar.style.width = `${pct}%`;
      }
    }

    if (roomCode) {
      const roomText = document.getElementById('mesh-room-display') || document.getElementById('beam-room-text');
      if (roomText) roomText.textContent = roomCode;
    }

    if (status) {
      const statusText = document.getElementById('beam-status-text');
      if (statusText) statusText.textContent = status;
    }

    if (latency) {
      const latText = document.getElementById('beam-latency-text');
      if (latText) latText.textContent = latency;
    }

    if (packetLoss !== undefined) {
      const lossEl = document.getElementById('telemetry-loss');
      if (lossEl) lossEl.textContent = packetLoss;
    }
  };

  function updateVisualizerTransferSpeed(isTransferring) {
    if (window.setDirectBeamTransferSpeed) {
      window.setDirectBeamTransferSpeed(isTransferring);
    }
    if (window.setBeamActive) {
      window.setBeamActive(isTransferring);
    }
  }

  // --- UI Elements ---
  const toastEl = document.getElementById('toast');
  const toastMessageEl = document.getElementById('toast-message');
  const coldStartBanner = document.getElementById('cold-start-banner');

  // Views
  const selectionView = document.getElementById('selection-view');
  const senderView = document.getElementById('sender-view');
  const receiverView = document.getElementById('receiver-view');

  // Inputs / Controls
  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const manualCodeInput = document.getElementById('manual-code-input');
  const joinBtn = document.getElementById('join-btn');
  const scanQrBtn = document.getElementById('scan-qr-btn');
  const scannerWrapper = document.getElementById('scanner-wrapper');
  const closeScannerBtn = document.getElementById('close-scanner-btn');
  const flipCameraBtn = document.getElementById('flip-camera-btn');

  // Sender UI
  const displayCode = document.getElementById('display-code');
  const qrcodeBox = document.getElementById('qrcode-box');
  const copyLinkBtn = document.getElementById('copy-link-btn');
  const connectedCountPill = document.getElementById('connected-count-pill');
  const toggleManifestBtn = document.getElementById('toggle-manifest-btn');
  const senderQueueList = document.getElementById('sender-queue-list');
  const queueSummaryCount = document.getElementById('queue-summary-count');
  const queueSummarySize = document.getElementById('queue-summary-size');
  const receiversActivityFeed = document.getElementById('receivers-activity-feed');
  const stopSharingBtn = document.getElementById('stop-sharing-btn');

  // Receiver UI
  const receiverBatchSubtitle = document.getElementById('receiver-batch-subtitle');
  const receiverProgressBar = document.getElementById('receiver-progress-bar');
  const receiverPercentage = document.getElementById('receiver-percentage');
  const receiverSpeedText = document.getElementById('receiver-speed-text');
  const receiverEtaText = document.getElementById('receiver-eta-text');
  const receiverManifestList = document.getElementById('receiver-manifest-list');
  const receiverCompleteCard = document.getElementById('receiver-complete-card');
  const downloadZipBtn = document.getElementById('download-zip-btn');
  const cancelReceiverBtn = document.getElementById('cancel-receiver-btn');

  // Quick Beam Tab Switcher & Inputs
  const tabFiles = document.getElementById('tab-files');
  const tabText = document.getElementById('tab-text');
  const quickBeamContainer = document.getElementById('quick-beam-container');
  const quickBeamInput = document.getElementById('quick-beam-input');
  const quickBeamCharCount = document.getElementById('quick-beam-char-count');
  const quickBeamWordCount = document.getElementById('quick-beam-word-count');
  const quickBeamSelfDestructToggle = document.getElementById('quick-beam-self-destruct-toggle');
  const quickBeamTimerWrapper = document.getElementById('quick-beam-timer-wrapper');
  const quickBeamTimerSelect = document.getElementById('quick-beam-timer-select');
  const quickBeamClearBtn = document.getElementById('quick-beam-clear-btn');
  const btnSendText = document.getElementById('btn-send-text');

  // Sender In-Session Quick Beam Composer
  const senderQuickBeamPanel = document.getElementById('sender-quick-beam-panel');
  const senderQuickBeamInput = document.getElementById('sender-quick-beam-input');
  const senderSelfDestructToggle = document.getElementById('sender-self-destruct-toggle');
  const senderBtnSendText = document.getElementById('sender-btn-send-text');
  const toggleSenderTextBtn = document.getElementById('toggle-sender-text-btn');
  const senderTextComposer = document.getElementById('sender-text-composer');
  const senderTextToggleLabel = document.getElementById('sender-text-toggle-label');
  const senderTextToggleIcon = document.getElementById('sender-text-toggle-icon');

  // Receiver Quick Beam Elements
  const incomingTextSection = document.getElementById('incoming-text-section');
  const incomingTextList = document.getElementById('incoming-text-list');
  const incomingTextCount = document.getElementById('incoming-text-count');
  const receiverProgressCard = document.getElementById('receiver-progress-card');
  const receiverManifestSection = document.getElementById('receiver-manifest-section');

  // Pro Monetization & Licensing Elements (Lemon Squeezy)
  const proLicenseModal = document.getElementById('pro-license-modal');
  const proLicenseModalBackdrop = document.getElementById('pro-license-modal-backdrop');
  const proLicenseModalContent = document.getElementById('pro-license-modal-content');
  const licenseKeyInput = document.getElementById('license-key-input');
  const btnVerifyLicense = document.getElementById('btn-verify-license');
  const btnVerifyLicenseText = document.getElementById('btn-verify-license-text');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const licenseStatusMsg = document.getElementById('license-status-msg');
  const btnOpenLicenseModal = document.getElementById('btn-open-license-modal');
  const footerEnterKeyBtn = document.getElementById('footer-enter-key-btn');
  const proBadgeHeader = document.getElementById('pro-badge-header');
  const proNavCta = document.getElementById('pro-nav-cta');
  const proActiveCta = document.getElementById('pro-active-cta');
  const btnDeactivatePro = document.getElementById('btn-deactivate-pro');

  // Modals & Navigation
  const brandHomeLink = document.getElementById('brand-home-link');
  const navBeamBtn = document.getElementById('nav-beam-btn');
  const navFaqBtn = document.getElementById('nav-faq-btn');
  const navSecurityBtn = document.getElementById('nav-security-btn');
  const navFounderBtn = document.getElementById('nav-founder-btn');
  const openFounderModalBtn = document.getElementById('open-founder-modal-btn');

  const founderModal = document.getElementById('founder-modal');
  const founderModalBackdrop = document.getElementById('founder-modal-backdrop');
  const founderModalContent = document.getElementById('founder-modal-content');
  const closeFounderModalBtn = document.getElementById('close-founder-modal-btn');

  const faqModal = document.getElementById('faq-modal');
  const faqModalBackdrop = document.getElementById('faq-modal-backdrop');
  const closeFaqModalBtn = document.getElementById('close-faq-modal-btn');

  const securityModal = document.getElementById('security-modal');
  const securityModalBackdrop = document.getElementById('security-modal-backdrop');
  const closeSecurityModalBtn = document.getElementById('close-security-modal-btn');

  // Modal Email Copy
  const modalCopyEmailBtn = document.getElementById('modal-copy-email-btn');

  // Social Share
  const shareWa = document.getElementById('share-wa');
  const shareFb = document.getElementById('share-fb');
  const shareX = document.getElementById('share-x');
  const shareLi = document.getElementById('share-li');
  const shareGmail = document.getElementById('share-gmail');
  const shareNative = document.getElementById('share-native');

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  function showToast(message, duration = 3000) {
    if (!toastEl) return;
    toastMessageEl.textContent = message;
    toastEl.classList.remove('translate-y-[-20px]', 'opacity-0', 'pointer-events-none');
    toastEl.classList.add('translate-y-0', 'opacity-100');

    setTimeout(() => {
      toastEl.classList.add('translate-y-[-20px]', 'opacity-0', 'pointer-events-none');
      toastEl.classList.remove('translate-y-0', 'opacity-100');
    }, duration);
  }
  window.showToast = showToast;

  function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return 'Calculating...';
    if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
    const m = Math.floor(seconds / 60);
    const s = Math.ceil(seconds % 60);
    return `${m}m ${s}s remaining`;
  }

  function copyTextToClipboard(text, successMessage = 'Copied to clipboard!') {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => showToast(successMessage));
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        showToast(successMessage);
      } catch (err) {
        showToast('Failed to copy text');
      }
      document.body.removeChild(textArea);
    }
  }

  // ==========================================================================
  // QUICK BEAM ENGINE (Instant Text, URL Auto-Linker, XSS Sanitizer & Self-Destruct)
  // ==========================================================================

  function generateUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'qb_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatAndSanitizeText(rawText) {
    const escaped = escapeHtml(rawText);
    const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
    return escaped.replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-cyan-400 hover:text-white underline underline-offset-2 break-all transition">${url}</a>`;
    });
  }

  function sendQuickBeamText(text, selfDestructOptions = { enabled: false, durationSeconds: 0 }) {
    if (!text || !text.trim()) {
      showToast('Cannot beam empty text');
      return false;
    }

    if (text.length > 50000) {
      showToast('Text exceeds 50,000 character limit');
      return false;
    }

    const payload = {
      type: 'QUICK_BEAM_TEXT',
      payload: {
        id: generateUuid(),
        text: text,
        timestamp: Date.now(),
        selfDestruct: {
          enabled: !!selfDestructOptions.enabled,
          durationSeconds: parseInt(selfDestructOptions.durationSeconds, 10) || 0
        }
      }
    };

    const serialized = JSON.stringify(payload);
    let sentCount = 0;

    // Send through active sender peer data channels
    peerConnections.forEach((peer, peerId) => {
      if (peer.dc && peer.dc.readyState === 'open') {
        try {
          peer.dc.send(serialized);
          sentCount++;
        } catch (err) {
          console.error(`Failed to send text to peer ${peerId}:`, err);
        }
      }
    });

    // Also support bidirectional response if receiver channel is active
    if (activeReceiverChannel && activeReceiverChannel.readyState === 'open') {
      try {
        activeReceiverChannel.send(serialized);
        sentCount++;
      } catch (err) {
        console.error('Failed to send text over receiver channel:', err);
      }
    }

    if (sentCount > 0) {
      showToast(selfDestructOptions.enabled ? '⚡ Self-destructing note beamed to peer!' : '⚡ Text note beamed to peer!');
      logSenderActivity('Beamed text payload to connected peer(s)');
      return true;
    } else {
      showToast('No active peer data channel connected yet.');
      return false;
    }
  }

  function handleIncomingQuickBeam(payload) {
    if (!payload || !payload.text) return;
    const id = payload.id || generateUuid();
    let rawText = payload.text;
    const timestamp = payload.timestamp || Date.now();
    const selfDestruct = payload.selfDestruct || { enabled: false, durationSeconds: 0 };
    const isSelfDestruct = !!selfDestruct.enabled;
    const durationSeconds = parseInt(selfDestruct.durationSeconds, 10) || 0;

    quickBeamCount++;

    if (incomingTextSection) {
      incomingTextSection.classList.remove('hidden');
    }
    if (incomingTextCount) {
      incomingTextCount.textContent = `${quickBeamCount} Note${quickBeamCount === 1 ? '' : 's'}`;
    }

    if (receiverBatchSubtitle) {
      receiverBatchSubtitle.textContent = 'Beamed text received directly via P2P Mesh';
    }

    // Hide file progress card if pure text session
    if (selectedFiles.length === 0 && receivedFilesArchive.length === 0) {
      if (receiverProgressCard) receiverProgressCard.classList.add('hidden');
      if (receiverManifestSection) receiverManifestSection.classList.add('hidden');
    }

    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const wordCount = rawText.trim() ? rawText.trim().split(/\s+/).length : 0;
    const charCount = rawText.length;
    const formattedText = formatAndSanitizeText(rawText);

    const card = document.createElement('div');
    card.id = `qb-card-${id}`;
    card.className = 'db-card-heavy p-5 space-y-3 border-2 border-base-900 bg-black/90 relative overflow-hidden transition-all duration-300';

    let selfDestructBadge = '';
    let progressBarHtml = '';
    let burnNowBtnHtml = '';

    if (isSelfDestruct) {
      selfDestructBadge = `
        <span class="db-pill text-[10px] text-rose-400 border-rose-500/40 flex items-center gap-1" id="qb-timer-badge-${id}">
          <i data-lucide="flame" class="w-3 h-3 text-rose-400"></i>
          <span id="qb-timer-val-${id}">Burn in ${durationSeconds > 0 ? durationSeconds + 's' : 'Instant'}</span>
        </span>
      `;
      progressBarHtml = `
        <div class="w-full bg-base-300 h-1.5 border border-base-400 overflow-hidden">
          <div id="qb-progress-bar-${id}" class="bg-rose-500 h-full w-full transition-all duration-1000"></div>
        </div>
      `;
      burnNowBtnHtml = `
        <button id="qb-burn-btn-${id}" type="button" class="text-[11px] font-mono text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer transition uppercase">
          <i data-lucide="flame" class="w-3.5 h-3.5"></i>
          <span>Burn Now</span>
        </button>
      `;
    }

    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-base-400">
        <div class="flex items-center gap-2 text-xs font-mono">
          <span class="db-pill text-[10px] text-amber-400 border-amber-400/40 flex items-center gap-1">
            <i data-lucide="zap" class="w-3 h-3"></i>
            <span>QUICK BEAM</span>
          </span>
          <span class="text-base-600 text-[10px]">${timeStr}</span>
        </div>
        <div class="flex items-center gap-2">
          ${selfDestructBadge}
          <button id="qb-copy-btn-${id}" type="button" class="cyber-btn-secondary px-3 py-1 text-xs font-mono uppercase flex items-center gap-1.5 cursor-pointer hover:border-white transition" title="Copy to clipboard">
            <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            <span>Copy</span>
          </button>
        </div>
      </div>

      ${progressBarHtml}

      <div class="qb-text-content font-mono text-sm text-white leading-relaxed break-words whitespace-pre-wrap select-all bg-base-100/90 p-4 border border-base-900 max-h-96 overflow-y-auto">
        ${formattedText}
      </div>

      <div class="flex items-center justify-between text-[11px] font-mono text-base-600 pt-1">
        <span>${charCount.toLocaleString()} chars • ${wordCount.toLocaleString()} words</span>
        ${burnNowBtnHtml}
      </div>
    `;

    if (incomingTextList) {
      incomingTextList.prepend(card);
    }

    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }

    // 1-Click Clipboard with dynamic feedback
    const copyBtn = card.querySelector(`#qb-copy-btn-${id}`);
    if (copyBtn) {
      copyBtn.onclick = () => {
        if (!rawText) return;
        copyTextToClipboard(rawText, 'Secret text copied to clipboard!');
        copyBtn.classList.remove('cyber-btn-secondary');
        copyBtn.classList.add('border-emerald-500', 'text-emerald-400', 'bg-emerald-950/40');
        copyBtn.innerHTML = `
          <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
          <span class="text-emerald-400 font-bold">Copied! ✓</span>
        `;
        setTimeout(() => {
          if (copyBtn && card.parentElement) {
            copyBtn.classList.add('cyber-btn-secondary');
            copyBtn.classList.remove('border-emerald-500', 'text-emerald-400', 'bg-emerald-950/40');
            copyBtn.innerHTML = `
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              <span>Copy</span>
            `;
          }
        }, 2500);

        if (isSelfDestruct && durationSeconds === 0) {
          burnNote();
        }
      };
    }

    function burnNote() {
      if (activeQuickBeamTimers.has(id)) {
        clearInterval(activeQuickBeamTimers.get(id));
        activeQuickBeamTimers.delete(id);
      }

      // Memory wipe: overwrite and nullify references
      rawText = null;
      payload.text = null;

      card.innerHTML = `
        <div class="p-4 border-2 border-rose-500/50 bg-rose-950/30 text-rose-300 font-mono text-xs flex items-center justify-between">
          <span class="flex items-center gap-2 font-bold uppercase tracking-wider">
            <svg class="w-4 h-4 text-rose-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
            <span>Secret Note Burned &amp; Purged From Memory</span>
          </span>
          <span class="text-[10px] text-rose-500 font-mono">WIPED</span>
        </div>
      `;

      showToast('Secret note burned and wiped from memory.');

      setTimeout(() => {
        card.style.opacity = '0';
        card.style.transform = 'scale(0.97)';
        setTimeout(() => {
          card.remove();
          quickBeamCount = Math.max(0, quickBeamCount - 1);
          if (incomingTextCount) {
            incomingTextCount.textContent = `${quickBeamCount} Note${quickBeamCount === 1 ? '' : 's'}`;
          }
          if (quickBeamCount === 0 && incomingTextSection) {
            incomingTextSection.classList.add('hidden');
          }
        }, 350);
      }, 2500);
    }

    const burnBtn = card.querySelector(`#qb-burn-btn-${id}`);
    if (burnBtn) {
      burnBtn.onclick = burnNote;
    }

    if (isSelfDestruct && durationSeconds > 0) {
      let remaining = durationSeconds;
      const total = durationSeconds;
      const bar = card.querySelector(`#qb-progress-bar-${id}`);
      const timerVal = card.querySelector(`#qb-timer-val-${id}`);

      const timerId = setInterval(() => {
        remaining--;
        if (bar) {
          const pct = Math.max(0, (remaining / total) * 100);
          bar.style.width = `${pct}%`;
        }
        if (timerVal) {
          timerVal.textContent = `Burn in ${remaining}s`;
        }
        if (remaining <= 0) {
          burnNote();
        }
      }, 1000);

      activeQuickBeamTimers.set(id, timerId);
    } else if (isSelfDestruct && durationSeconds === 0) {
      const timerVal = card.querySelector(`#qb-timer-val-${id}`);
      if (timerVal) timerVal.textContent = 'Burn on copy / 15s';
      const timerId = setTimeout(() => {
        burnNote();
      }, 15000);
      activeQuickBeamTimers.set(id, timerId);
    }

    showToast('⚡ Incoming Quick Beam Note received!');
  }

  // ==========================================================================
  // VIEW SWITCHER
  // ==========================================================================

  function switchView(viewName) {
    selectionView.classList.add('hidden');
    senderView.classList.add('hidden');
    receiverView.classList.add('hidden');

    if (viewName === 'selection') selectionView.classList.remove('hidden');
    if (viewName === 'sender') senderView.classList.remove('hidden');
    if (viewName === 'receiver') receiverView.classList.remove('hidden');
  }

  // ==========================================================================
  // SOCKET.IO SIGNALING WITH DYNAMIC PROTOCOL NEGOTIATION
  // ==========================================================================

  function initSocket() {
    if (socket) return;
    if (typeof io === 'undefined') {
      setTimeout(initSocket, 100);
      return;
    }

    const coldStartTimer = setTimeout(() => {
      if (coldStartBanner) coldStartBanner.classList.remove('hidden');
    }, 2500);

    // WebSocket first with polling fallback for Cloudflare Worker edge signaling
    socket = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    socket.on('connect', () => {
      clearTimeout(coldStartTimer);
      if (coldStartBanner) coldStartBanner.classList.add('hidden');
    });

    socket.on('connect_error', (err) => {
      // Handled gracefully without logging fatal uncaught exceptions
    });

    socket.on('room-created', (payload) => {
      let code = null;
      if (typeof payload === 'string') {
        code = payload;
      } else if (payload && typeof payload === 'object') {
        code = payload.roomCode || payload.code || payload.roomId;
      }

      if (!code) {
        showToast('Error generating room code');
        return;
      }

      currentRoomId = code;
      isSender = true;
      switchView('sender');

      if (window.updateBeamTelemetry) {
        window.updateBeamTelemetry({ roomCode: code, status: 'ROOM ACTIVE' });
      }

      try {
        setupSenderRoomUI(code);
      } catch (err) {
        console.error('Error rendering sender room UI:', err);
      }
    });

    socket.on('room-joined', (payload) => {
      let code = null;
      if (typeof payload === 'string') {
        code = payload;
      } else if (payload && typeof payload === 'object') {
        code = payload.roomCode || payload.code || payload.roomId;
      }

      currentRoomId = code || currentRoomId;
      isSender = false;
      switchView('receiver');
      if (window.updateBeamTelemetry) {
        window.updateBeamTelemetry({ roomCode: currentRoomId, status: 'CONNECTED', latency: '~2ms P2P' });
      }
      if (receiverBatchSubtitle) {
        receiverBatchSubtitle.textContent = 'Signaling connected. Awaiting sender handshake...';
      }
    });

    socket.on('peer-joined', async ({ peerId }) => {
      if (isSender) {
        logSenderActivity(`Device connected (${peerId.slice(0, 5)})`);
        await createSenderPeerConnection(peerId);
        updatePeerCountUI();
        if (window.updateBeamTelemetry) {
          window.updateBeamTelemetry({ status: 'PEER CONNECTED', latency: '~2ms P2P' });
        }
      }
    });

    socket.on('peer-disconnected', ({ peerId }) => {
      if (peerConnections.has(peerId)) {
        const { pc, dc } = peerConnections.get(peerId);
        try { if (dc) dc.close(); } catch (e) {}
        try { if (pc) pc.close(); } catch (e) {}
        peerConnections.delete(peerId);
        updatePeerCountUI();
        logSenderActivity(`Device disconnected (${peerId.slice(0, 5)})`);
      }
    });

    socket.on('signal', async ({ senderId, data }) => {
      if (isSender) {
        const peer = peerConnections.get(senderId);
        if (!peer) return;
        if (data.sdp) {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.candidate) {
          try {
            await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            console.warn('Error adding ICE candidate', e);
          }
        }
      } else {
        await handleReceiverSignal(senderId, data);
      }
    });

    socket.on('error-msg', (msg) => {
      showToast(msg);
      resetToHome();
    });
  }

  // ==========================================================================
  // SENDER ENGINE (Isolated Pipelines & Cooperative Event Loop Yielding)
  // ==========================================================================

  function updatePeerCountUI() {
    const count = peerConnections.size;
    if (connectedCountPill) {
      connectedCountPill.textContent = `${count} device${count === 1 ? '' : 's'} connected`;
    }
  }

  function logSenderActivity(msg) {
    if (!receiversActivityFeed) return;
    const existingPlaceholder = receiversActivityFeed.querySelector('p.italic');
    if (existingPlaceholder) existingPlaceholder.remove();

    const row = document.createElement('div');
    row.className = 'text-[11px] text-slate-300 flex items-center justify-between border-b border-cyan-500/10 py-1.5 font-mono';
    row.innerHTML = `<span class="inline-flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-cyan-400"></span>${msg}</span><span class="text-slate-500 font-mono text-[10px]">${new Date().toLocaleTimeString()}</span>`;
    receiversActivityFeed.prepend(row);
  }

  function setupSenderRoomUI(code) {
    if (displayCode) displayCode.textContent = code;

    // Render QR Code
    if (qrcodeBox && typeof QRCode !== 'undefined') {
      qrcodeBox.innerHTML = '';
      const shareUrl = `${window.location.origin}/?code=${code}`;
      new QRCode(qrcodeBox, {
        text: shareUrl,
        width: 140,
        height: 140,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    }

    // Manifest Details
    const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    if (queueSummaryCount) {
      queueSummaryCount.textContent = selectedFiles.length > 0 
        ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}`
        : 'Quick Beam Mode (0 files)';
    }
    if (queueSummarySize) {
      queueSummarySize.textContent = selectedFiles.length > 0 ? formatBytes(totalBytes) : 'Instant Text Mesh';
    }

    if (senderQueueList) {
      senderQueueList.innerHTML = '';
      selectedFiles.forEach((f) => {
        const li = document.createElement('li');
        li.className = 'flex justify-between items-center py-1.5 px-2.5 rounded-lg bg-slate-900/50 border border-cyan-500/15';
        li.innerHTML = `<span class="truncate max-w-[220px] text-slate-200">${f.name}</span><span class="font-mono text-cyan-400 text-[10px]">${formatBytes(f.size)}</span>`;
        senderQueueList.appendChild(li);
      });
    }

    // Dynamic Share Links
    const shareUrl = `${window.location.origin}/?code=${code}`;
    const encodedUrl = encodeURIComponent(shareUrl);
    const encodedText = encodeURIComponent(`Download ${selectedFiles.length} file(s) via Direct Beam P2P: ${shareUrl}`);

    if (shareWa) shareWa.onclick = () => window.open(`https://api.whatsapp.com/send?text=${encodedText}`, '_blank');
    if (shareFb) shareFb.onclick = () => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`, '_blank');
    if (shareX) shareX.onclick = () => window.open(`https://twitter.com/intent/tweet?text=${encodedText}`, '_blank');
    if (shareLi) shareLi.onclick = () => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`, '_blank');
    if (shareGmail) shareGmail.onclick = () => window.open(`https://mail.google.com/mail/?view=cm&fs=1&su=Direct+Beam+Files&body=${encodedText}`, '_blank');
    if (shareNative) {
      shareNative.onclick = async () => {
        if (navigator.share) {
          try {
            await navigator.share({ title: 'Direct Beam Transfer', text: 'P2P File Transfer Link', url: shareUrl });
          } catch (e) {}
        } else {
          copyTextToClipboard(shareUrl, 'Share link copied!');
        }
      };
    }
  }

  async function createSenderPeerConnection(peerId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    
    const dc = pc.createDataChannel('fileStream', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_FLOOR;

    const peerObj = { pc, dc, isTransferring: false };
    peerConnections.set(peerId, peerObj);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', { targetId: peerId, data: { candidate: event.candidate } });
      }
    };

    dc.onopen = () => {
      logSenderActivity(`Channel open with device (${peerId.slice(0, 5)})`);
      startBatchStreamToPeer(peerId);
    };

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'QUICK_BEAM_TEXT') {
            handleIncomingQuickBeam(payload.payload || payload);
          }
        } catch (e) {
          console.warn('Sender data channel JSON parse error:', e);
        }
      }
    };

    dc.onerror = (err) => console.error('DataChannel error on sender:', err);
    dc.onclose = () => logSenderActivity(`Channel closed with device (${peerId.slice(0, 5)})`);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { targetId: peerId, data: { sdp: pc.localDescription } });
  }

  // Independent pipeline per peer to avoid head-of-line blocking across multiple receivers
  async function startBatchStreamToPeer(peerId) {
    const peer = peerConnections.get(peerId);
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') return;

    // Disclose staged quick beam text immediately on peer connect
    if (pendingQuickBeamText) {
      sendQuickBeamText(pendingQuickBeamText.text, pendingQuickBeamText.selfDestruct);
      pendingQuickBeamText = null;
      logSenderActivity(`Auto-beamed staged note to (${peerId.slice(0, 5)})`);
    }

    // Skip file streaming loop if in Quick Beam text-only mode
    if (selectedFiles.length === 0) {
      if (window.updateBeamTelemetry) {
        window.updateBeamTelemetry({ status: 'MESH CONNECTED', latency: '~2ms P2P' });
      }
      return;
    }

    if (peer.isTransferring) return;

    if (!canInitiateTransfer()) {
      return;
    }

    peer.isTransferring = true;
    updateVisualizerTransferSpeed(true);
    if (window.updateBeamTelemetry) {
      window.updateBeamTelemetry({ status: 'STREAMING FILES', latency: '~2ms P2P' });
    }

    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        // Discontinue if receiver disconnected mid-batch
        if (!peerConnections.has(peerId) || peer.dc.readyState !== 'open') break;

        const file = selectedFiles[i];
        const fileId = `file_${i}_${Date.now()}`;
        logSenderActivity(`Streaming ${file.name} to (${peerId.slice(0, 5)})`);

        await streamSingleFile(peer.dc, file, fileId);
      }

      if (peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send(JSON.stringify({ type: 'batch-complete' }));
        logSenderActivity(`Batch complete for (${peerId.slice(0, 5)})`);
        recordSuccessfulTransfer();
      }
    } catch (err) {
      console.error(`Streaming error to device ${peerId}:`, err);
    } finally {
      peer.isTransferring = false;
      updateVisualizerTransferSpeed(false);
      if (window.updateBeamTelemetry) {
        window.updateBeamTelemetry({ speed: '0.00', status: 'BATCH COMPLETE' });
      }
    }
  }

  async function streamSingleFile(dc, file, fileId) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 1. Send Manifest
    dc.send(JSON.stringify({
      type: 'manifest',
      fileId: fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks: totalChunks
    }));

    // 2. Stream Binary Chunks with Cooperative Event Loop Yielding
    let offset = 0;
    let chunksSinceYield = 0;

    while (offset < file.size) {
      if (dc.readyState !== 'open') throw new Error('DataChannel closed unexpectedly');

      if (dc.bufferedAmount > BUFFER_CEILING) {
        if (dc.readyState !== 'open') {
          throw new Error('DataChannel closed before backpressure drain');
        }

        await new Promise((resolve, reject) => {
          let timeoutId = setTimeout(() => {
            cleanup();
            // 3000ms safety timeout: resolve so transfer can proceed or re-check channel state
            resolve();
          }, 3000);

          function onDrain() {
            cleanup();
            resolve();
          }

          function onAbort() {
            cleanup();
            reject(new Error('DataChannel disconnected during backpressure wait'));
          }

          function cleanup() {
            clearTimeout(timeoutId);
            if (dc) {
              dc.removeEventListener('bufferedamountlow', onDrain);
              dc.removeEventListener('close', onAbort);
              dc.removeEventListener('error', onAbort);
            }
          }

          dc.addEventListener('bufferedamountlow', onDrain, { once: true });
          dc.addEventListener('close', onAbort, { once: true });
          dc.addEventListener('error', onAbort, { once: true });
        });
      }

      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const slice = file.slice(offset, end);
      const buffer = await slice.arrayBuffer();

      dc.send(buffer);
      offset += buffer.byteLength;
      chunksSinceYield++;

      // Yield execution back to browser thread every 8 chunks (~2 MB) to prevent browser UI lock
      if (chunksSinceYield >= 8) {
        chunksSinceYield = 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // 3. Send EOF delimiter
    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'eof', fileId: fileId, name: file.name }));
    }
  }

  // ==========================================================================
  // RECEIVER ENGINE (Assembly & Progress Management)
  // ==========================================================================

  let receiverPeerConnection = null;

  async function handleReceiverSignal(senderId, data) {
    if (!receiverPeerConnection) {
      receiverPeerConnection = new RTCPeerConnection(RTC_CONFIG);

      receiverPeerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('signal', { targetId: senderId, data: { candidate: event.candidate } });
        }
      };

      receiverPeerConnection.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = 'arraybuffer';
        activeReceiverChannel = dc;
        setupReceiverChannel(dc);
      };
    }

    if (data.sdp) {
      await receiverPeerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await receiverPeerConnection.createAnswer();
      await receiverPeerConnection.setLocalDescription(answer);
      socket.emit('signal', { targetId: senderId, data: { sdp: receiverPeerConnection.localDescription } });
    } else if (data.candidate) {
      try {
        await receiverPeerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn('Receiver error adding ICE candidate', e);
      }
    }
  }

  function setupReceiverChannel(dc) {
    let currentManifest = null;
    let receivedBytes = 0;
    let receivedChunks = [];
    let startTime = 0;
    let writableStream = null;
    let isDiskStreaming = false;

    if (receiverBatchSubtitle) receiverBatchSubtitle.textContent = 'Direct P2P Link Established. Streaming...';

    dc.onmessage = async (event) => {
      // 1. Control Packet (JSON String)
      if (typeof event.data === 'string') {
        try {
          const payload = JSON.parse(event.data);

          if (payload.type === 'QUICK_BEAM_TEXT') {
            handleIncomingQuickBeam(payload.payload || payload);
            return;
          }

          if (payload.type === 'manifest') {
            currentManifest = payload;
            receivedBytes = 0;
            receivedChunks = [];
            writableStream = null;
            isDiskStreaming = false;
            startTime = performance.now();

            renderReceiverManifestItem(payload);

            // Attempt direct-to-disk streaming via File System Access API if supported
            if (typeof window.showSaveFilePicker === 'function') {
              try {
                const handle = await window.showSaveFilePicker({
                  suggestedName: payload.name
                });
                writableStream = await handle.createWritable();
                isDiskStreaming = true;
                updateReceiverManifestItemBadge(payload.fileId, 'Direct Disk Stream');
                showToast(`Streaming ${payload.name} directly to physical disk`);
              } catch (pickerErr) {
                if (pickerErr.name === 'AbortError') {
                  console.log('User dismissed file picker; falling back to memory buffer.');
                } else {
                  console.warn('Auto showSaveFilePicker deferred (requires user gesture):', pickerErr.message);
                }
                isDiskStreaming = false;
              }
            }

            // Warning for multi-gigabyte transfers when falling back to browser RAM
            if (!isDiskStreaming && payload.size > 1.5 * 1024 * 1024 * 1024) {
              showToast('Large file (>1.5 GB) buffering in browser memory. Keep tab focused.', 6000);
            }

            dc.send(JSON.stringify({ type: 'ready', fileId: payload.fileId }));
          } else if (payload.type === 'eof') {
            if (currentManifest && currentManifest.fileId === payload.fileId) {
              if (isDiskStreaming && writableStream) {
                try {
                  await writableStream.close();
                } catch (closeErr) {
                  console.error('Error closing writable stream:', closeErr);
                }
                writableStream = null;
                isDiskStreaming = false;
                markReceiverManifestItemDoneDisk(currentManifest.fileId, currentManifest.name);
                showToast(`Saved ${currentManifest.name} directly to disk!`);
              } else {
                const fileBlob = new Blob(receivedChunks, {
                  type: currentManifest.mimeType || 'application/octet-stream'
                });

                receivedFilesArchive.push({
                  name: currentManifest.name,
                  blob: fileBlob,
                  size: currentManifest.size
                });

                markReceiverManifestItemDone(currentManifest.fileId, fileBlob);
                triggerDownload(fileBlob, currentManifest.name);
              }

              currentManifest = null;
              receivedChunks = [];
            }
          } else if (payload.type === 'batch-complete') {
            if (receiverProgressBar) receiverProgressBar.style.width = '100%';
            if (receiverPercentage) receiverPercentage.textContent = '100%';
            if (receiverSpeedText) receiverSpeedText.textContent = '0.00 MB/s';
            if (receiverEtaText) receiverEtaText.textContent = 'Complete';
            if (receiverBatchSubtitle) receiverBatchSubtitle.textContent = 'All files transferred successfully!';
            if (receiverCompleteCard) receiverCompleteCard.classList.remove('hidden');
            showToast('All downloads completed!');
            updateVisualizerTransferSpeed(false);
            if (window.updateBeamTelemetry) {
              window.updateBeamTelemetry({ speed: '0.00', status: 'BATCH COMPLETE' });
            }
          }
        } catch (e) {
          console.error('Failed to parse incoming control message', e);
        }
        return;
      }

      // 2. Binary Chunk (ArrayBuffer)
      if (event.data instanceof ArrayBuffer) {
        if (!currentManifest) return;

        if (isDiskStreaming && writableStream) {
          try {
            await writableStream.write(event.data);
          } catch (writeErr) {
            console.error('Disk stream write error, falling back to memory:', writeErr);
            isDiskStreaming = false;
            writableStream = null;
            receivedChunks.push(event.data);
          }
        } else {
          receivedChunks.push(event.data);
        }

        receivedBytes += event.data.byteLength;

        const fileProg = Math.min(receivedBytes / currentManifest.size, 1.0);
        const elapsedSec = (performance.now() - startTime) / 1000;
        const bps = elapsedSec > 0 ? (receivedBytes / elapsedSec) : 0;
        const mbps = (bps / (1024 * 1024)).toFixed(2);
        const remainingBytes = currentManifest.size - receivedBytes;
        const etaSeconds = bps > 0 ? remainingBytes / bps : 0;

        if (receiverProgressBar) receiverProgressBar.style.width = `${(fileProg * 100).toFixed(1)}%`;
        if (receiverPercentage) receiverPercentage.textContent = `${(fileProg * 100).toFixed(1)}%`;
        if (receiverSpeedText) receiverSpeedText.textContent = `${mbps} MB/s`;
        if (receiverEtaText) receiverEtaText.textContent = formatEta(etaSeconds);

        updateVisualizerTransferSpeed(true);
        if (window.updateBeamTelemetry) {
          window.updateBeamTelemetry({ speed: mbps, status: 'STREAMING DATA', packetLoss: '0%' });
        }

        updateReceiverManifestItemProgress(currentManifest.fileId, fileProg);
      }
    };

    dc.onerror = (e) => {
      console.error('Receiver channel error:', e);
      if (writableStream) {
        try { writableStream.abort(); } catch (err) {}
        writableStream = null;
      }
    };

    dc.onclose = () => {
      if (receiverBatchSubtitle) receiverBatchSubtitle.textContent = 'Host disconnected or transfer terminated.';
      if (writableStream) {
        try { writableStream.abort(); } catch (err) {}
        writableStream = null;
      }
    };
  }

  function renderReceiverManifestItem(manifest) {
    if (!receiverManifestList) return;
    const li = document.createElement('li');
    li.id = `item-${manifest.fileId}`;
    li.className = 'cyber-card p-3 flex items-center justify-between';
    li.innerHTML = `
      <div class="flex-1 min-w-0 mr-3">
        <div class="flex items-center gap-2">
          <span class="truncate block text-white font-medium text-xs">${manifest.name}</span>
          <span id="badge-${manifest.fileId}" class="text-[9px] font-mono px-2 py-0.5 rounded-md bg-cyan-950/80 text-cyan-300 border border-cyan-500/30">Memory Stream</span>
        </div>
        <span class="text-[10px] text-slate-400 font-mono mt-0.5 block">${formatBytes(manifest.size)}</span>
        <div class="w-full bg-slate-950 h-1.5 rounded-full mt-2 overflow-hidden border border-slate-800">
          <div class="item-progress bg-gradient-to-r from-cyan-400 to-sky-400 h-full w-0 transition-all"></div>
        </div>
      </div>
      <div class="item-action">
        <span class="text-[10px] text-cyan-400 font-mono animate-pulse">Streaming...</span>
      </div>
    `;
    receiverManifestList.appendChild(li);
  }

  function updateReceiverManifestItemBadge(fileId, text) {
    const badge = document.getElementById(`badge-${fileId}`);
    if (badge) {
      badge.textContent = text;
      badge.className = 'text-[9px] font-mono px-2 py-0.5 rounded-md bg-cyan-950/80 text-cyan-300 border border-cyan-500/30';
    }
  }

  function markReceiverManifestItemDoneDisk(fileId, filename) {
    const item = document.getElementById(`item-${fileId}`);
    if (!item) return;
    updateReceiverManifestItemBadge(fileId, 'Saved to Disk');
    const action = item.querySelector('.item-action');
    if (action) {
      action.innerHTML = `
        <span class="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 font-mono">
          <i data-lucide="check" class="w-3.5 h-3.5"></i> Saved
        </span>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  function updateReceiverManifestItemProgress(fileId, progress) {
    const item = document.getElementById(`item-${fileId}`);
    if (!item) return;
    const bar = item.querySelector('.item-progress');
    if (bar) bar.style.width = `${(progress * 100).toFixed(0)}%`;
  }

  function markReceiverManifestItemDone(fileId, blob) {
    const item = document.getElementById(`item-${fileId}`);
    if (!item) return;
    const action = item.querySelector('.item-action');
    if (action) {
      const url = URL.createObjectURL(blob);
      action.innerHTML = `
        <a href="${url}" download="${item.querySelector('.text-white').textContent}" class="cyber-btn-primary text-[10px] px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 font-mono cursor-pointer">
          <i data-lucide="download" class="w-3.5 h-3.5"></i> Save
        </a>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  function triggerDownload(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ==========================================================================
  // EVENT LISTENERS: FILE PICKER & DRAG-AND-DROP
  // ==========================================================================

  if (dropZone && fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesSelected(Array.from(e.target.files));
        fileInput.value = '';
      }
    });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });

    dropZone.addEventListener('dragover', () => {
      dropZone.classList.add('border-cyan-500', 'bg-cyan-500/10');
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropZone.addEventListener(eventName, () => {
        dropZone.classList.remove('border-cyan-500', 'bg-cyan-500/10');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFilesSelected(Array.from(e.dataTransfer.files));
      }
    });
  }

  function handleFilesSelected(files) {
    if (!files || files.length === 0) return;
    if (!canInitiateTransfer()) {
      return;
    }
    selectedFiles = files;
    initSocket();
    if (socket && socket.connected) {
      socket.emit('create-room');
    } else if (socket) {
      showToast('Connecting to signaling server...');
      socket.once('connect', () => {
        socket.emit('create-room');
      });
    }
  }

  // Receiver Joining
  if (joinBtn) {
    joinBtn.onclick = () => {
      const code = manualCodeInput.value.trim();
      if (code.length < 6) {
        showToast('Please enter a valid 6-digit code');
        return;
      }
      joinRoomByCode(code);
    };
  }

  function joinRoomByCode(code) {
    initSocket();
    if (socket && socket.connected) {
      socket.emit('join-room', { roomCode: code });
    } else if (socket) {
      socket.once('connect', () => {
        socket.emit('join-room', { roomCode: code });
      });
    }
  }

  // Copy Link Button
  if (copyLinkBtn) {
    copyLinkBtn.onclick = () => {
      const shareUrl = `${window.location.origin}/?code=${currentRoomId}`;
      copyTextToClipboard(shareUrl, 'Share link copied to clipboard!');
    };
  }

  // Toggle Manifest in Sender
  if (toggleManifestBtn) {
    toggleManifestBtn.onclick = () => {
      if (senderQueueList) senderQueueList.classList.toggle('hidden');
    };
  }

  // Reset to Home
  function resetToHome() {
    peerConnections.forEach(({ pc, dc }) => {
      try { if (dc) dc.close(); } catch (e) {}
      try { if (pc) pc.close(); } catch (e) {}
    });
    peerConnections.clear();

    if (receiverPeerConnection) {
      try { receiverPeerConnection.close(); } catch (e) {}
      receiverPeerConnection = null;
    }

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    selectedFiles = [];
    currentRoomId = null;
    isSender = false;
    receivedFilesArchive = [];

    // Reset Quick Beam state
    activeQuickBeamTimers.forEach((timerId) => clearInterval(timerId));
    activeQuickBeamTimers.clear();
    pendingQuickBeamText = null;
    activeReceiverChannel = null;
    quickBeamCount = 0;

    if (incomingTextList) incomingTextList.innerHTML = '';
    if (incomingTextSection) incomingTextSection.classList.add('hidden');
    if (incomingTextCount) incomingTextCount.textContent = '0 Notes';
    if (receiverProgressCard) receiverProgressCard.classList.remove('hidden');
    if (receiverManifestSection) receiverManifestSection.classList.remove('hidden');

    if (quickBeamInput) quickBeamInput.value = '';
    if (quickBeamCharCount) quickBeamCharCount.textContent = '0';
    if (quickBeamWordCount) quickBeamWordCount.textContent = '0';
    if (quickBeamClearBtn) quickBeamClearBtn.classList.add('hidden');
    if (btnSendText) {
      btnSendText.disabled = true;
      btnSendText.classList.add('opacity-60', 'cursor-not-allowed');
    }
    if (senderQuickBeamInput) senderQuickBeamInput.value = '';

    if (fileInput) fileInput.value = '';
    if (manualCodeInput) manualCodeInput.value = '';
    if (senderQueueList) senderQueueList.innerHTML = '';
    if (receiverManifestList) receiverManifestList.innerHTML = '';
    if (receiverCompleteCard) receiverCompleteCard.classList.add('hidden');
    if (receiverProgressBar) receiverProgressBar.style.width = '0%';
    if (receiverPercentage) receiverPercentage.textContent = '0.0%';

    updateVisualizerTransferSpeed(false);
    if (window.updateBeamTelemetry) {
      window.updateBeamTelemetry({
        speed: '0.00',
        roomCode: 'STANDBY',
        status: 'MESH READY',
        latency: '< 1ms P2P',
        packetLoss: '0%'
      });
    }

    switchView('selection');
  }

  if (stopSharingBtn) stopSharingBtn.onclick = resetToHome;
  if (cancelReceiverBtn) cancelReceiverBtn.onclick = resetToHome;
  if (brandHomeLink) brandHomeLink.onclick = resetToHome;
  if (navBeamBtn) navBeamBtn.onclick = resetToHome;

  // Download All as ZIP
  if (downloadZipBtn) {
    downloadZipBtn.onclick = async () => {
      if (receivedFilesArchive.length === 0) {
        showToast('All files were already streamed and saved directly to your disk.');
        return;
      }
      if (typeof JSZip === 'undefined') return;
      const zip = new JSZip();
      receivedFilesArchive.forEach((f) => zip.file(f.name, f.blob));
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      triggerDownload(zipBlob, `DirectBeam_${currentRoomId || 'files'}.zip`);
      showToast('Generated ZIP archive!');
    };
  }

  // ==========================================================================
  // RESPONSIVE QR SCANNER ENGINE
  // ==========================================================================

  if (scanQrBtn) {
    scanQrBtn.onclick = () => {
      if (scannerWrapper) scannerWrapper.classList.remove('hidden');
      startQrScanner();
    };
  }

  if (closeScannerBtn) {
    closeScannerBtn.onclick = () => {
      stopQrScanner();
      if (scannerWrapper) scannerWrapper.classList.add('hidden');
    };
  }

  if (flipCameraBtn) {
    flipCameraBtn.onclick = () => {
      currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
      stopQrScanner();
      startQrScanner();
    };
  }

  let isQrScannerLoading = false;

  function startQrScanner() {
    if (typeof Html5Qrcode === 'undefined') {
      if (isQrScannerLoading) return;
      isQrScannerLoading = true;
      showToast('Initializing QR Scanner...');
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
      script.onload = () => {
        isQrScannerLoading = false;
        if (typeof Html5Qrcode !== 'undefined') {
          startQrScanner();
        } else {
          showToast('Unable to load QR Scanner engine.');
        }
      };
      script.onerror = () => {
        isQrScannerLoading = false;
        showToast('Unable to load QR Scanner engine.');
      };
      document.body.appendChild(script);
      return;
    }

    const qrboxFunction = (viewfinderWidth, viewfinderHeight) => {
      const minEdgePercentage = 0.70;
      const minEdgeSize = Math.min(viewfinderWidth, viewfinderHeight);
      const qrboxSize = Math.floor(minEdgeSize * minEdgePercentage);
      return {
        width: Math.max(qrboxSize, 180),
        height: Math.max(qrboxSize, 180)
      };
    };

    html5QrCodeScanner = new Html5Qrcode('qr-reader');
    
    const config = {
      fps: 15,
      qrbox: qrboxFunction,
      aspectRatio: 1.0,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true
      }
    };

    html5QrCodeScanner.start(
      { facingMode: currentFacingMode },
      config,
      (decodedText) => {
        stopQrScanner();
        if (scannerWrapper) scannerWrapper.classList.add('hidden');

        let code = '';
        const urlMatch = decodedText.match(/code=([0-9]{6})/i) || decodedText.match(/code=([A-Za-z0-9]{6})/i);
        if (urlMatch) {
          code = urlMatch[1];
        } else {
          const directMatch = decodedText.match(/\b([0-9]{6})\b/) || decodedText.match(/\b([A-Za-z0-9]{6})\b/);
          code = directMatch ? directMatch[1] : decodedText.trim().slice(0, 6);
        }

        if (manualCodeInput) manualCodeInput.value = code;
        joinRoomByCode(code);
      },
      () => {}
    ).catch((err) => {
      console.warn('Unable to start QR Scanner:', err);
      showToast('Camera error: check permissions');
      if (scannerWrapper) scannerWrapper.classList.add('hidden');
    });
  }

  function stopQrScanner() {
    if (html5QrCodeScanner) {
      html5QrCodeScanner.stop().then(() => html5QrCodeScanner.clear()).catch(() => {});
      html5QrCodeScanner = null;
    }
  }

  // ==========================================================================
  // MODAL CONTROLS
  // ==========================================================================

  function openModal(modal, content) {
    if (!modal || !content) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => {
      content.classList.remove('scale-95', 'opacity-0');
      content.classList.add('scale-100', 'opacity-100');
    }, 10);
  }

  function closeModal(modal, content) {
    if (!modal || !content) return;
    content.classList.remove('scale-100', 'opacity-100');
    content.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }, 200);
  }

  // Founder Modal
  const openFounder = () => openModal(founderModal, founderModalContent);
  const closeFounder = () => closeModal(founderModal, founderModalContent);
  if (navFounderBtn) navFounderBtn.onclick = openFounder;
  if (openFounderModalBtn) openFounderModalBtn.onclick = openFounder;
  if (closeFounderModalBtn) closeFounderModalBtn.onclick = closeFounder;
  if (founderModalBackdrop) founderModalBackdrop.onclick = closeFounder;

  // FAQ Modal
  const faqContent = faqModal ? faqModal.querySelector('div.relative') : null;
  const openFaq = () => openModal(faqModal, faqContent);
  const closeFaq = () => closeModal(faqModal, faqContent);
  if (navFaqBtn) navFaqBtn.onclick = openFaq;
  if (closeFaqModalBtn) closeFaqModalBtn.onclick = closeFaq;
  if (faqModalBackdrop) faqModalBackdrop.onclick = closeFaq;

  // Security Modal
  const securityContent = securityModal ? securityModal.querySelector('div.relative') : null;
  const openSecurity = () => openModal(securityModal, securityContent);
  const closeSecurity = () => closeModal(securityModal, securityContent);
  if (navSecurityBtn) navSecurityBtn.onclick = openSecurity;
  if (closeSecurityModalBtn) closeSecurityModalBtn.onclick = closeSecurity;
  if (securityModalBackdrop) securityModalBackdrop.onclick = closeSecurity;

  // Support Email Copy Handlers
  if (modalCopyEmailBtn) {
    modalCopyEmailBtn.onclick = () => {
      copyTextToClipboard('support@directbeam.space', 'Support email copied!');
    };
  }

  const copyEmailDockBtn = document.getElementById('copy-email-dock-btn');
  if (copyEmailDockBtn) {
    copyEmailDockBtn.addEventListener('click', () => {
      copyTextToClipboard('support@directbeam.space', 'Support email copied!');
    });
  }

  // ==========================================================================
  // USAGE GATEKEEPER (3 FREE TRANSFERS LIMIT) & USER AUTHENTICATION
  // ==========================================================================

  const USAGE_CONFIG = {
    FREE_LIMIT: 3,
    STORAGE_KEY_COUNT: 'direct_beam_transfer_count',
    STORAGE_KEY_PRO: 'direct_beam_pro_status',
    STORAGE_KEY_USER: 'direct_beam_auth_user',
    STORAGE_KEY_LEGACY_USER: 'direct_beam_user',
    STORAGE_KEY_TOKEN: 'direct_beam_auth_token'
  };

  // Production Launch Data Purge: Wipe any lingering legacy trial counters & test pro state
  function purgeClientTrialCache() {
    try {
      const launchResetFlag = 'directbeam_launch_clean_2026_10_30_v5_trials';
      if (!localStorage.getItem(launchResetFlag)) {
        const legacyKeys = [
          'directbeam_free_shares',
          'trial_count',
          'directbeam_pro_status',
          'direct_beam_pro',
          'direct_beam_pro_key',
          'direct_beam_pro_status',
          'direct_beam_transfer_count',
          'direct_beam_pro_active',
          'direct_beam_license_key'
        ];
        legacyKeys.forEach(k => localStorage.removeItem(k));
        if (typeof document !== 'undefined' && document.cookie) {
          document.cookie.split(";").forEach(c => {
            const name = c.split("=")[0].trim();
            if (legacyKeys.includes(name)) {
              document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
            }
          });
        }

        // Hard reset any stale Pro attributes or trial counts inside stored user account
        const rawUser = localStorage.getItem(USAGE_CONFIG.STORAGE_KEY_USER);
        if (rawUser) {
          try {
            const userObj = JSON.parse(rawUser);
            userObj.pro = false;
            userObj.isPro = false;
            userObj.plan = 'FREE';
            userObj.transfersCount = 0;
            userObj.freeSharesUsed = 0;
            delete userObj.lemonSqueezyOrderId;
            delete userObj.lemonSqueezyCustomerId;
            delete userObj.proActivatedAt;
            delete userObj.proPaymentId;
            delete userObj.proOrderId;
            delete userObj.licenseKey;
            localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_USER, JSON.stringify(userObj));
          } catch (e) {
            localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_USER);
          }
        }
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_COUNT, '0');
        localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_PRO);
        window.DIRECT_BEAM_PRO = false;
        localStorage.setItem(launchResetFlag, 'true');
      }
    } catch (e) {}
  }
  purgeClientTrialCache();

  function getLoggedInUser() {
    try {
      const raw = localStorage.getItem(USAGE_CONFIG.STORAGE_KEY_USER);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function getTransferCount() {
    const user = getLoggedInUser();
    if (!user || !user.email) return 0;
    // Server database truth always invalidates local counter mismatches
    const serverCount = typeof user.transfersCount === 'number'
      ? user.transfersCount
      : (typeof user.freeSharesUsed === 'number' ? user.freeSharesUsed : 0);
    const localCount = parseInt(localStorage.getItem(USAGE_CONFIG.STORAGE_KEY_COUNT) || '0', 10);
    if (localCount !== serverCount) {
      localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_COUNT, serverCount.toString());
    }
    return serverCount;
  }

  function isProUser() {
    const user = getLoggedInUser();
    // Pro is STRICTLY bound to an active, logged-in user account verified by server truth!
    // Guests or signed-out states are never Pro.
    if (!user || !user.email) return false;
    return Boolean(user.pro === true && user.plan === 'LIFETIME_PRO');
  }

  function canInitiateTransfer() {
    const user = getLoggedInUser();
    if (!user || !user.email) {
      showToast('Account required: Sign in to activate your 3 free transfers.');
      openAuthModal();
      return false;
    }

    if (isProUser()) return true;
    const count = getTransferCount();
    if (count >= USAGE_CONFIG.FREE_LIMIT) {
      showPaywallModal();
      return false;
    }
    return true;
  }

  // Paywall Modal DOM Elements
  const paywallModal = document.getElementById('paywall-modal');
  const paywallModalBackdrop = document.getElementById('paywall-modal-backdrop');
  const paywallModalContent = document.getElementById('paywall-modal-content');
  const btnClosePaywall = document.getElementById('btn-close-paywall');
  const paywallBtnEnterKey = document.getElementById('paywall-btn-enter-key');

  function showPaywallModal() {
    openModal(paywallModal, paywallModalContent);
  }
  function closePaywallModal() {
    closeModal(paywallModal, paywallModalContent);
  }
  window.showPaywallModal = showPaywallModal;
  window.openPaywallModal = showPaywallModal;
  window.closePaywallModal = closePaywallModal;

  if (btnClosePaywall) btnClosePaywall.onclick = closePaywallModal;
  if (paywallModalBackdrop) paywallModalBackdrop.onclick = closePaywallModal;
  if (paywallBtnEnterKey) {
    paywallBtnEnterKey.onclick = () => {
      closePaywallModal();
      setTimeout(openProLicense, 200);
    };
  }

  // Auth Modal DOM Elements
  const authModal = document.getElementById('auth-modal');
  const authModalBackdrop = document.getElementById('auth-modal-backdrop');
  const authModalContent = document.getElementById('auth-modal-content');
  const btnCloseAuth = document.getElementById('btn-close-auth');
  const authLoggedInView = document.getElementById('auth-logged-in-view');
  const authFormView = document.getElementById('auth-form-view');
  const authTabSignin = document.getElementById('auth-tab-signin');
  const authTabSignup = document.getElementById('auth-tab-signup');
  const authForm = document.getElementById('auth-form');
  const authEmailInput = document.getElementById('auth-email-input');
  const authPasswordInput = document.getElementById('auth-password-input');
  const authSubmitBtn = document.getElementById('auth-submit-btn');
  const authSubmitText = document.getElementById('auth-submit-text');
  const authStatusMsg = document.getElementById('auth-status-msg');
  const authProfileEmail = document.getElementById('auth-profile-email');
  const authProfileBadge = document.getElementById('auth-profile-badge');
  const authProfileQuota = document.getElementById('auth-profile-quota');
  const navAuthStatus = document.getElementById('nav-auth-status');
  const navAuthTooltip = document.getElementById('nav-auth-tooltip');
  const headerQuotaPill = document.getElementById('header-quota-pill');
  const quotaUsedCount = document.getElementById('quota-used-count');

  const authGoogleSection = document.getElementById('auth-google-section');
  const authTabsRow = document.getElementById('auth-tabs-row');
  const authResetBanner = document.getElementById('auth-reset-banner');
  const authPasswordWrapper = document.getElementById('auth-password-wrapper');
  const authResetHint = document.getElementById('auth-reset-hint');
  const authSubmitIcon = document.getElementById('auth-submit-icon');

  let currentAuthMode = 'signin';

  function toggleForgotPasswordMode(enable) {
    if (authStatusMsg) {
      authStatusMsg.classList.add('hidden');
      authStatusMsg.innerHTML = '';
    }
    if (enable) {
      currentAuthMode = 'reset';
      if (authGoogleSection) authGoogleSection.classList.add('hidden');
      if (authTabsRow) authTabsRow.classList.add('hidden');
      if (authResetBanner) authResetBanner.classList.remove('hidden');
      if (authPasswordWrapper) authPasswordWrapper.classList.add('hidden');
      if (authResetHint) authResetHint.classList.remove('hidden');
      if (authPasswordInput) {
        authPasswordInput.removeAttribute('required');
        authPasswordInput.value = '';
      }
      if (authSubmitBtn) authSubmitBtn.disabled = false;
      if (authSubmitText) authSubmitText.textContent = 'Send Reset Link';
      if (authSubmitIcon) authSubmitIcon.setAttribute('data-lucide', 'mail');
      if (typeof lucide !== 'undefined') lucide.createIcons();
      if (authEmailInput) setTimeout(() => authEmailInput.focus(), 150);
    } else {
      currentAuthMode = 'signin';
      if (authGoogleSection) authGoogleSection.classList.remove('hidden');
      if (authTabsRow) authTabsRow.classList.remove('hidden');
      if (authResetBanner) authResetBanner.classList.add('hidden');
      if (authPasswordWrapper) authPasswordWrapper.classList.remove('hidden');
      if (authResetHint) authResetHint.classList.add('hidden');
      if (authPasswordInput) {
        authPasswordInput.setAttribute('required', 'required');
        authPasswordInput.placeholder = '••••••••••••';
      }
      if (authTabSignin) {
        authTabSignin.className = 'py-2 text-xs font-mono uppercase font-bold text-white border-b-2 border-cyan-400 cursor-pointer';
      }
      if (authTabSignup) {
        authTabSignup.className = 'py-2 text-xs font-mono uppercase font-bold text-base-700 hover:text-white border-b-2 border-transparent cursor-pointer';
      }
      if (authSubmitBtn) authSubmitBtn.disabled = false;
      if (authSubmitText) authSubmitText.textContent = 'Sign In';
      if (authSubmitIcon) authSubmitIcon.setAttribute('data-lucide', 'log-in');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
  window.toggleForgotPasswordMode = toggleForgotPasswordMode;

  function openAuthModal() {
    const user = getLoggedInUser();
    if (authStatusMsg) authStatusMsg.classList.add('hidden');
    toggleForgotPasswordMode(false);
    if (user && user.email) {
      if (authLoggedInView) authLoggedInView.classList.remove('hidden');
      if (authFormView) authFormView.classList.add('hidden');
    } else {
      if (authLoggedInView) authLoggedInView.classList.add('hidden');
      if (authFormView) authFormView.classList.remove('hidden');
      if (authEmailInput) setTimeout(() => authEmailInput.focus(), 150);
    }
    updateQuotaBadge();
    openModal(authModal, authModalContent);
  }

  function closeAuthModal() {
    closeModal(authModal, authModalContent);
  }

  window.openAuthModal = openAuthModal;
  window.closeAuthModal = closeAuthModal;

  if (btnCloseAuth) btnCloseAuth.onclick = closeAuthModal;
  if (authModalBackdrop) authModalBackdrop.onclick = closeAuthModal;

  if (authTabSignin && authTabSignup) {
    authTabSignin.onclick = () => {
      toggleForgotPasswordMode(false);
      currentAuthMode = 'signin';
      authTabSignin.className = 'py-2 text-xs font-mono uppercase font-bold text-white border-b-2 border-cyan-400 cursor-pointer';
      authTabSignup.className = 'py-2 text-xs font-mono uppercase font-bold text-base-700 hover:text-white border-b-2 border-transparent cursor-pointer';
      if (authSubmitText) authSubmitText.textContent = 'Sign In';
      if (authSubmitIcon) authSubmitIcon.setAttribute('data-lucide', 'log-in');
      if (authStatusMsg) authStatusMsg.classList.add('hidden');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    };

    authTabSignup.onclick = () => {
      toggleForgotPasswordMode(false);
      currentAuthMode = 'signup';
      authTabSignup.className = 'py-2 text-xs font-mono uppercase font-bold text-white border-b-2 border-cyan-400 cursor-pointer';
      authTabSignin.className = 'py-2 text-xs font-mono uppercase font-bold text-base-700 hover:text-white border-b-2 border-transparent cursor-pointer';
      if (authSubmitText) authSubmitText.textContent = 'Create Account';
      if (authSubmitIcon) authSubmitIcon.setAttribute('data-lucide', 'user-plus');
      if (authStatusMsg) authStatusMsg.classList.add('hidden');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    };
  }

  async function handleAuthSubmit() {
    const email = authEmailInput ? authEmailInput.value.trim().toLowerCase() : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (authStatusMsg) {
        authStatusMsg.className = 'text-xs font-mono p-2.5 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
        authStatusMsg.innerHTML = '<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400 shrink-0"></i><span>Please provide a valid email address.</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      return;
    }

    // ============================================================
    // STEP 1: REQUEST SECURE PASSWORD RESET LINK (EMAIL ONLY)
    // ============================================================
    if (currentAuthMode === 'reset') {
      if (authSubmitBtn) authSubmitBtn.disabled = true;
      if (authSubmitText) authSubmitText.textContent = 'Sending Reset Link...';

      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });

        await res.json().catch(() => ({}));

        if (authStatusMsg) {
          authStatusMsg.className = 'text-xs font-mono p-3 border border-emerald-500/50 bg-emerald-950/40 text-emerald-300 block space-y-1.5';
          authStatusMsg.innerHTML = `
            <div class="flex items-center gap-2 font-bold text-emerald-300">
              <i data-lucide="check-circle" class="w-4 h-4 text-emerald-400 shrink-0"></i>
              <span>Reset Link Dispatched</span>
            </div>
            <p class="text-[11px] text-zinc-300 leading-relaxed font-mono">
              If an account exists for <strong class="text-white">${email}</strong>, a secure password reset link has been sent to your inbox.
            </p>
            <p class="text-[10px] text-zinc-400 leading-normal font-mono">
              • Valid for strictly 15 minutes.<br>
              • Check your spam or promotions folder if not seen within 2 minutes.
            </p>
          `;
          if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        if (authSubmitText) authSubmitText.textContent = 'Reset Link Dispatched ✓';
      } catch (err) {
        if (authStatusMsg) {
          authStatusMsg.className = 'text-xs font-mono p-2.5 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
          authStatusMsg.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400 shrink-0"></i><span>Failed to dispatch reset link: ${err.message}</span>`;
          if (typeof lucide !== 'undefined') lucide.createIcons();
        }
        if (authSubmitBtn) authSubmitBtn.disabled = false;
        if (authSubmitText) authSubmitText.textContent = 'Send Reset Link';
      }
      return;
    }

    const password = authPasswordInput ? authPasswordInput.value.trim() : '';
    if (!password) {
      if (authStatusMsg) {
        authStatusMsg.className = 'text-xs font-mono p-2.5 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
        authStatusMsg.innerHTML = '<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400 shrink-0"></i><span>Please enter your password.</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      return;
    }

    if (password.length < 6) {
      if (authStatusMsg) {
        authStatusMsg.className = 'text-xs font-mono p-2.5 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
        authStatusMsg.innerHTML = '<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400 shrink-0"></i><span>Password must be at least 6 characters.</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      return;
    }

    if (authSubmitBtn) authSubmitBtn.disabled = true;
    if (authSubmitText) authSubmitText.textContent = 'Verifying with KV...';

    try {
      const endpoint = currentAuthMode === 'signup' ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Authentication failed. Please verify credentials.');
      }

      if (data.token) {
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_TOKEN, data.token);
      }
      if (data.user) {
        const count = typeof data.user.transfersCount === 'number' ? data.user.transfersCount : 0;
        data.user.transfersCount = count;
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_COUNT, count.toString());
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_USER, JSON.stringify(data.user));

        if (data.user.pro) {
          localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_PRO, 'active');
          window.DIRECT_BEAM_PRO = true;
          updateProUI(true);
        } else {
          localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_PRO);
          window.DIRECT_BEAM_PRO = false;
          updateProUI(false);
        }
      }

      if (authStatusMsg) {
        authStatusMsg.className = 'text-xs font-mono p-2.5 border border-emerald-500/50 bg-emerald-950/40 text-emerald-300 block flex items-center gap-2';
        authStatusMsg.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 text-emerald-400 shrink-0"></i><span>Cloudflare KV: ${currentAuthMode === 'signup' ? 'Account created & session saved!' : 'Signed in successfully!'}</span>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }

      showToast(`Welcome, ${(data.user && data.user.name) || email.split('@')[0]}!`);
      updateQuotaBadge();

      setTimeout(() => {
        closeAuthModal();
        if (authEmailInput) authEmailInput.value = '';
        if (authPasswordInput) authPasswordInput.value = '';
        if (authStatusMsg) authStatusMsg.classList.add('hidden');
      }, 700);

    } catch (err) {
      if (authStatusMsg) {
        authStatusMsg.className = 'text-xs font-mono p-2.5 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
        authStatusMsg.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400 shrink-0"></i><span>${err.message}</span>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    } finally {
      if (authSubmitBtn) authSubmitBtn.disabled = false;
      if (authSubmitText) {
        authSubmitText.textContent = currentAuthMode === 'signup' ? 'Create Account' : 'Sign In';
      }
    }
  }

  async function signOutUser() {
    const token = localStorage.getItem(USAGE_CONFIG.STORAGE_KEY_TOKEN);
    try {
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      }
    } catch (e) {}
    localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_USER);
    localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_LEGACY_USER);
    localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_TOKEN);
    localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_PRO);
    localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_COUNT);
    localStorage.removeItem('direct_beam_transfer_count');
    localStorage.removeItem('direct_beam_pro');
    localStorage.removeItem('direct_beam_pro_status');
    localStorage.removeItem('direct_beam_pro_key');
    window.DIRECT_BEAM_PRO = false;
    updateProUI(false);
    updateQuotaBadge();
    closeAuthModal();
    showToast('Signed out of Direct Beam.');
    setTimeout(() => {
      window.location.reload();
    }, 250);
  }

  function updateQuotaBadge() {
    const isPro = isProUser();
    const count = getTransferCount();
    const user = getLoggedInUser();

    if (quotaUsedCount) {
      quotaUsedCount.textContent = count.toString();
    }

    if (headerQuotaPill) {
      if (isPro) {
        headerQuotaPill.onclick = null;
        headerQuotaPill.innerHTML = '<i data-lucide="sparkles" class="w-3 h-3 text-amber-400"></i><span class="text-amber-300 font-bold">PRO: UNLIMITED</span>';
        headerQuotaPill.className = 'hidden sm:inline-flex db-pill text-[10px] text-amber-300 border-amber-400/50 bg-amber-950/30 font-mono tracking-wider items-center gap-1 shadow-sm';
      } else if (!user || !user.email) {
        headerQuotaPill.onclick = openAuthModal;
        headerQuotaPill.innerHTML = '<i data-lucide="lock" class="w-3 h-3 text-cyan-400"></i><span>3 FREE <strong class="text-white">TRANSFERS</strong> (SIGN IN)</span>';
        headerQuotaPill.className = 'hidden sm:inline-flex db-pill text-[10px] border-cyan-500/40 bg-cyan-950/20 text-cyan-300 font-mono tracking-wider items-center gap-1 shadow-sm cursor-pointer hover:border-cyan-400 transition';
      } else {
        headerQuotaPill.onclick = null;
        const remaining = Math.max(0, USAGE_CONFIG.FREE_LIMIT - count);
        const isExhausted = count >= USAGE_CONFIG.FREE_LIMIT;
        headerQuotaPill.innerHTML = `<i data-lucide="${isExhausted ? 'alert-triangle' : 'gauge'}" class="w-3 h-3 ${isExhausted ? 'text-rose-400' : 'text-cyan-400'}"></i><span>${isExhausted ? '<strong class="text-rose-400">LIMIT (3/3)</strong>' : `FREE: <strong class="${remaining <= 1 ? 'text-amber-400' : 'text-white'}">${count}</strong>/3`}</span>`;
        headerQuotaPill.className = `hidden sm:inline-flex db-pill text-[10px] ${isExhausted ? 'border-rose-500/50 bg-rose-950/30' : 'border-base-800 bg-black/70'} font-mono tracking-wider items-center gap-1 shadow-sm`;
      }
    }

    if (navAuthStatus) {
      if (user && user.email) {
        const emailShort = user.email.split('@')[0];
        navAuthStatus.textContent = isPro ? `⭐ ${emailShort}` : `${emailShort}`;
        navAuthStatus.className = isPro ? 'text-[10px] font-mono text-amber-300 font-bold uppercase tracking-wider truncate block max-w-[70px] sm:max-w-none' : 'text-[10px] font-mono text-cyan-300 font-bold uppercase tracking-wider truncate block max-w-[70px] sm:max-w-none';
      } else {
        navAuthStatus.textContent = isPro ? 'PRO ⚡' : 'Sign In';
        navAuthStatus.className = isPro ? 'text-[10px] font-mono text-amber-300 font-bold uppercase tracking-wider' : 'text-[10px] font-mono text-cyan-300 font-bold uppercase tracking-wider';
      }
    }

    window.toggleMobileQuickMenu = function(force) {
      const menu = document.getElementById('mobile-quick-menu');
      if (!menu) return;
      if (typeof force === 'boolean') {
        menu.classList.toggle('hidden', !force);
      } else {
        menu.classList.toggle('hidden');
      }
    };

    if (navAuthTooltip) {
      if (user && user.email) {
        navAuthTooltip.textContent = `Account: ${user.email} (${isPro ? 'Pro' : `${count}/3 Used`})`;
      } else {
        navAuthTooltip.textContent = isPro ? 'Account: Pro Active' : 'Sign In / Account Access';
      }
    }

    if (authProfileEmail && user) authProfileEmail.textContent = user.email;
    if (authProfileBadge) {
      authProfileBadge.textContent = isPro ? '⭐ DIRECT BEAM PRO LIFETIME (₹300)' : 'FREE TIER (GUEST / DEVICE)';
      authProfileBadge.className = isPro ? 'db-pill text-[10px] text-amber-300 border-amber-400/50 bg-amber-950/40' : 'db-pill text-[10px] text-emerald-400 border-emerald-400/40';
    }
    if (authProfileQuota) {
      authProfileQuota.textContent = isPro ? 'Unlimited P2P Streams' : `${count} / ${USAGE_CONFIG.FREE_LIMIT} Used`;
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function recordSuccessfulTransfer() {
    if (isProUser()) return;
    const current = getTransferCount() + 1;
    localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_COUNT, current.toString());
    
    const user = getLoggedInUser();
    if (user) {
      user.transfersCount = current;
      localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_USER, JSON.stringify(user));
    }
    updateQuotaBadge();

    // Sync to Cloudflare KV database if user is authenticated
    const token = localStorage.getItem(USAGE_CONFIG.STORAGE_KEY_TOKEN);
    if (token) {
      fetch('/api/auth/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ transfersCount: current, pro: isProUser() })
      }).catch(() => {});
    }
    
    if (current >= USAGE_CONFIG.FREE_LIMIT) {
      setTimeout(showPaywallModal, 1000);
    }
  }

  async function syncUserSession() {
    const token = localStorage.getItem(USAGE_CONFIG.STORAGE_KEY_TOKEN);
    if (!token) {
      updateQuotaBadge();
      return;
    }

    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.user) {
          const userCount = typeof data.user.transfersCount === 'number' ? data.user.transfersCount : 0;
          data.user.transfersCount = userCount;
          localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_COUNT, userCount.toString());
          localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_USER, JSON.stringify(data.user));

          if (data.user.pro) {
            localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_PRO, 'active');
            window.DIRECT_BEAM_PRO = true;
            updateProUI(true);
          } else {
            localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_PRO);
            localStorage.removeItem('direct_beam_pro');
            localStorage.removeItem('direct_beam_pro_status');
            localStorage.removeItem('direct_beam_pro_key');
            window.DIRECT_BEAM_PRO = false;
            updateProUI(false);
          }
        }
      } else if (res.status === 401) {
        localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_TOKEN);
        localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_USER);
        localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_PRO);
        localStorage.removeItem('direct_beam_pro');
        localStorage.removeItem('direct_beam_pro_status');
        localStorage.removeItem('direct_beam_pro_key');
        window.DIRECT_BEAM_PRO = false;
        updateProUI(false);
      }
    } catch (err) {
      console.warn('[DirectBeam] Session sync fallback:', err);
    } finally {
      updateQuotaBadge();
    }
  }

  // ==========================================
  // REAL GOOGLE OAUTH (Google Identity Services)
  // ==========================================
  const GOOGLE_CLIENT_ID = "464572597917-bj2jf591tfhc4lvqcqr0pn5q9sgps4d5.apps.googleusercontent.com";

  function initGoogleSignIn() {
    if (typeof google === 'undefined' || !google.accounts) {
      setTimeout(initGoogleSignIn, 300);
      return;
    }
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
      context: 'signin'
    });
  }

  function triggerGoogleSignIn() {
    if (typeof google === 'undefined' || !google.accounts) {
      if (authStatusMsg) {
        authStatusMsg.className = 'text-xs font-mono p-2.5 border border-cyan-500/50 bg-cyan-950/40 text-cyan-300 block';
        authStatusMsg.textContent = 'Google Sign-In is initializing... please try again in a second.';
      }
      return;
    }

    const loadingEl = document.getElementById('modal-google-loading');
    const btn = document.getElementById('modal-btn-google-login');
    const btnText = document.getElementById('modal-google-btn-text');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Connecting...';

    google.accounts.id.prompt((notification) => {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = 'Continue with Google';

      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        // Fall back to popup button click if One Tap is blocked or dismissed
        showGooglePopup();
      }
    });
  }

  function showGooglePopup() {
    const tempDiv = document.createElement('div');
    tempDiv.style.display = 'none';
    document.body.appendChild(tempDiv);
    google.accounts.id.renderButton(tempDiv, {
      type: 'standard',
      theme: 'filled_blue',
      size: 'large'
    });
    const innerBtn = tempDiv.querySelector('div[role=button]') || tempDiv.querySelector('button');
    if (innerBtn) innerBtn.click();
    setTimeout(() => {
      if (document.body.contains(tempDiv)) document.body.removeChild(tempDiv);
    }, 2000);
  }

  async function handleGoogleCredential(response) {
    const loadingEl = document.getElementById('modal-google-loading');
    const btn = document.getElementById('modal-btn-google-login');
    const btnText = document.getElementById('modal-google-btn-text');

    if (loadingEl) loadingEl.classList.remove('hidden');
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Verifying with Google...';

    if (authStatusMsg) {
      authStatusMsg.className = 'text-xs font-mono p-2.5 border border-cyan-500/50 bg-cyan-950/40 text-cyan-300 block flex items-center gap-2';
      authStatusMsg.innerHTML = `<span class="inline-flex items-center gap-2"><svg class="animate-spin w-3.5 h-3.5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg><span>Verifying Google token with Cloudflare KV...</span></span>`;
    }

    try {
      const res = await fetch('/api/auth/google/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Google authentication failed.');
      }

      if (data.token) {
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_TOKEN, data.token);
      }
      if (data.user) {
        const remoteCount = typeof data.user.transfersCount === 'number' ? data.user.transfersCount : 0;
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_COUNT, remoteCount.toString());
        data.user.transfersCount = remoteCount;
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_USER, JSON.stringify(data.user));

        if (data.user.pro) {
          localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_PRO, 'active');
          window.DIRECT_BEAM_PRO = true;
          updateProUI(true);
        }
      }

      if (authStatusMsg) {
        authStatusMsg.className = 'text-xs font-mono p-2.5 border border-emerald-500/50 bg-emerald-950/40 text-emerald-300 block flex items-center gap-2';
        authStatusMsg.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 text-emerald-400 shrink-0"></i><span>Google account verified and session saved!</span>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }

      showToast(`Welcome, ${(data.user && data.user.name) || 'Direct Beam User'}!`);
      updateQuotaBadge();

      setTimeout(() => {
        closeAuthModal();
        if (authStatusMsg) authStatusMsg.classList.add('hidden');
      }, 700);

    } catch (err) {
      if (authStatusMsg) {
        authStatusMsg.className = 'text-xs font-mono p-2.5 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
        authStatusMsg.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400 shrink-0"></i><span>${err.message}</span>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    } finally {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = 'Continue with Google';
    }
  }

  // Cloudflare Access Zero Trust Auto-Detection
  async function checkCloudflareAccessSSO() {
    try {
      const res = await fetch('/api/auth/cloudflare-access');
      const data = await res.json();
      if (data && data.active && data.token && data.user) {
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_TOKEN, data.token);
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_USER, JSON.stringify(data.user));
        if (data.user.pro) {
          localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_PRO, 'active');
          window.DIRECT_BEAM_PRO = true;
          updateProUI(true);
        }
        updateQuotaBadge();
      }
    } catch (e) {}
  }

  // Auto-init Google Sign In
  if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initGoogleSignIn);
    } else {
      initGoogleSignIn();
    }
  }

  window.syncUserSession = syncUserSession;
  window.handleAuthSubmit = handleAuthSubmit;
  window.triggerGoogleSignIn = triggerGoogleSignIn;
  window.initGoogleSignIn = initGoogleSignIn;
  window.checkCloudflareAccessSSO = checkCloudflareAccessSSO;
  window.signOutUser = signOutUser;
  window.canInitiateTransfer = canInitiateTransfer;
  window.getTransferCount = getTransferCount;
  window.recordSuccessfulTransfer = recordSuccessfulTransfer;
  window.updateQuotaBadge = updateQuotaBadge;

  // Run SSO check on start
  checkCloudflareAccessSSO();

  // Initialize Lemon Squeezy Overlay SDK if present
  if (typeof window.createLemonSqueezy === 'function') {
    try { window.createLemonSqueezy(); } catch (e) {}
  }
  if (window.LemonSqueezy && typeof window.LemonSqueezy.Setup === 'function') {
    try {
      window.LemonSqueezy.Setup({
        eventHandler: (event) => {
          if (event && (event.event === 'Checkout.Success' || event.event === 'Order.Created')) {
            showToast('⚡ Payment Successful! Upgrading to Direct Beam Pro Lifetime...');
            setTimeout(() => {
              window.location.reload();
            }, 1500);
          }
        }
      });
    } catch (e) {}
  }

  // Handle redirect return from Lemon Squeezy hosted checkout
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('payment') === 'success' || urlParams.get('payment_success') === 'true') {
      showToast('⚡ Welcome to Direct Beam Pro Lifetime! Your upgrade is active.');
      localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_PRO, 'active');
      localStorage.setItem('direct_beam_pro_status', 'active');
      window.DIRECT_BEAM_PRO = true;
      updateProUI(true);
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  } catch (e) {}

  // ==========================================================================
  // PRO LICENSE KEY & LEMON SQUEEZY ACTIVATION CONTROLLER
  // ==========================================================================

  const proContent = proLicenseModalContent || (proLicenseModal ? proLicenseModal.querySelector('div#pro-license-modal-content') || proLicenseModal.querySelector('div.relative') : null);
  const openProLicense = () => {
    if (licenseStatusMsg) licenseStatusMsg.classList.add('hidden');
    openModal(proLicenseModal, proContent);
    if (licenseKeyInput) setTimeout(() => licenseKeyInput.focus(), 150);
  };
  const closeProLicense = () => closeModal(proLicenseModal, proContent);

  window.openProLicense = openProLicense;
  window.closeProLicense = closeProLicense;

  if (btnOpenLicenseModal) btnOpenLicenseModal.onclick = openProLicense;
  if (footerEnterKeyBtn) footerEnterKeyBtn.onclick = openProLicense;
  if (btnCloseModal) btnCloseModal.onclick = closeProLicense;
  if (proLicenseModalBackdrop) proLicenseModalBackdrop.onclick = closeProLicense;

  function updateProUI(isPro) {
    if (isPro) {
      if (proBadgeHeader) {
        proBadgeHeader.classList.remove('hidden');
        proBadgeHeader.classList.add('inline-flex');
      }
      if (proNavCta) proNavCta.classList.add('hidden');
      if (proActiveCta) {
        proActiveCta.classList.remove('hidden');
        proActiveCta.classList.add('flex');
      }
      if (footerEnterKeyBtn) {
        footerEnterKeyBtn.innerHTML = '<span class="text-amber-300 font-bold">⭐ Direct Beam Pro Active</span>';
        footerEnterKeyBtn.onclick = () => {
          showToast('Direct Beam Pro is active on this browser.');
        };
      }
      if (window.updateBeamTelemetry) {
        window.updateBeamTelemetry({ status: 'PRO ACTIVE' });
      }
    } else {
      if (proBadgeHeader) {
        proBadgeHeader.classList.add('hidden');
        proBadgeHeader.classList.remove('inline-flex');
      }
      if (proNavCta) proNavCta.classList.remove('hidden');
      if (proActiveCta) {
        proActiveCta.classList.add('hidden');
        proActiveCta.classList.remove('flex');
      }
      if (footerEnterKeyBtn) {
        footerEnterKeyBtn.textContent = 'Already have a license? Enter Key';
        footerEnterKeyBtn.onclick = openProLicense;
      }
    }
    updateQuotaBadge();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function checkProStatus() {
    const isPro = isProUser();
    window.DIRECT_BEAM_PRO = isPro;
    updateProUI(isPro);
    return isPro;
  }

  // Lemon Squeezy Checkout (Live Mode, Hosted / Overlay)
  async function startProCheckout(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const user = getLoggedInUser();
    const token = localStorage.getItem(USAGE_CONFIG.STORAGE_KEY_TOKEN);

    if (!user || !user.email || !token) {
      showToast('Please sign in first so your Pro upgrade is activated immediately!');
      openAuthModal();
      return;
    }

    if (isProUser()) {
      showToast('⭐ Direct Beam Pro is already active on this account!');
      return;
    }

    showToast('Initializing secure Lemon Squeezy checkout...');

    try {
      // 1. Create Checkout Session on Server
      const res = await fetch('/api/payments/create-checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ plan: 'pro_lifetime' })
      });

      const data = await res.json();
      if (!res.ok || !data.success || !data.checkoutUrl) {
        throw new Error(data.error || 'Failed to initialize Lemon Squeezy checkout');
      }

      const checkoutUrl = data.checkoutUrl;

      // 2. Direct redirect to Lemon Squeezy secure hosted checkout
      // Direct navigation prevents browser iframe sandbox, CSP frame, and third-party cookie blocks
      window.location.href = checkoutUrl;
    } catch (err) {
      console.error('[Lemon Squeezy Checkout Error]:', err);
      showToast(err.message || 'Could not launch payment gateway. Please try again.');
    }
  }

  // Single-Use User-Bound Payment ID / License Key Activation
  async function verifyAndActivateLicenseKey(rawKey) {
    const key = (rawKey || '').trim();
    if (!key) {
      if (licenseStatusMsg) {
        licenseStatusMsg.className = 'text-xs font-mono p-3 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
        licenseStatusMsg.innerHTML = '<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400 shrink-0"></i><span>Please enter a payment ID or license key.</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      return;
    }

    const user = getLoggedInUser();
    const token = localStorage.getItem(USAGE_CONFIG.STORAGE_KEY_TOKEN);
    if (!user || !token) {
      showToast('Please sign in to your account first before activating a license.');
      openAuthModal();
      return;
    }

    if (btnVerifyLicense) {
      btnVerifyLicense.disabled = true;
      btnVerifyLicense.classList.add('opacity-70', 'cursor-not-allowed');
    }
    if (btnVerifyLicenseText) {
      btnVerifyLicenseText.innerHTML = '<span class="inline-flex items-center gap-2"><svg class="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> Validating Key...</span>';
    }
    if (licenseStatusMsg) {
      licenseStatusMsg.classList.add('hidden');
    }

    try {
      const response = await fetch('/api/auth/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ license_key: key })
      });

      const data = await response.json();

      if (response.ok && data && data.success) {
        if (data.user) {
          localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_USER, JSON.stringify(data.user));
        }
        localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_PRO, 'active');
        localStorage.setItem('direct_beam_pro_key', key);
        localStorage.setItem('direct_beam_pro_status', 'active');

        window.DIRECT_BEAM_PRO = true;
        updateProUI(true);
        updateQuotaBadge();

        if (licenseStatusMsg) {
          licenseStatusMsg.className = 'text-xs font-mono p-3 border border-emerald-500/50 bg-emerald-950/40 text-emerald-300 block flex items-center gap-2';
          licenseStatusMsg.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 text-emerald-400 shrink-0"></i><span>${data.message || 'License activated! Direct Beam Pro unlocked.'}</span>`;
          if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        showToast('⭐ Pro Activated for ' + user.email + '!');

        setTimeout(() => {
          closeProLicense();
          if (licenseKeyInput) licenseKeyInput.value = '';
          if (licenseStatusMsg) licenseStatusMsg.classList.add('hidden');
        }, 1400);
      } else {
        const errorMsg = (data && data.error) ? data.error : 'License key is invalid or has already been used.';
        if (licenseStatusMsg) {
          licenseStatusMsg.className = 'text-xs font-mono p-3 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
          licenseStatusMsg.innerHTML = `<i data-lucide="alert-triangle" class="w-4 h-4 text-rose-400 shrink-0"></i><span>${errorMsg}</span>`;
          if (typeof lucide !== 'undefined') lucide.createIcons();
        }
        showToast(errorMsg);
      }
    } catch (err) {
      console.error('License validation network error:', err);
      if (licenseStatusMsg) {
        licenseStatusMsg.className = 'text-xs font-mono p-3 border border-rose-500/50 bg-rose-950/40 text-rose-300 block flex items-center gap-2';
        licenseStatusMsg.innerHTML = '<i data-lucide="wifi-off" class="w-4 h-4 text-rose-400 shrink-0"></i><span>Network error reaching license server. Please verify your connection.</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      showToast('Network error during license activation.');
    } finally {
      if (btnVerifyLicense) {
        btnVerifyLicense.disabled = false;
        btnVerifyLicense.classList.remove('opacity-70', 'cursor-not-allowed');
      }
      if (btnVerifyLicenseText) {
        btnVerifyLicenseText.textContent = 'Activate License Key';
      }
    }
  }

  async function deactivateProKey() {
    if (!confirm('Are you sure you want to deactivate your Direct Beam Pro license on this device?')) {
      return;
    }

    localStorage.removeItem('direct_beam_pro_key');
    localStorage.removeItem('direct_beam_pro_status');
    localStorage.removeItem(USAGE_CONFIG.STORAGE_KEY_PRO);

    const user = getLoggedInUser();
    if (user) {
      user.pro = false;
      localStorage.setItem(USAGE_CONFIG.STORAGE_KEY_USER, JSON.stringify(user));
    }

    window.DIRECT_BEAM_PRO = false;
    updateProUI(false);
    updateQuotaBadge();
    showToast('Direct Beam Pro license deactivated on this browser.');
  }

  // Expose Pro helpers globally on window
  window.openProLicense = openProLicense;
  window.closeProLicense = closeProLicense;
  window.checkProStatus = checkProStatus;
  window.verifyAndActivateLicenseKey = verifyAndActivateLicenseKey;
  window.deactivateProKey = deactivateProKey;
  window.startProCheckout = startProCheckout;

  if (btnVerifyLicense) {
    btnVerifyLicense.onclick = () => {
      const key = licenseKeyInput ? licenseKeyInput.value : '';
      verifyAndActivateLicenseKey(key);
    };
  }

  if (licenseKeyInput) {
    licenseKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const key = licenseKeyInput.value;
        verifyAndActivateLicenseKey(key);
      }
    });
  }

  if (btnDeactivatePro) {
    btnDeactivatePro.onclick = deactivateProKey;
  }

  const btnUpgradePro = document.getElementById('btn-upgrade-pro');
  if (btnUpgradePro) {
    btnUpgradePro.addEventListener('click', startProCheckout);
  }

  const btnPricingCheckout = document.getElementById('btn-pricing-checkout');
  if (btnPricingCheckout) {
    btnPricingCheckout.addEventListener('click', startProCheckout);
  }

  const btnPaywallUpgrade = document.getElementById('btn-paywall-upgrade');
  if (btnPaywallUpgrade) {
    btnPaywallUpgrade.addEventListener('click', startProCheckout);
  }

  // ==========================================================================
  // QUICK BEAM INTERACTION CONTROLLERS
  // ==========================================================================

  // Tab Switcher (Files vs Quick Beam Text)
  if (tabFiles && tabText && dropZone && quickBeamContainer) {
    tabFiles.onclick = () => {
      tabFiles.classList.add('border-white', 'bg-white', 'text-black', 'shadow-sm');
      tabFiles.classList.remove('border-base-900', 'bg-black/60', 'text-base-700');
      tabFiles.setAttribute('aria-selected', 'true');

      tabText.classList.remove('border-white', 'bg-white', 'text-black', 'shadow-sm');
      tabText.classList.add('border-base-900', 'bg-black/60', 'text-base-700');
      tabText.setAttribute('aria-selected', 'false');

      dropZone.classList.remove('hidden');
      quickBeamContainer.classList.add('hidden');
    };

    tabText.onclick = () => {
      tabText.classList.add('border-white', 'bg-white', 'text-black', 'shadow-sm');
      tabText.classList.remove('border-base-900', 'bg-black/60', 'text-base-700');
      tabText.setAttribute('aria-selected', 'true');

      tabFiles.classList.remove('border-white', 'bg-white', 'text-black', 'shadow-sm');
      tabFiles.classList.add('border-base-900', 'bg-black/60', 'text-base-700');
      tabFiles.setAttribute('aria-selected', 'false');

      dropZone.classList.add('hidden');
      quickBeamContainer.classList.remove('hidden');
      if (quickBeamInput) quickBeamInput.focus();
    };
  }

  // Live Input Character & Word Counting
  if (quickBeamInput) {
    quickBeamInput.addEventListener('input', () => {
      const text = quickBeamInput.value;
      const len = text.length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;

      if (quickBeamCharCount) quickBeamCharCount.textContent = len.toLocaleString();
      if (quickBeamWordCount) quickBeamWordCount.textContent = words.toLocaleString();

      if (len > 0) {
        if (btnSendText) {
          btnSendText.disabled = false;
          btnSendText.classList.remove('opacity-60', 'cursor-not-allowed');
        }
        if (quickBeamClearBtn) quickBeamClearBtn.classList.remove('hidden');
      } else {
        if (btnSendText) {
          btnSendText.disabled = true;
          btnSendText.classList.add('opacity-60', 'cursor-not-allowed');
        }
        if (quickBeamClearBtn) quickBeamClearBtn.classList.add('hidden');
      }
    });
  }

  // Clear Input
  if (quickBeamClearBtn && quickBeamInput) {
    quickBeamClearBtn.onclick = () => {
      quickBeamInput.value = '';
      quickBeamInput.dispatchEvent(new Event('input'));
      quickBeamInput.focus();
    };
  }

  // Self Destruct Toggle
  if (quickBeamSelfDestructToggle && quickBeamTimerWrapper) {
    quickBeamSelfDestructToggle.addEventListener('change', () => {
      if (quickBeamSelfDestructToggle.checked) {
        quickBeamTimerWrapper.classList.remove('hidden');
        quickBeamTimerWrapper.classList.add('flex');
      } else {
        quickBeamTimerWrapper.classList.add('hidden');
        quickBeamTimerWrapper.classList.remove('flex');
      }
    });
  }

  // Beam Text Action (Selection View)
  if (btnSendText) {
    btnSendText.onclick = () => {
      const text = quickBeamInput ? quickBeamInput.value.trim() : '';
      if (!text) {
        showToast('Please enter text to beam.');
        return;
      }

      if (!canInitiateTransfer()) {
        showPaywallModal();
        return;
      }

      const isSelfDestruct = quickBeamSelfDestructToggle ? quickBeamSelfDestructToggle.checked : false;
      const duration = quickBeamTimerSelect ? parseInt(quickBeamTimerSelect.value, 10) : 30;

      pendingQuickBeamText = {
        text: text,
        selfDestruct: {
          enabled: isSelfDestruct,
          durationSeconds: duration
        }
      };
      selectedFiles = [];

      // If already connected to peer, send immediately
      if (peerConnections.size > 0) {
        const success = sendQuickBeamText(text, pendingQuickBeamText.selfDestruct);
        if (success) {
          pendingQuickBeamText = null;
          quickBeamInput.value = '';
          quickBeamInput.dispatchEvent(new Event('input'));
        }
        return;
      }

      // Initialize room on signaling server
      initSocket();
      if (socket && socket.connected) {
        socket.emit('create-room');
      } else if (socket) {
        showToast('Connecting to signaling server...');
        socket.once('connect', () => {
          socket.emit('create-room');
        });
      }
    };
  }

  // Sender In-Session Quick Beam Toggle
  if (toggleSenderTextBtn && senderTextComposer) {
    toggleSenderTextBtn.onclick = () => {
      senderTextComposer.classList.toggle('hidden');
      const isHidden = senderTextComposer.classList.contains('hidden');
      if (senderTextToggleLabel) senderTextToggleLabel.textContent = isHidden ? 'Compose' : 'Hide';
      if (senderTextToggleIcon) senderTextToggleIcon.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
    };
  }

  // Sender In-Session Send Button
  if (senderBtnSendText && senderQuickBeamInput) {
    senderBtnSendText.onclick = () => {
      const text = senderQuickBeamInput.value.trim();
      if (!text) {
        showToast('Enter text to beam.');
        return;
      }
      const isSelfDestruct = senderSelfDestructToggle ? senderSelfDestructToggle.checked : false;
      const success = sendQuickBeamText(text, { enabled: isSelfDestruct, durationSeconds: 30 });
      if (success) {
        senderQuickBeamInput.value = '';
      }
    };
  }

  // Initialize Signaling Socket on load for instant readiness
  window.addEventListener('DOMContentLoaded', async () => {
    purgeClientTrialCache();
    initSocket();
    await syncUserSession();
    checkProStatus();
    updateQuotaBadge();

    const params = new URLSearchParams(window.location.search);
    if (params.get('forgot') || params.get('reset')) {
      setTimeout(() => {
        openAuthModal();
        toggleForgotPasswordMode(true);
      }, 300);
    } else if (params.get('login') || params.get('auth')) {
      setTimeout(openAuthModal, 300);
    }
    const code = params.get('code');
    if (code && code.length >= 6) {
      if (manualCodeInput) manualCodeInput.value = code;
      joinRoomByCode(code);
    }
  });

})();