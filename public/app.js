const socket = io({
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 2000,
  transports: ['websocket', 'polling']
});

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

// High-Throughput Constants
const CHUNK_SIZE = 64 * 1024;
const BUFFER_THRESHOLD = 4 * 1024 * 1024;

// Application State
let isHost = false;
let currentRoomId = null;
let fileQueue = [];

// SENDER: Map<receiverId, { pc, dc, bytesSent, progress, isStreaming }>
const receiverPeers = new Map();

// RECEIVER: Single peer connection pulling from persistent host
let receiverPC = null;
let receiverDC = null;
let incomingManifest = [];
let currentReceivingFile = null;
let receivedFileChunks = [];
let completedFiles = [];

// Metrics
let bytesTransferredLastInterval = 0;
let lastSpeedCalcTime = Date.now();
const SPEED_WINDOW_SIZE = 5;
let speedSamples = [];
let totalBatchBytes = 0;
let totalBatchBytesTransferred = 0;

// QR Scanner
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

// UI Elements
const selectionView = document.getElementById('selection-view');
const senderView = document.getElementById('sender-view');
const receiverView = document.getElementById('receiver-view');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const manualCodeInput = document.getElementById('manual-code-input');
const joinBtn = document.getElementById('join-btn');
const displayCode = document.getElementById('display-code');

const copyLinkBtn = document.getElementById('copy-link-btn');
const qrcodeBox = document.getElementById('qrcode-box');
const connectedCountPill = document.getElementById('connected-count-pill');
const queueSummaryCount = document.getElementById('queue-summary-count');
const queueSummarySize = document.getElementById('queue-summary-size');
const toggleManifestBtn = document.getElementById('toggle-manifest-btn');
const senderQueueList = document.getElementById('sender-queue-list');
const receiversActivityFeed = document.getElementById('receivers-activity-feed');
const stopSharingBtn = document.getElementById('stop-sharing-btn');

// Receiver Elements
const receiverBatchSubtitle = document.getElementById('receiver-batch-subtitle');
const receiverPercentage = document.getElementById('receiver-percentage');
const receiverProgressBar = document.getElementById('receiver-progress-bar');
const receiverSpeedText = document.getElementById('receiver-speed-text');
const receiverEtaText = document.getElementById('receiver-eta-text');
const receiverManifestList = document.getElementById('receiver-manifest-list');
const receiverCompleteCard = document.getElementById('receiver-complete-card');
const downloadZipBtn = document.getElementById('download-zip-btn');
const cancelReceiverBtn = document.getElementById('cancel-receiver-btn');

// Navigation & Brand
const brandHomeLink = document.getElementById('brand-home-link');
const navBeamBtn = document.getElementById('nav-beam-btn');
const scanQrBtn = document.getElementById('scan-qr-btn');
const scannerWrapper = document.getElementById('scanner-wrapper');
const closeScannerBtn = document.getElementById('close-scanner-btn');
const flipCameraBtn = document.getElementById('flip-camera-btn');

// Social Dock
const copyEmailDockBtn = document.getElementById('copy-email-dock-btn');
const copyEmailTooltip = document.getElementById('copy-email-tooltip');

// Modals
const founderModal = document.getElementById('founder-modal');
const founderModalContent = document.getElementById('founder-modal-content');
const founderModalBackdrop = document.getElementById('founder-modal-backdrop');
const openFounderModalBtn = document.getElementById('open-founder-modal-btn');
const navFounderBtn = document.getElementById('nav-founder-btn');
const closeFounderModalBtn = document.getElementById('close-founder-modal-btn');
const modalCopyEmailBtn = document.getElementById('modal-copy-email-btn');
const modalEmailTooltip = document.getElementById('modal-email-tooltip');

const faqModal = document.getElementById('faq-modal');
const faqModalBackdrop = document.getElementById('faq-modal-backdrop');
const navFaqBtn = document.getElementById('nav-faq-btn');
const closeFaqModalBtn = document.getElementById('close-faq-modal-btn');

const securityModal = document.getElementById('security-modal');
const securityModalBackdrop = document.getElementById('security-modal-backdrop');
const navSecurityBtn = document.getElementById('nav-security-btn');
const closeSecurityModalBtn = document.getElementById('close-security-modal-btn');

// ================= UTILITIES =================

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

function triggerInputError(message) {
  showToast(message);
  manualCodeInput.classList.add('border-rose-500', 'animate-bounce');
  setTimeout(() => {
    manualCodeInput.classList.remove('border-rose-500', 'animate-bounce');
    manualCodeInput.value = '';
    manualCodeInput.focus();
  }, 900);
}

window.addEventListener('beforeunload', (e) => {
  if (isHost && fileQueue.length > 0) {
    e.preventDefault();
    e.returnValue = 'Closing this tab terminates your live file share session.';
  }
});

// ================= AUTO-ROUTE / RECEIVER JOIN =================

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
  isHost = false;

  selectionView.classList.add('hidden');
  senderView.classList.add('hidden');
  receiverView.classList.remove('hidden');

  receiverBatchSubtitle.textContent = 'Connecting to sender host...';
  socket.emit('join-room', currentRoomId);
}

// ================= SENDER: PERSISTENT HOST INITIALIZATION =================

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
    handleHostFiles(Array.from(e.dataTransfer.files));
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files?.length > 0) {
    handleHostFiles(Array.from(e.target.files));
  }
});

function handleHostFiles(files) {
  if (!files || files.length === 0) return;

  isHost = true;
  currentRoomId = Math.floor(100000 + Math.random() * 900000).toString();

  fileQueue = files.map(file => ({
    id: 'f_' + Math.random().toString(36).substring(2, 9),
    file: file,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream'
  }));

  displayCode.textContent = currentRoomId;

  // Render QR Code
  qrcodeBox.innerHTML = '';
  const shareUrl = `${window.location.origin}/#${currentRoomId}`;
  new QRCode(qrcodeBox, {
    text: shareUrl,
    width: 130,
    height: 130,
    colorDark: "#020617",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  setupSocialShareButtons(shareUrl);

  const totalBytes = fileQueue.reduce((acc, f) => acc + f.size, 0);
  queueSummaryCount.textContent = `${fileQueue.length} file${fileQueue.length === 1 ? '' : 's'}`;
  queueSummarySize.textContent = formatBytes(totalBytes);

  senderQueueList.innerHTML = fileQueue.map(item => `
    <li class="flex items-center justify-between bg-slate-900/80 px-2.5 py-1.5 rounded border border-slate-800/80">
      <div class="flex items-center gap-2 min-w-0 pr-2">
        ${getFileIcon(item.name, item.type)}
        <span class="truncate font-medium text-slate-200">${item.name}</span>
      </div>
      <span class="font-mono text-[10px] text-slate-400">${formatBytes(item.size)}</span>
    </li>
  `).join('');

  selectionView.classList.add('hidden');
  receiverView.classList.add('hidden');
  senderView.classList.remove('hidden');

  socket.emit('create-room', currentRoomId);
  lucide.createIcons();
}

function setupSocialShareButtons(shareUrl) {
  const encUrl = encodeURIComponent(shareUrl);
  const textMsg = encodeURIComponent(`Direct Beam P2P: Download my files directly: ${shareUrl}`);

  document.getElementById('share-wa').onclick = () => window.open(`https://api.whatsapp.com/send?text=${textMsg}`, '_blank');
  document.getElementById('share-fb').onclick = () => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encUrl}`, '_blank');
  document.getElementById('share-x').onclick = () => window.open(`https://twitter.com/intent/tweet?text=${textMsg}`, '_blank');
  document.getElementById('share-li').onclick = () => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encUrl}`, '_blank');
  document.getElementById('share-gmail').onclick = () => window.open(`https://mail.google.com/mail/?view=cm&fs=1&su=Direct+Beam+Files&body=${textMsg}`, '_blank');
  document.getElementById('share-email').onclick = () => window.open(`mailto:?subject=Direct Beam File Share&body=${textMsg}`, '_self');
  document.getElementById('share-native').onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Direct Beam P2P', text: 'Download files directly peer-to-peer:', url: shareUrl });
      } catch (_) {}
    } else {
      navigator.clipboard.writeText(shareUrl);
      showToast('Link copied to clipboard');
    }
  };
}

toggleManifestBtn.addEventListener('click', () => {
  senderQueueList.classList.toggle('hidden');
});

copyLinkBtn.addEventListener('click', () => {
  const shareUrl = `${window.location.origin}/#${currentRoomId}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('Direct share link copied to clipboard');
  }).catch(() => {
    showToast('Failed to copy link');
  });
});

stopSharingBtn.addEventListener('click', () => {
  if (confirm('Stop sharing files and close this session for all receivers?')) {
    resetStateAndGoHome();
  }
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
        triggerInputError('Scanned QR does not contain a valid room code');
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

// ================= MULTI-PEER WEBRTC ENGINE =================

socket.on('receiver-joined', async ({ receiverId }) => {
  if (!isHost) return;

  const pc = new RTCPeerConnection(rtcConfig);
  const dc = pc.createDataChannel('fileStream', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

  receiverPeers.set(receiverId, { pc, dc, bytesSent: 0, progress: 0, isStreaming: false });
  updateSenderActivityFeed();

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal-ice', { target: receiverId, candidate: event.candidate });
    }
  };

  dc.onopen = () => {
    startIsolatedStreamToReceiver(receiverId);
  };

  dc.onclose = () => {
    cleanupReceiverPeer(receiverId);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal-offer', { target: receiverId, sdp: offer });
});

socket.on('signal-offer', async ({ sender, sdp }) => {
  if (isHost) return;

  receiverPC = new RTCPeerConnection(rtcConfig);

  receiverPC.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal-ice', { target: sender, candidate: event.candidate });
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

  socket.emit('signal-answer', { target: sender, sdp: answer });
});

socket.on('signal-answer', async ({ sender, sdp }) => {
  if (isHost && receiverPeers.has(sender)) {
    const peer = receiverPeers.get(sender);
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

socket.on('signal-ice', async ({ sender, candidate }) => {
  try {
    if (isHost && receiverPeers.has(sender)) {
      await receiverPeers.get(sender).pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else if (!isHost && receiverPC) {
      await receiverPC.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (_) {}
});

socket.on('receiver-disconnected', ({ receiverId }) => {
  if (isHost) cleanupReceiverPeer(receiverId);
});

socket.on('host-offline', () => {
  if (!isHost) {
    showToast('The sender closed the share session.');
    resetStateAndGoHome();
  }
});

socket.on('room-error', (msg) => {
  triggerInputError(msg);
  resetStateAndGoHome();
});

function cleanupReceiverPeer(receiverId) {
  if (receiverPeers.has(receiverId)) {
    const p = receiverPeers.get(receiverId);
    try { p.dc?.close(); } catch (_) {}
    try { p.pc?.close(); } catch (_) {}
    receiverPeers.delete(receiverId);
    updateSenderActivityFeed();
  }
}

function updateSenderActivityFeed() {
  const count = receiverPeers.size;
  connectedCountPill.textContent = `${count} devices connected`;

  if (count === 0) {
    receiversActivityFeed.innerHTML = `<p class="text-slate-500 italic text-[11px]">Waiting for peers to open the link...</p>`;
    return;
  }

  let index = 1;
  let html = '';
  for (const [id, peer] of receiverPeers) {
    const shortId = id.slice(0, 5);
    html += `
      <div class="flex items-center justify-between bg-slate-900/90 border border-slate-800 px-3 py-1.5 rounded-lg">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full ${peer.progress >= 100 ? 'bg-emerald-400' : 'bg-cyan-400 animate-pulse'}"></span>
          <span class="font-mono text-slate-300">Device #${index} (${shortId})</span>
        </div>
        <span class="font-mono font-bold ${peer.progress >= 100 ? 'text-emerald-400' : 'text-cyan-400'}">
          ${peer.progress >= 100 ? 'Completed' : `${peer.progress.toFixed(0)}%`}
        </span>
      </div>
    `;
    index++;
  }
  receiversActivityFeed.innerHTML = html;
}

// ================= ISOLATED SENDER STREAM WORKER =================

async function startIsolatedStreamToReceiver(receiverId) {
  if (!receiverPeers.has(receiverId) || fileQueue.length === 0) return;
  const peer = receiverPeers.get(receiverId);
  if (peer.isStreaming) return;
  peer.isStreaming = true;

  const totalBytes = fileQueue.reduce((acc, f) => acc + f.size, 0);

  const manifest = fileQueue.map(item => ({
    id: item.id,
    name: item.name,
    size: item.size,
    type: item.type
  }));

  peer.dc.send(JSON.stringify({
    type: 'manifest',
    totalFiles: fileQueue.length,
    totalBytes: totalBytes,
    files: manifest
  }));

  for (let i = 0; i < fileQueue.length; i++) {
    if (!receiverPeers.has(receiverId)) break;
    const item = fileQueue[i];
    await streamSingleFileToPeer(peer, item, totalBytes, receiverId);
  }

  if (receiverPeers.has(receiverId) && peer.dc.readyState === 'open') {
    peer.dc.send(JSON.stringify({ type: 'batch-complete' }));
    peer.progress = 100;
    updateSenderActivityFeed();
  }
}

function streamSingleFileToPeer(peer, item, totalBatchBytes, receiverId) {
  return new Promise((resolve) => {
    if (peer.dc.readyState !== 'open') {
      resolve();
      return;
    }

    peer.dc.send(JSON.stringify({ type: 'file-start', id: item.id }));

    let offset = 0;
    const file = item.file;
    const total = file.size;

    function readNextSlice() {
      if (!receiverPeers.has(receiverId) || peer.dc.readyState !== 'open') {
        resolve();
        return;
      }

      if (peer.dc.bufferedAmount > BUFFER_THRESHOLD) {
        peer.dc.onbufferedamountlow = () => {
          peer.dc.onbufferedamountlow = null;
          readNextSlice();
        };
        return;
      }

      if (offset < total) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();

        reader.onload = (e) => {
          if (!receiverPeers.has(receiverId) || peer.dc.readyState !== 'open') {
            resolve();
            return;
          }

          peer.dc.send(e.target.result);
          const bytesRead = e.target.result.byteLength;
          offset += bytesRead;
          peer.bytesSent += bytesRead;

          peer.progress = Math.min(99, (peer.bytesSent / totalBatchBytes) * 100);
          updateSenderActivityFeed();

          readNextSlice();
        };

        reader.readAsArrayBuffer(slice);
      } else {
        peer.dc.send(JSON.stringify({ type: 'file-end', id: item.id }));
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
        incomingManifest = msg.files;
        totalBatchBytes = msg.totalBytes;
        totalBatchBytesTransferred = 0;
        completedFiles = [];
        bytesTransferredLastInterval = 0;
        lastSpeedCalcTime = Date.now();

        receiverBatchSubtitle.textContent = `Streaming files directly from sender...`;
        renderReceiverManifestUI(incomingManifest);
      }
      else if (msg.type === 'file-start') {
        currentReceivingFile = incomingManifest.find(f => f.id === msg.id);
        receivedFileChunks = [];
        updateReceiverManifestStatus(msg.id, 'streaming');
      }
      else if (msg.type === 'file-end') {
        if (!currentReceivingFile) return;

        const blob = new Blob(receivedFileChunks, { type: currentReceivingFile.type });
        const url = URL.createObjectURL(blob);
        completedFiles.push({ name: currentReceivingFile.name, blob, url });

        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = currentReceivingFile.name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => document.body.removeChild(a), 500);

        updateReceiverManifestStatus(currentReceivingFile.id, 'complete');
        receivedFileChunks = [];
        currentReceivingFile = null;

        receiverBatchSubtitle.textContent = `${completedFiles.length} of ${incomingManifest.length} files downloaded`;
      }
      else if (msg.type === 'batch-complete') {
        finishReceiverBatchSuccess();
      }
      return;
    }

    const chunk = event.data;
    receivedFileChunks.push(chunk);

    const chunkSize = chunk.byteLength;
    totalBatchBytesTransferred += chunkSize;
    bytesTransferredLastInterval += chunkSize;

    updateReceiverMetricsUI(totalBatchBytesTransferred, totalBatchBytes);
  };
}

function updateReceiverMetricsUI(current, total) {
  if (!total || total === 0) return;
  const percent = Math.min(100, (current / total) * 100);
  receiverProgressBar.style.width = `${percent}%`;
  receiverPercentage.textContent = `${percent.toFixed(1)}%`;

  const now = Date.now();
  const delta = (now - lastSpeedCalcTime) / 1000;

  if (delta >= 0.8) {
    const currentSpeedMBps = (bytesTransferredLastInterval / (1024 * 1024)) / delta;
    bytesTransferredLastInterval = 0;
    lastSpeedCalcTime = now;

    speedSamples.push(currentSpeedMBps);
    if (speedSamples.length > SPEED_WINDOW_SIZE) speedSamples.shift();
    const avgSpeedMBps = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;

    receiverSpeedText.textContent = `${avgSpeedMBps.toFixed(2)} MB/s`;

    const remainingBytes = total - current;
    if (avgSpeedMBps > 0.05) {
      const remainingSeconds = remainingBytes / (avgSpeedMBps * 1024 * 1024);
      receiverEtaText.textContent = formatETA(remainingSeconds);
    } else {
      receiverEtaText.textContent = 'Calculating...';
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

function renderReceiverManifestUI(manifest) {
  receiverManifestList.innerHTML = manifest.map(item => `
    <li id="rcv-manifest-${item.id}" class="flex items-center justify-between bg-slate-900 border border-slate-800/80 px-2.5 py-1.5 rounded-lg">
      <div class="flex items-center gap-2 min-w-0 pr-2">
        ${getFileIcon(item.name, item.type)}
        <span class="truncate text-slate-300 font-medium">${item.name}</span>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="font-mono text-[10px] text-slate-500">${formatBytes(item.size)}</span>
        <span class="status-badge text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">queued</span>
      </div>
    </li>
  `).join('');
  lucide.createIcons();
}

function updateReceiverManifestStatus(fileId, status) {
  const row = document.getElementById(`rcv-manifest-${fileId}`);
  if (!row) return;

  const badge = row.querySelector('.status-badge');
  if (status === 'streaming') {
    badge.textContent = 'downloading';
    badge.className = 'status-badge text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 animate-pulse';
  } else if (status === 'complete') {
    badge.textContent = 'saved';
    badge.className = 'status-badge text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
  }
}

function finishReceiverBatchSuccess() {
  receiverProgressBar.style.width = '100%';
  receiverPercentage.textContent = '100%';
  receiverSpeedText.textContent = 'Done';
  receiverEtaText.textContent = '0s';

  receiverCompleteCard.classList.remove('hidden');

  downloadZipBtn.onclick = async () => {
    downloadZipBtn.disabled = true;
    downloadZipBtn.textContent = 'Generating .ZIP archive...';

    const zip = new JSZip();
    completedFiles.forEach(f => zip.file(f.name, f.blob));
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipUrl = URL.createObjectURL(zipBlob);

    const a = document.createElement('a');
    a.href = zipUrl;
    a.download = `DirectBeam_Batch_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    downloadZipBtn.disabled = false;
    downloadZipBtn.innerHTML = '<i data-lucide="archive" class="w-4 h-4"></i> Download All as .ZIP Archive';
    lucide.createIcons();
  };

  lucide.createIcons();
}

// ================= RESET STATE & TEARDOWN =================

function resetStateAndGoHome() {
  if (isHost && currentRoomId) {
    socket.emit('destroy-room', currentRoomId);
  }

  for (const [id, peer] of receiverPeers) {
    try { peer.dc?.close(); } catch (_) {}
    try { peer.pc?.close(); } catch (_) {}
  }
  receiverPeers.clear();

  if (receiverDC) {
    try { receiverDC.close(); } catch (_) {}
    receiverDC = null;
  }
  if (receiverPC) {
    try { receiverPC.close(); } catch (_) {}
    receiverPC = null;
  }

  fileQueue = [];
  currentRoomId = null;
  isHost = false;
  incomingManifest = [];
  currentReceivingFile = null;
  receivedFileChunks = [];
  completedFiles = [];

  manualCodeInput.value = '';
  fileInput.value = '';
  receiverCompleteCard.classList.add('hidden');
  window.history.replaceState({}, document.title, window.location.pathname);

  receiverView.classList.add('hidden');
  senderView.classList.add('hidden');
  selectionView.classList.remove('hidden');

  lucide.createIcons();
}

brandHomeLink.addEventListener('click', () => {
  if (isHost) {
    if (confirm('Leave and stop sharing?')) resetStateAndGoHome();
  } else {
    resetStateAndGoHome();
  }
});

navBeamBtn.addEventListener('click', () => {
  if (isHost) {
    senderView.classList.remove('hidden');
    selectionView.classList.add('hidden');
    receiverView.classList.add('hidden');
  } else {
    resetStateAndGoHome();
  }
});

cancelReceiverBtn.addEventListener('click', resetStateAndGoHome);

// ================= MODAL CONTROLLERS =================

function setupModal(modal, backdrop, openBtn, closeBtn) {
  function open() {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const content = modal.querySelector('div[id$="-content"]') || modal.querySelector('.relative');
    if (content) {
      requestAnimationFrame(() => {
        content.classList.remove('scale-95', 'opacity-0');
        content.classList.add('scale-100', 'opacity-100');
      });
    }
    lucide.createIcons();
  }

  function close() {
    const content = modal.querySelector('div[id$="-content"]') || modal.querySelector('.relative');
    if (content) {
      content.classList.remove('scale-100', 'opacity-100');
      content.classList.add('scale-95', 'opacity-0');
    }
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }, 200);
  }

  if (openBtn) openBtn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      close();
    }
  });
}

setupModal(founderModal, founderModalBackdrop, openFounderModalBtn, closeFounderModalBtn);
setupModal(founderModal, founderModalBackdrop, navFounderBtn, closeFounderModalBtn);
setupModal(faqModal, faqModalBackdrop, navFaqBtn, closeFaqModalBtn);
setupModal(securityModal, securityModalBackdrop, navSecurityBtn, closeSecurityModalBtn);

// ================= SOCIAL DOCK CLIPBOARD =================

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

if (modalCopyEmailBtn) {
  modalCopyEmailBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = modalCopyEmailBtn.getAttribute('data-email') || 'vishwanthmalla0324@gmail.com';

    try {
      await navigator.clipboard.writeText(email);
      if (modalEmailTooltip) {
        modalEmailTooltip.textContent = 'Copied!';
        modalEmailTooltip.classList.remove('opacity-0');
        modalEmailTooltip.classList.add('opacity-100', 'text-emerald-400', 'border-emerald-500/40');
        setTimeout(() => {
          modalEmailTooltip.textContent = 'Copy Email';
          modalEmailTooltip.classList.remove('text-emerald-400', 'border-emerald-500/40');
          modalEmailTooltip.classList.add('opacity-0');
        }, 1800);
      }
      showToast('Email address copied to clipboard');
    } catch (_) {
      showToast('Could not copy email');
    }
  });
}