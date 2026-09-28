/* ============================================================================
   DIRECT BEAM — HIGH-PERFORMANCE WEBRTC P2P ENGINE (COMPLETE APP CONTROLLER)
   ============================================================================ */

(() => {
  'use strict';

  // --- Configuration Constants ---
  const CHUNK_SIZE = 256 * 1024; // 256 KB per frame
  const BUFFER_CEILING = 8 * 1024 * 1024; // 8 MB buffer threshold
  const BUFFER_FLOOR = 1024 * 1024; // 1 MB resumption threshold

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };

  // --- State Variables ---
  let socket = null;
  let currentRoomId = null;
  let isSender = false;
  let selectedFiles = []; // File objects
  let peerConnections = new Map(); // peerId -> { pc, dc, activeTransfer: bool }
  let receiverChannelManager = null;
  let html5QrCodeScanner = null;
  let currentFacingMode = 'environment';
  let receivedFilesArchive = []; // { name, blob, size }

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

  // Dock / Social
  const copyEmailDockBtn = document.getElementById('copy-email-dock-btn');
  const modalCopyEmailBtn = document.getElementById('modal-copy-email-btn');

  // Share buttons
  const shareWa = document.getElementById('share-wa');
  const shareFb = document.getElementById('share-fb');
  const shareX = document.getElementById('share-x');
  const shareLi = document.getElementById('share-li');
  const shareGmail = document.getElementById('share-gmail');
  const shareEmail = document.getElementById('share-email');
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
  // SOCKET.IO SIGNALING
  // ==========================================================================

  function initSocket() {
    if (socket) return;

    const coldStartTimer = setTimeout(() => {
      if (coldStartBanner) coldStartBanner.classList.remove('hidden');
    }, 2500);

    socket = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    socket.on('connect', () => {
      clearTimeout(coldStartTimer);
      if (coldStartBanner) coldStartBanner.classList.add('hidden');
      console.log('Connected to signaling server with ID:', socket.id);
    });

    socket.on('room-created', ({ roomCode }) => {
      currentRoomId = roomCode;
      isSender = true;
      setupSenderRoomUI(roomCode);
      switchView('sender');
    });

    socket.on('room-joined', ({ roomCode }) => {
      currentRoomId = roomCode;
      isSender = false;
      switchView('receiver');
      if (receiverBatchSubtitle) receiverBatchSubtitle.textContent = 'Signaling connected. Awaiting sender handshake...';
    });

    socket.on('peer-joined', async ({ peerId }) => {
      if (isSender) {
        logSenderActivity(`New peer (${peerId.slice(0, 5)}) joined room`);
        await createSenderPeerConnection(peerId);
        updatePeerCountUI();
      }
    });

    socket.on('peer-disconnected', ({ peerId }) => {
      if (peerConnections.has(peerId)) {
        const { pc, dc } = peerConnections.get(peerId);
        try { if (dc) dc.close(); } catch (e) {}
        try { if (pc) pc.close(); } catch (e) {}
        peerConnections.delete(peerId);
        updatePeerCountUI();
        logSenderActivity(`Peer (${peerId.slice(0, 5)}) disconnected`);
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
        // Receiver handling signal from Sender
        await handleReceiverSignal(senderId, data);
      }
    });

    socket.on('error-msg', (msg) => {
      showToast(msg);
      resetToHome();
    });
  }

  // ==========================================================================
  // SENDER ENGINE (256 KB Chunking & Flow Control)
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
    row.className = 'text-[11px] text-slate-300 flex items-center justify-between border-b border-slate-900 pb-1';
    row.innerHTML = `<span>${msg}</span><span class="text-slate-500 font-mono">${new Date().toLocaleTimeString()}</span>`;
    receiversActivityFeed.prepend(row);
  }

  function setupSenderRoomUI(code) {
    displayCode.textContent = code;

    // Render QR Code
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

    // Manifest Drawer
    const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    queueSummaryCount.textContent = `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}`;
    queueSummarySize.textContent = formatBytes(totalBytes);

    senderQueueList.innerHTML = '';
    selectedFiles.forEach((f, idx) => {
      const li = document.createElement('li');
      li.className = 'flex justify-between items-center py-1 border-b border-slate-800/40';
      li.innerHTML = `<span class="truncate max-w-[220px]">${f.name}</span><span class="font-mono text-slate-400 text-[10px]">${formatBytes(f.size)}</span>`;
      senderQueueList.appendChild(li);
    });

    // Dynamic Social Share URLs
    const encodedUrl = encodeURIComponent(shareUrl);
    const encodedText = encodeURIComponent(`Download ${selectedFiles.length} file(s) via Direct Beam P2P: ${shareUrl}`);

    shareWa.onclick = () => window.open(`https://api.whatsapp.com/send?text=${encodedText}`, '_blank');
    shareFb.onclick = () => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`, '_blank');
    shareX.onclick = () => window.open(`https://twitter.com/intent/tweet?text=${encodedText}`, '_blank');
    shareLi.onclick = () => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`, '_blank');
    shareGmail.onclick = () => window.open(`https://mail.google.com/mail/?view=cm&fs=1&su=Direct+Beam+Files&body=${encodedText}`, '_blank');
    shareEmail.onclick = () => window.location.href = `mailto:?subject=Direct Beam Transfer&body=${encodedText}`;
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

  async function createSenderPeerConnection(peerId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    
    // Explicit DataChannel initialization with binaryType arraybuffer
    const dc = pc.createDataChannel('fileStream', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_FLOOR;

    const peerObj = { pc, dc, isTransferring: false, readyToReceive: false };
    peerConnections.set(peerId, peerObj);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', { targetId: peerId, data: { candidate: event.candidate } });
      }
    };

    dc.onopen = () => {
      logSenderActivity(`DataChannel opened with peer (${peerId.slice(0, 5)})`);
      startBatchStreamToPeer(peerId);
    };

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ready') {
            peerObj.readyToReceive = true;
          }
        } catch (e) {}
      }
    };

    dc.onerror = (err) => console.error('DataChannel error on sender:', err);
    dc.onclose = () => logSenderActivity(`DataChannel closed with peer (${peerId.slice(0, 5)})`);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { targetId: peerId, data: { sdp: pc.localDescription } });
  }

  async function startBatchStreamToPeer(peerId) {
    const peer = peerConnections.get(peerId);
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') return;
    if (peer.isTransferring) return;

    peer.isTransferring = true;

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const fileId = `file_${i}_${Date.now()}`;
      logSenderActivity(`Sending: ${file.name} to (${peerId.slice(0, 5)})`);

      await streamSingleFile(peer.dc, file, fileId, (prog) => {
        // Can optionally log per-file progress
      });
    }

    // Inform peer the entire batch is completed
    peer.dc.send(JSON.stringify({ type: 'batch-complete' }));
    logSenderActivity(`Finished streaming batch to (${peerId.slice(0, 5)})`);
    peer.isTransferring = false;
  }

  async function streamSingleFile(dc, file, fileId, onProgress) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 1. Send Manifest
    const manifest = {
      type: 'manifest',
      fileId: fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks: totalChunks
    };
    dc.send(JSON.stringify(manifest));

    // 2. Stream Binary Chunks with Reactive Backpressure
    let offset = 0;
    let chunkIndex = 0;

    while (offset < file.size) {
      if (dc.bufferedAmount > BUFFER_CEILING) {
        await new Promise((resolve) => {
          dc.onbufferedamountlow = () => {
            dc.onbufferedamountlow = null;
            resolve();
          };
        });
      }

      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const slice = file.slice(offset, end);
      const buffer = await slice.arrayBuffer();

      dc.send(buffer);

      offset += buffer.byteLength;
      chunkIndex++;

      if (onProgress) {
        onProgress({
          fileId,
          bytesSent: offset,
          totalBytes: file.size,
          progress: offset / file.size
        });
      }
    }

    // 3. Send EOF delimiter
    dc.send(JSON.stringify({ type: 'eof', fileId: fileId, name: file.name }));
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
    let totalBatchBytes = 0;
    let cumulativeBatchReceived = 0;

    if (receiverBatchSubtitle) receiverBatchSubtitle.textContent = 'Direct P2P Link Established. Streaming...';

    dc.onmessage = (event) => {
      // 1. Control Packet (JSON String)
      if (typeof event.data === 'string') {
        try {
          const payload = JSON.parse(event.data);

          if (payload.type === 'manifest') {
            currentManifest = payload;
            receivedBytes = 0;
            receivedChunks = [];
            startTime = performance.now();

            renderReceiverManifestItem(payload);
            dc.send(JSON.stringify({ type: 'ready', fileId: payload.fileId }));
          } else if (payload.type === 'eof') {
            if (currentManifest && currentManifest.fileId === payload.fileId) {
              const fileBlob = new Blob(receivedChunks, {
                type: currentManifest.mimeType || 'application/octet-stream'
              });

              receivedFilesArchive.push({
                name: currentManifest.name,
                blob: fileBlob,
                size: currentManifest.size
              });

              markReceiverManifestItemDone(currentManifest.fileId, fileBlob);

              // Auto-trigger single file download
              triggerDownload(fileBlob, currentManifest.name);

              cumulativeBatchReceived += currentManifest.size;
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
          }
        } catch (e) {
          console.error('Failed to parse incoming control message', e);
        }
        return;
      }

      // 2. Binary Chunk (ArrayBuffer)
      if (event.data instanceof ArrayBuffer) {
        if (!currentManifest) return;

        receivedChunks.push(event.data);
        receivedBytes += event.data.byteLength;

        const fileProg = Math.min(receivedBytes / currentManifest.size, 1.0);
        const elapsedSec = (performance.now() - startTime) / 1000;
        const bps = elapsedSec > 0 ? (receivedBytes / elapsedSec) : 0;
        const mbps = (bps / (1024 * 1024)).toFixed(2);
        const remainingBytes = currentManifest.size - receivedBytes;
        const etaSeconds = bps > 0 ? remainingBytes / bps : 0;

        // UI Updates
        if (receiverProgressBar) receiverProgressBar.style.width = `${(fileProg * 100).toFixed(1)}%`;
        if (receiverPercentage) receiverPercentage.textContent = `${(fileProg * 100).toFixed(1)}%`;
        if (receiverSpeedText) receiverSpeedText.textContent = `${mbps} MB/s`;
        if (receiverEtaText) receiverEtaText.textContent = formatEta(etaSeconds);

        updateReceiverManifestItemProgress(currentManifest.fileId, fileProg);
      }
    };

    dc.onerror = (e) => console.error('Receiver channel error:', e);
    dc.onclose = () => {
      if (receiverBatchSubtitle) receiverBatchSubtitle.textContent = 'Host disconnected or transfer terminated.';
    };
  }

  function renderReceiverManifestItem(manifest) {
    if (!receiverManifestList) return;
    const li = document.createElement('li');
    li.id = `item-${manifest.fileId}`;
    li.className = 'bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/80 flex items-center justify-between';
    li.innerHTML = `
      <div class="flex-1 min-w-0 mr-3">
        <span class="truncate block text-white font-medium text-xs">${manifest.name}</span>
        <span class="text-[10px] text-slate-400 font-mono">${formatBytes(manifest.size)}</span>
        <div class="w-full bg-slate-950 h-1 rounded-full mt-1.5 overflow-hidden">
          <div class="item-progress bg-cyan-400 h-full w-0 transition-all"></div>
        </div>
      </div>
      <div class="item-action">
        <span class="text-[10px] text-cyan-400 font-mono animate-pulse">Streaming...</span>
      </div>
    `;
    receiverManifestList.appendChild(li);
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
        <a href="${url}" download="${item.querySelector('.text-white').textContent}" class="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-1 rounded-md font-semibold hover:bg-emerald-500/30 flex items-center gap-1 transition">
          <i data-lucide="download" class="w-3 h-3"></i> Save
        </a>
      `;
      lucide.createIcons();
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
  // EVENT LISTENERS & UI WIRING
  // ==========================================================================

  // Drag & Drop
  if (dropZone) {
    dropZone.onclick = () => fileInput.click();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('border-cyan-500'); };
    dropZone.ondragleave = () => dropZone.classList.remove('border-cyan-500');
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-cyan-500');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFilesSelected(Array.from(e.dataTransfer.files));
      }
    };
  }

  if (fileInput) {
    fileInput.onchange = (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesSelected(Array.from(e.target.files));
      }
    };
  }

  function handleFilesSelected(files) {
    selectedFiles = files;
    initSocket();
    socket.emit('create-room');
  }

  // Receiver Joining
  if (joinBtn) {
    joinBtn.onclick = () => {
      const code = manualCodeInput.value.trim().toUpperCase();
      if (code.length < 6) {
        showToast('Please enter a valid 6-digit code');
        return;
      }
      joinRoomByCode(code);
    };
  }

  function joinRoomByCode(code) {
    initSocket();
    socket.emit('join-room', { roomCode: code });
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
      senderQueueList.classList.toggle('hidden');
    };
  }

  // Stop / Cancel Sharing
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

    if (fileInput) fileInput.value = '';
    if (manualCodeInput) manualCodeInput.value = '';
    if (senderQueueList) senderQueueList.innerHTML = '';
    if (receiverManifestList) receiverManifestList.innerHTML = '';
    if (receiverCompleteCard) receiverCompleteCard.classList.add('hidden');
    if (receiverProgressBar) receiverProgressBar.style.width = '0%';
    if (receiverPercentage) receiverPercentage.textContent = '0.0%';

    switchView('selection');
  }

  if (stopSharingBtn) stopSharingBtn.onclick = resetToHome;
  if (cancelReceiverBtn) cancelReceiverBtn.onclick = resetToHome;
  if (brandHomeLink) brandHomeLink.onclick = resetToHome;
  if (navBeamBtn) navBeamBtn.onclick = resetToHome;

  // Download All as ZIP
  if (downloadZipBtn) {
    downloadZipBtn.onclick = async () => {
      if (receivedFilesArchive.length === 0 || typeof JSZip === 'undefined') return;
      const zip = new JSZip();
      receivedFilesArchive.forEach((f) => zip.file(f.name, f.blob));
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      triggerDownload(zipBlob, `DirectBeam_${currentRoomId || 'files'}.zip`);
      showToast('Generated ZIP archive!');
    };
  }

  // QR Code Scanner Logic
  if (scanQrBtn) {
    scanQrBtn.onclick = () => {
      scannerWrapper.classList.remove('hidden');
      startQrScanner();
    };
  }

  if (closeScannerBtn) {
    closeScannerBtn.onclick = () => {
      stopQrScanner();
      scannerWrapper.classList.add('hidden');
    };
  }

  if (flipCameraBtn) {
    flipCameraBtn.onclick = () => {
      currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
      stopQrScanner();
      startQrScanner();
    };
  }

  function startQrScanner() {
    if (typeof Html5Qrcode === 'undefined') {
      showToast('QR Scanner engine not loaded.');
      return;
    }
    html5QrCodeScanner = new Html5Qrcode('qr-reader');
    html5QrCodeScanner.start(
      { facingMode: currentFacingMode },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => {
        stopQrScanner();
        scannerWrapper.classList.add('hidden');
        // Extract 6-digit code if URL is scanned
        const urlMatch = decodedText.match(/code=([A-Za-z0-9]{6})/);
        const code = urlMatch ? urlMatch[1] : decodedText.trim().slice(0, 6);
        joinRoomByCode(code.toUpperCase());
      },
      (error) => {}
    ).catch((err) => {
      console.warn('Unable to start QR Scanner', err);
      showToast('Camera access denied or unavailable');
      scannerWrapper.classList.add('hidden');
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
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => {
      content.classList.remove('scale-95', 'opacity-0');
      content.classList.add('scale-100', 'opacity-100');
    }, 10);
  }

  function closeModal(modal, content) {
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

  // Email Copy Buttons
  if (copyEmailDockBtn) {
    copyEmailDockBtn.onclick = () => {
      copyTextToClipboard('vishwanthmalla0324@gmail.com', 'Founder email copied!');
    };
  }
  if (modalCopyEmailBtn) {
    modalCopyEmailBtn.onclick = () => {
      copyTextToClipboard('vishwanthmalla0324@gmail.com', 'Founder email copied!');
    };
  }

  // Auto-Join by URL Query Parameter (e.g. `?code=ABC123`)
  window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code && code.length >= 6) {
      if (manualCodeInput) manualCodeInput.value = code.toUpperCase();
      joinRoomByCode(code.toUpperCase());
    }
  });

})();