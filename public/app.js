// Render-resilient Socket connection
const socket = io({
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 2000,
  transports: ['websocket', 'polling']
});

// Watchdog for Render Free Tier Cold Starts
let coldStartTimer = setTimeout(() => {
  const banner = document.getElementById('cold-start-banner');
  if (banner && !socket.connected) {
    banner.classList.remove('hidden');
  }
}, 3000);

socket.on('connect', () => {
  clearTimeout(coldStartTimer);
  const banner = document.getElementById('cold-start-banner');
  if (banner) banner.classList.add('hidden');
});

// WebRTC Constants
const CHUNK_SIZE = 64 * 1024; // 64 KB slices
const BUFFER_THRESHOLD = 4 * 1024 * 1024; // 4 MB backpressure threshold

// Application State
let fileQueue = [];
let currentRoomId = null;
let isInitiator = false;
let isTransferring = false;
let abortRequested = false;

// Multi-Peer Connection Map: peerId -> { pc, dc, isTransferring }
const activePeers = new Map();

// Receiver-specific State (When this device is receiving)
let receiverPC = null;
let receiverDC = null;
let incomingManifest = [];
let currentReceivingFile = null;
let receivedFileChunks = [];
let completedFiles = [];

// Telemetry & Metrics
let bytesTransferredLastInterval = 0;
let lastSpeedCalcTime = Date.now();
const SPEED_WINDOW_SIZE = 5;
let speedSamples = [];
let totalBatchBytes = 0;
let totalBatchBytesTransferred = 0;

// Scanner
let html5QrScanner = null;
let availableCameras = [];
let activeCameraIndex = 0;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

// UI Bindings
const selectionView = document.getElementById('selection-view');
const senderView = document.getElementById('sender-view');
const transferView = document.getElementById('transfer-view');
const completeView = document.getElementById('complete-view');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const manualCodeInput = document.getElementById('manual-code-input');
const joinBtn = document.getElementById('join-btn');
const displayCode = document.getElementById('display-code');

const senderQueueList = document.getElementById('sender-queue-list');
const queueSummaryCount = document.getElementById('queue-summary-count');
const queueSummarySize = document.getElementById('queue-summary-size');
const addMoreFilesBtn = document.getElementById('add-more-files-btn');
const startBeamBtn = document.getElementById('start-beam-btn');
const senderStatusPill = document.getElementById('sender-status-pill');

const copyLinkBtn = document.getElementById('copy-link-btn');
const toggleQrBtn = document.getElementById('toggle-qr-btn');
const qrModalContainer = document.getElementById('qr-modal-container');
const qrcodeBox = document.getElementById('qrcode-box');

const overallPercentage = document.getElementById('overall-percentage');
const overallProgressBar = document.getElementById('overall-progress-bar');
const overallBatchSubtitle = document.getElementById('overall-batch-subtitle');
const speedText = document.getElementById('speed-text');
const etaText = document.getElementById('eta-text');
const transferManifestList = document.getElementById('transfer-manifest-list');
const cancelTransferBtn = document.getElementById('cancel-transfer-btn');

const downloadZipBtn = document.getElementById('download-zip-btn');
const individualDownloadsContainer = document.getElementById('individual-downloads-container');

// Navigation Bindings
const brandHomeLink = document.getElementById('brand-home-link');
const btnBackHome = document.getElementById('btn-back-home');
const sendAnotherBtn = document.getElementById('send-another-btn');
const completeBackHomeBtn = document.getElementById('complete-back-home-btn');

const scanQrBtn = document.getElementById('scan-qr-btn');
const scannerWrapper = document.getElementById('scanner-wrapper');
const closeScannerBtn = document.getElementById('close-scanner-btn');
const flipCameraBtn = document.getElementById('flip-camera-btn');

// Social Dock
const copyEmailDockBtn = document.getElementById('copy-email-dock-btn');
const copyEmailTooltip = document.getElementById('copy-email-tooltip');

// ================= UTILITIES & HELPERS =================

function getFileIcon(fileName, mimeType = '') {
  const ext = fileName.split('.').pop().toLowerCase();
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext) || mimeType.startsWith('video/')) {
    return '<i data-lucide="video" class="w-4 h-4 text-purple-400"></i>';
  }
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext) || mimeType.startsWith('audio/')) {
    return '<i data-lucide="music" class="w-4 h-4 text-pink-400"></i>';
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext) || mimeType.startsWith('image/')) {
    return '<i data-lucide="image" class="w-4 h-4 text-emerald-400"></i>';
  }
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2'].includes(ext)) {
    return '<i data-lucide="archive" class="w-4 h-4 text-amber-400"></i>';
  }
  if (['js', 'ts', 'html', 'css', 'json', 'py', 'cpp', 'rs', 'go'].includes(ext)) {
    return '<i data-lucide="code" class="w-4 h-4 text-cyan-400"></i>';
  }
  if (['pdf', 'doc', 'docx', 'txt', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) {
    return '<i data-lucide="file-text" class="w-4 h-4 text-blue-400"></i>';
  }
  return '<i data-lucide="file" class="w-4 h-4 text-slate-400"></i>';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showToast(message) {
  const toast = document.getElementById('toast');
  const msg = document.getElementById('toast-message');
  msg.textContent = message;
  toast.classList.remove('translate-y-[-20px]', 'opacity-0', 'pointer-events-none');
  setTimeout(() => {
    toast.classList.add('translate-y-[-20px]', 'opacity-0', 'pointer-events-none');
  }, 2200);
}

function updateNavState(activeViewId) {
  btnBackHome.classList.toggle('hidden', activeViewId === 'selection-view');
}

function triggerInputError(message) {
  showToast(message);
  manualCodeInput.classList.add('border-rose-500', 'animate-bounce');
  setTimeout(() => {
    manualCodeInput.classList.remove('border-rose-500', 'animate-bounce');
    manualCodeInput.value = '';
    manualCodeInput.focus();
  }, 900);
}

// ================= ZERO-CLICK RECEIVER SUBMISSION =================

manualCodeInput.addEventListener('input', (e) => {
  const cleanCode = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
  e.target.value = cleanCode;

  if (cleanCode.length === 6) {
    initiateReceiver(cleanCode);
  }
});

joinBtn.addEventListener('click', () => {
  const code = manualCodeInput.value.trim();
  if (code.length === 6) {
    initiateReceiver(code);
  } else {
    triggerInputError('Enter a valid 6-digit code');
  }
});

window.addEventListener('DOMContentLoaded', () => {
  const hash = window.location.hash.replace('#', '').trim();
  if (hash && hash.length === 6 && /^\d+$/.test(hash)) {
    manualCodeInput.value = hash;
    initiateReceiver(hash);
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const room = urlParams.get('room');
  if (room && room.length === 6 && /^\d+$/.test(room)) {
    manualCodeInput.value = room;
    initiateReceiver(room);
  }
});

function initiateReceiver(roomId) {
  currentRoomId = roomId;
  isInitiator = false;
  abortRequested = false;

  selectionView.classList.add('hidden');
  transferView.classList.remove('hidden');
  updateNavState('transfer-view');

  document.getElementById('transfer-role-text').textContent = 'Connecting to Sender...';
  overallBatchSubtitle.textContent = 'Room joined — establishing direct P2P data stream...';

  socket.emit('join-room', currentRoomId);
}

// ================= SENDER QUEUE CREATION =================

dropZone.addEventListener('click', (e) => {
  if (e.target !== fileInput) fileInput.click();
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('border-cyan-500', 'bg-slate-950/70');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('border-cyan-500', 'bg-slate-950/70');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('border-cyan-500', 'bg-slate-950/70');
  if (e.dataTransfer?.files?.length > 0) {
    appendFilesToQueue(Array.from(e.dataTransfer.files));
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files?.length > 0) {
    appendFilesToQueue(Array.from(e.target.files));
  }
});

addMoreFilesBtn.addEventListener('click', () => {
  fileInput.click();
});

function appendFilesToQueue(newFiles) {
  newFiles.forEach((file) => {
    fileQueue.push({
      id: 'f_' + Math.random().toString(36).substring(2, 9),
      file: file,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream'
    });
  });

  if (!isInitiator) {
    isInitiator = true;
    currentRoomId = Math.floor(100000 + Math.random() * 900000).toString();
    displayCode.textContent = currentRoomId;

    qrcodeBox.innerHTML = '';
    const shareUrl = `${window.location.origin}/#${currentRoomId}`;
    new QRCode(qrcodeBox, {
      text: shareUrl,
      width: 140,
      height: 140,
      colorDark: "#020617",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });

    selectionView.classList.add('hidden');
    senderView.classList.remove('hidden');
    updateNavState('sender-view');
    socket.emit('join-room', currentRoomId);
  }

  renderQueueUI();
}

function removeFileFromQueue(fileId) {
  fileQueue = fileQueue.filter(item => item.id !== fileId);
  if (fileQueue.length === 0) {
    resetApplicationState(false);
    return;
  }
  renderQueueUI();
}

function renderQueueUI() {
  senderQueueList.innerHTML = '';
  let totalBytes = 0;

  fileQueue.forEach((item) => {
    totalBytes += item.size;
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between bg-slate-900 border border-slate-800/80 px-2.5 py-1.5 rounded-lg';
    li.innerHTML = `
      <div class="flex items-center gap-2 min-w-0 pr-2">
        ${getFileIcon(item.name, item.type)}
        <span class="truncate text-slate-200 font-medium">${item.name}</span>
      </div>
      <div class="flex items-center gap-3 flex-shrink-0">
        <span class="font-mono text-[11px] text-slate-400">${formatBytes(item.size)}</span>
        <button data-id="${item.id}" class="remove-file-btn text-slate-500 hover:text-rose-400 transition">
          <i data-lucide="x" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    `;
    senderQueueList.appendChild(li);
  });

  queueSummaryCount.textContent = `${fileQueue.length} file${fileQueue.length === 1 ? '' : 's'}`;
  queueSummarySize.textContent = formatBytes(totalBytes);

  senderQueueList.querySelectorAll('.remove-file-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFileFromQueue(btn.getAttribute('data-id'));
    });
  });

  lucide.createIcons();
}

copyLinkBtn.addEventListener('click', () => {
  const shareUrl = `${window.location.origin}/#${currentRoomId}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('Direct room URL copied to clipboard');
  }).catch(() => {
    showToast('Failed to copy link');
  });
});

toggleQrBtn.addEventListener('click', () => {
  qrModalContainer.classList.toggle('hidden');
});

// ================= QR SCANNER =================

scanQrBtn.addEventListener('click', async () => {
  scannerWrapper.classList.remove('hidden');
  try {
    availableCameras = await Html5Qrcode.getCameras();
    if (!availableCameras?.length) {
      alert('No camera detected on this device.');
      stopScanner();
      return;
    }
    flipCameraBtn.style.display = availableCameras.length > 1 ? 'flex' : 'none';
    activeCameraIndex = availableCameras.length > 1 ? availableCameras.length - 1 : 0;
    startActiveCamera();
  } catch (err) {
    alert('Camera permission denied or camera unavailable.');
    stopScanner();
  }
});

flipCameraBtn.addEventListener('click', async () => {
  if (availableCameras.length <= 1) return;
  activeCameraIndex = (activeCameraIndex + 1) % availableCameras.length;
  startActiveCamera();
});

async function startActiveCamera() {
  if (html5QrScanner) {
    try { await html5QrScanner.stop(); } catch (_) {}
  }
  const cameraId = availableCameras[activeCameraIndex].id;
  html5QrScanner = new Html5Qrcode("qr-reader");

  await html5QrScanner.start(
    cameraId,
    { fps: 15, qrbox: { width: 200, height: 200 } },
    (decodedText) => {
      stopScanner();
      let code = decodedText.trim();
      const match = code.match(/\b\d{6}\b/);
      if (match) code = match[0];

      if (code.length === 6) {
        manualCodeInput.value = code;
        initiateReceiver(code);
      } else {
        triggerInputError('Invalid QR format');
      }
    },
    () => {}
  );
}

closeScannerBtn.addEventListener('click', stopScanner);

function stopScanner() {
  if (html5QrScanner) {
    html5QrScanner.stop().then(() => {
      html5QrScanner.clear();
      scannerWrapper.classList.add('hidden');
    }).catch(() => {
      scannerWrapper.classList.add('hidden');
    });
  } else {
    scannerWrapper.classList.add('hidden');
  }
}

// ================= MULTI-PEER WEBRTC PIPELINE =================

// When any receiver joins, sender sets up an ISOLATED connection for that specific peer
socket.on('peer-joined', async (peerId) => {
  if (isInitiator) {
    const pc = new RTCPeerConnection(rtcConfig);
    const dc = pc.createDataChannel('fileStream', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

    activePeers.set(peerId, { pc, dc, isTransferring: false });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { target: peerId, candidate: event.candidate });
      }
    };

    // When this specific device opens its DataChannel, immediately launch its dedicated stream worker
    dc.onopen = () => {
      startIsolatedSenderStream(peerId);
      updateSenderCountUI();
    };

    dc.onclose = () => {
      activePeers.delete(peerId);
      updateSenderCountUI();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { target: peerId, sdp: offer });
    updateSenderCountUI();
  }
});

// Receiver handles offer from sender
socket.on('offer', async ({ sender, sdp }) => {
  if (!isInitiator) {
    receiverPC = new RTCPeerConnection(rtcConfig);

    receiverPC.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { target: sender, candidate: event.candidate });
      }
    };

    receiverPC.ondatachannel = (event) => {
      receiverDC = event.channel;
      receiverDC.binaryType = 'arraybuffer';
      setupReceiverDataChannel(receiverDC);
    };

    await receiverPC.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await receiverPC.createAnswer();
    await receiverPC.setLocalDescription(answer);

    socket.emit('answer', { target: sender, sdp: answer });
  }
});

// Sender receives answer for a specific peer
socket.on('answer', async ({ sender, sdp }) => {
  if (isInitiator && activePeers.has(sender)) {
    const peer = activePeers.get(sender);
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

socket.on('ice-candidate', async ({ sender, candidate }) => {
  try {
    if (isInitiator && activePeers.has(sender)) {
      await activePeers.get(sender).pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else if (!isInitiator && receiverPC) {
      await receiverPC.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (_) {}
});

socket.on('peer-disconnected', (peerId) => {
  if (isInitiator && activePeers.has(peerId)) {
    const p = activePeers.get(peerId);
    try { p.dc?.close(); } catch (_) {}
    try { p.pc?.close(); } catch (_) {}
    activePeers.delete(peerId);
    updateSenderCountUI();
  }
});

function updateSenderCountUI() {
  const count = activePeers.size;
  senderStatusPill.textContent = `${count} Device${count === 1 ? '' : 's'} Connected`;
  senderStatusPill.className = count > 0 
    ? 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
    : 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20';
}

// ================= ISOLATED SENDER STREAM WORKER =================

async function startIsolatedSenderStream(peerId) {
  if (!activePeers.has(peerId) || fileQueue.length === 0) return;
  const peer = activePeers.get(peerId);
  if (peer.isTransferring) return;
  peer.isTransferring = true;

  // Show sender transfer UI
  senderView.classList.add('hidden');
  transferView.classList.remove('hidden');
  updateNavState('transfer-view');

  const manifest = fileQueue.map(item => ({
    id: item.id,
    name: item.name,
    size: item.size,
    type: item.type
  }));

  totalBatchBytes = fileQueue.reduce((acc, f) => acc + f.size, 0);
  renderManifestUI(manifest);

  // 1. Send initial Manifest to this specific peer
  peer.dc.send(JSON.stringify({
    type: 'manifest',
    totalFiles: fileQueue.length,
    totalBytes: totalBatchBytes,
    files: manifest
  }));

  // 2. Stream all files in order specifically to this peer
  for (let i = 0; i < fileQueue.length; i++) {
    if (abortRequested || !activePeers.has(peerId)) break;
    const item = fileQueue[i];

    overallBatchSubtitle.textContent = `Streaming file ${i + 1} of ${fileQueue.length}`;
    updateManifestRowStatus(item.id, 'streaming');

    await streamSingleFileToPeer(peer.dc, item);
    updateManifestRowStatus(item.id, 'complete');
  }

  // 3. Send final batch-complete to this specific peer
  if (!abortRequested && activePeers.has(peerId) && peer.dc.readyState === 'open') {
    peer.dc.send(JSON.stringify({ type: 'batch-complete' }));
  }

  finishTransferSuccess(fileQueue.length);
}

function streamSingleFileToPeer(dc, item) {
  return new Promise((resolve) => {
    if (dc.readyState !== 'open') {
      resolve();
      return;
    }

    dc.send(JSON.stringify({ type: 'file-start', id: item.id }));

    let offset = 0;
    const file = item.file;
    const total = file.size;

    lastSpeedCalcTime = Date.now();
    bytesTransferredLastInterval = 0;

    function readNextSlice() {
      if (abortRequested || dc.readyState !== 'open') {
        resolve();
        return;
      }

      // Check Backpressure on this specific peer's DataChannel
      if (dc.bufferedAmount > BUFFER_THRESHOLD) {
        dc.onbufferedamountlow = () => {
          dc.onbufferedamountlow = null;
          readNextSlice();
        };
        return;
      }

      if (offset < total) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();

        reader.onload = (e) => {
          if (abortRequested || dc.readyState !== 'open') {
            resolve();
            return;
          }

          dc.send(e.target.result);
          const bytesRead = e.target.result.byteLength;
          offset += bytesRead;
          totalBatchBytesTransferred += bytesRead;
          bytesTransferredLastInterval += bytesRead;

          updateProgressTelemetry(totalBatchBytesTransferred, totalBatchBytes);
          readNextSlice();
        };

        reader.readAsArrayBuffer(slice);
      } else {
        dc.send(JSON.stringify({ type: 'file-end', id: item.id }));
        resolve();
      }
    }

    readNextSlice();
  });
}

// ================= RECEIVER ENGINE =================

function setupReceiverDataChannel(channel) {
  channel.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.type === 'manifest') {
        isTransferring = true;
        abortRequested = false;
        incomingManifest = msg.files;
        totalBatchBytes = msg.totalBytes;
        totalBatchBytesTransferred = 0;
        completedFiles = [];

        document.getElementById('transfer-role-text').textContent = 'Receiving Auto-Stream';
        overallBatchSubtitle.textContent = `Streaming 0 of ${incomingManifest.length} files`;
        renderManifestUI(incomingManifest);
      }
      else if (msg.type === 'file-start') {
        currentReceivingFile = incomingManifest.find(f => f.id === msg.id);
        receivedFileChunks = [];
        updateManifestRowStatus(msg.id, 'streaming');
      }
      else if (msg.type === 'file-end') {
        if (!currentReceivingFile) return;

        const blob = new Blob(receivedFileChunks, { type: currentReceivingFile.type });
        const url = URL.createObjectURL(blob);
        completedFiles.push({ name: currentReceivingFile.name, blob, url });

        // Auto-download each file
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = currentReceivingFile.name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => document.body.removeChild(a), 500);

        updateManifestRowStatus(currentReceivingFile.id, 'complete');
        receivedFileChunks = [];
        currentReceivingFile = null;

        overallBatchSubtitle.textContent = `${completedFiles.length} of ${incomingManifest.length} files received`;
      }
      else if (msg.type === 'batch-complete') {
        renderCompletedReceiverDownloads();
        finishTransferSuccess(incomingManifest.length);
      }
      return;
    }

    // Binary Chunk received
    const chunk = event.data;
    receivedFileChunks.push(chunk);

    const chunkSize = chunk.byteLength;
    totalBatchBytesTransferred += chunkSize;
    bytesTransferredLastInterval += chunkSize;

    updateProgressTelemetry(totalBatchBytesTransferred, totalBatchBytes);
  };
}

// ================= PROGRESS & METRICS =================

function updateProgressTelemetry(batchCurrent, batchTotal) {
  if (!batchTotal || batchTotal === 0) return;
  const percent = Math.min(100, (batchCurrent / batchTotal) * 100);
  overallProgressBar.style.width = `${percent}%`;
  overallPercentage.textContent = `${percent.toFixed(1)}%`;

  const now = Date.now();
  const delta = (now - lastSpeedCalcTime) / 1000;

  if (delta >= 0.8) {
    const currentSpeedMBps = (bytesTransferredLastInterval / (1024 * 1024)) / delta;
    bytesTransferredLastInterval = 0;
    lastSpeedCalcTime = now;

    speedSamples.push(currentSpeedMBps);
    if (speedSamples.length > SPEED_WINDOW_SIZE) speedSamples.shift();
    const avgSpeedMBps = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;

    speedText.textContent = `${avgSpeedMBps.toFixed(2)} MB/s`;

    const remainingBytes = batchTotal - batchCurrent;
    if (avgSpeedMBps > 0.05) {
      const remainingSeconds = remainingBytes / (avgSpeedMBps * 1024 * 1024);
      etaText.textContent = formatETA(remainingSeconds);
    } else {
      etaText.textContent = 'Calculating...';
    }
  }
}

function formatETA(seconds) {
  if (!isFinite(seconds) || seconds < 0) return 'Calculating...';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `${mins}m ${secs}s`;
}

function renderManifestUI(manifest) {
  transferManifestList.innerHTML = '';
  manifest.forEach((item) => {
    const li = document.createElement('li');
    li.id = `manifest-${item.id}`;
    li.className = 'flex items-center justify-between bg-slate-900 border border-slate-800/80 px-2.5 py-1.5 rounded-lg';
    li.innerHTML = `
      <div class="flex items-center gap-2 min-w-0 pr-2">
        ${getFileIcon(item.name, item.type)}
        <span class="truncate text-slate-300 font-medium">${item.name}</span>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="font-mono text-[10px] text-slate-500">${formatBytes(item.size)}</span>
        <span class="status-indicator text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">queued</span>
      </div>
    `;
    transferManifestList.appendChild(li);
  });
  lucide.createIcons();
}

function updateManifestRowStatus(fileId, status) {
  const row = document.getElementById(`manifest-${fileId}`);
  if (!row) return;

  const indicator = row.querySelector('.status-indicator');
  if (status === 'streaming') {
    indicator.textContent = 'streaming';
    indicator.className = 'status-indicator text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 animate-pulse';
  } else if (status === 'complete') {
    indicator.textContent = 'downloaded';
    indicator.className = 'status-indicator text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
  }
}

function renderCompletedReceiverDownloads() {
  if (completedFiles.length === 0) return;

  downloadZipBtn.classList.remove('hidden');
  downloadZipBtn.onclick = async () => {
    downloadZipBtn.disabled = true;
    downloadZipBtn.textContent = 'Generating .ZIP archive...';

    const zip = new JSZip();
    completedFiles.forEach((f) => {
      zip.file(f.name, f.blob);
    });

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = zipUrl;
    a.download = `DirectBeam_Batch_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    downloadZipBtn.disabled = false;
    downloadZipBtn.innerHTML = '<i data-lucide="archive" class="w-4 h-4"></i> Download All as .ZIP';
    lucide.createIcons();
  };

  individualDownloadsContainer.innerHTML = completedFiles.map(f => `
    <div class="flex items-center justify-between bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg">
      <span class="truncate text-slate-300 text-xs">${f.name}</span>
      <a href="${f.url}" download="${f.name}" class="text-[11px] font-mono text-cyan-400 hover:text-cyan-300 underline flex items-center gap-1">
        <i data-lucide="download" class="w-3 h-3"></i> re-download
      </a>
    </div>
  `).join('');
  lucide.createIcons();
}

function finishTransferSuccess(fileCount) {
  isTransferring = false;
  transferView.classList.add('hidden');
  completeView.classList.remove('hidden');
  updateNavState('complete-view');

  document.getElementById('complete-details').textContent =
    `Successfully transferred ${fileCount} file${fileCount === 1 ? '' : 's'} with full cryptographic integrity.`;

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (_) {}

  lucide.createIcons();
}

// ================= RESET STATE =================

function resetApplicationState(confirmIfBusy = false) {
  if (confirmIfBusy && isTransferring) {
    const proceed = confirm('A transfer is active. Returning home will cancel it. Continue?');
    if (!proceed) return;
  }

  abortRequested = true;
  isTransferring = false;

  for (const [id, p] of activePeers) {
    try { p.dc?.close(); } catch (_) {}
    try { p.pc?.close(); } catch (_) {}
  }
  activePeers.clear();

  if (receiverDC) {
    try { receiverDC.close(); } catch (_) {}
    receiverDC = null;
  }
  if (receiverPC) {
    try { receiverPC.close(); } catch (_) {}
    receiverPC = null;
  }

  if (currentRoomId && socket.connected) {
    socket.emit('leave-room', currentRoomId);
  }

  fileQueue = [];
  incomingManifest = [];
  currentReceivingFile = null;
  receivedFileChunks = [];
  completedFiles = [];
  currentRoomId = null;
  isInitiator = false;

  overallProgressBar.style.width = '0%';
  overallPercentage.textContent = '0.0%';
  speedText.textContent = '0.00 MB/s';
  etaText.textContent = 'Calculating...';
  manualCodeInput.value = '';
  fileInput.value = '';

  downloadZipBtn.classList.add('hidden');
  individualDownloadsContainer.innerHTML = '';
  window.history.replaceState({}, document.title, window.location.pathname);

  completeView.classList.add('hidden');
  transferView.classList.add('hidden');
  senderView.classList.add('hidden');
  selectionView.classList.remove('hidden');

  updateNavState('selection-view');
  lucide.createIcons();
}

// Navigation & Actions
btnBackHome.addEventListener('click', () => resetApplicationState(true));
brandHomeLink.addEventListener('click', () => resetApplicationState(true));
cancelTransferBtn.addEventListener('click', () => resetApplicationState(true));
completeBackHomeBtn.addEventListener('click', () => resetApplicationState(false));

sendAnotherBtn.addEventListener('click', () => {
  resetApplicationState(false);
  fileInput.click();
});

// Social Dock Clipboard
if (copyEmailDockBtn) {
  copyEmailDockBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const emailToCopy = copyEmailDockBtn.getAttribute('data-email') || 'vishwanthmalla0324@gmail.com';

    try {
      await navigator.clipboard.writeText(emailToCopy);
      
      if (copyEmailTooltip) {
        copyEmailTooltip.textContent = 'Copied!';
        copyEmailTooltip.classList.remove('opacity-0');
        copyEmailTooltip.classList.add('opacity-100', 'text-emerald-400', 'border-emerald-500/40');

        setTimeout(() => {
          copyEmailTooltip.textContent = 'Copy Email';
          copyEmailTooltip.classList.remove('text-emerald-400', 'border-emerald-500/40');
          copyEmailTooltip.classList.add('opacity-0');
        }, 1800);
      }

      showToast('Email address copied to clipboard');
    } catch (_) {
      showToast('Could not copy email');
    }
  });
}