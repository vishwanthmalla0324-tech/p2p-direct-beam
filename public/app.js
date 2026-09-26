// Socket.io initialization with automated reconnection
const socket = io({
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 2000,
  transports: ['websocket', 'polling']
});

// Cold-Start Watchdog for Render Free Tier
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

socket.on('disconnect', () => {
  if (isTransferring) {
    systemStatus.textContent = 'Signaling disconnect. P2P DataChannel still active.';
  }
});

// High-Performance WebRTC Pipeline Constants
const CHUNK_SIZE = 64 * 1024; // 64 KB wire chunks
const WRITE_BUFFER_SIZE = 2 * 1024 * 1024; // 2 MB batched disk write
const BUFFER_THRESHOLD = 8 * 1024 * 1024; // 8 MB backpressure threshold

// Application State
let selectedFile = null;
let currentRoomId = null;
let peerConnection = null;
let dataChannel = null;
let remotePeerId = null;
let isInitiator = false;
let isTransferring = false;

// Metrics & Rolling Average State
let bytesTransferredLastInterval = 0;
let lastSpeedCalcTime = Date.now();
const SPEED_WINDOW_SIZE = 5;
let speedSamples = [];

// Receiver Buffers
let fileWritableStream = null;
let incomingMetadata = null;
let receivedBytes = 0;
let diskWriteBuffer = [];
let diskWriteBufferSize = 0;
let isWritingToDisk = false;
let receivedChunksFallback = [];

// Camera Scanner
let html5QrScanner = null;
let availableCameras = [];
let activeCameraIndex = 0;

// High-Availability Multi-STUN Configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

// UI Element Bindings
const selectionView = document.getElementById('selection-view');
const senderView = document.getElementById('sender-view');
const transferView = document.getElementById('transfer-view');
const completeView = document.getElementById('complete-view');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const manualCodeInput = document.getElementById('manual-code-input');
const joinBtn = document.getElementById('join-btn');
const displayCode = document.getElementById('display-code');

const copyLinkBtn = document.getElementById('copy-link-btn');
const toggleQrBtn = document.getElementById('toggle-qr-btn');
const qrModalContainer = document.getElementById('qr-modal-container');
const qrcodeBox = document.getElementById('qrcode-box');

const progressBarFill = document.getElementById('progress-bar-fill');
const percentageText = document.getElementById('percentage-text');
const speedText = document.getElementById('speed-text');
const etaText = document.getElementById('eta-text');
const systemStatus = document.getElementById('system-status');
const senderStatusPill = document.getElementById('sender-status-pill');
const cancelTransferBtn = document.getElementById('cancel-transfer-btn');

// Navigation Elements
const brandHomeLink = document.getElementById('brand-home-link');
const navBackHomeBtn = document.getElementById('nav-back-home-btn');
const sendAnotherBtn = document.getElementById('send-another-btn');
const completeBackHomeBtn = document.getElementById('complete-back-home-btn');

// Scanner Elements
const scanQrBtn = document.getElementById('scan-qr-btn');
const scannerWrapper = document.getElementById('scanner-wrapper');
const closeScannerBtn = document.getElementById('close-scanner-btn');
const flipCameraBtn = document.getElementById('flip-camera-btn');

// Troubleshooting Modal Elements
const infoModal = document.getElementById('info-modal');
const openModalBtn = document.getElementById('open-modal-btn');
const closeModalBtn = document.getElementById('close-modal-btn');

// ================= UTILITIES & HELPERS =================

function updateNavState(activeViewId) {
  if (activeViewId === 'selection-view') {
    navBackHomeBtn.classList.add('hidden');
  } else {
    navBackHomeBtn.classList.remove('hidden');
  }
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

function playCompletionChime() {
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
}

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

function sendNativeNotification(filename) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Direct Beam Complete', {
      body: `Successfully transferred ${filename}`,
      icon: '/favicon.ico'
    });
  }
}

// Prevent Accidental Tab Closure During Active Transfer
window.addEventListener('beforeunload', (e) => {
  if (isTransferring) {
    e.preventDefault();
    e.returnValue = 'Direct streaming is in progress. Leaving will abort the transfer.';
  }
});

// Auto-Join when opening via ?room=XXXXXX URL
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const room = urlParams.get('room');
  if (room && room.length === 6) {
    manualCodeInput.value = room;
    initiateReceiver(room);
  }
});

// ================= FILE SELECTION =================

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
    handleFileSelected(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files?.length > 0) {
    handleFileSelected(e.target.files[0]);
  }
});

function handleFileSelected(file) {
  if (!file) return;
  selectedFile = file;
  isInitiator = true;
  currentRoomId = Math.floor(100000 + Math.random() * 900000).toString();

  document.getElementById('sender-file-name').textContent = file.name;
  document.getElementById('sender-file-size').textContent = formatBytes(file.size);
  displayCode.textContent = currentRoomId;

  // Render Canvas QR Code
  qrcodeBox.innerHTML = '';
  const shareUrl = `${window.location.origin}/?room=${currentRoomId}`;
  new QRCode(qrcodeBox, {
    text: shareUrl,
    width: 160,
    height: 160,
    colorDark: "#020617",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  selectionView.classList.add('hidden');
  senderView.classList.remove('hidden');
  updateNavState('sender-view');

  socket.emit('join-room', currentRoomId);
}

copyLinkBtn.addEventListener('click', () => {
  const shareUrl = `${window.location.origin}/?room=${currentRoomId}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('Share link copied to clipboard');
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
        showToast('Invalid QR Code');
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

joinBtn.addEventListener('click', () => {
  const code = manualCodeInput.value.trim();
  if (code.length === 6) {
    stopScanner();
    initiateReceiver(code);
  } else {
    showToast('Please enter a valid 6-digit key');
  }
});

function initiateReceiver(roomId) {
  currentRoomId = roomId;
  isInitiator = false;
  selectionView.classList.add('hidden');
  transferView.classList.remove('hidden');
  updateNavState('transfer-view');

  document.getElementById('transfer-role-text').textContent = 'Connecting...';
  systemStatus.textContent = 'Connecting via signaling server...';

  socket.emit('join-room', currentRoomId);
}

// ================= WEBRTC CONNECTION SETUP =================

socket.on('peer-joined', async (peerId) => {
  remotePeerId = peerId;
  senderStatusPill.textContent = 'Connecting...';
  senderStatusPill.className = 'text-[11px] font-mono px-2.5 py-1 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20';

  if (isInitiator) {
    createPeerConnection();
    dataChannel = peerConnection.createDataChannel('fileTransfer', { ordered: true });
    dataChannel.binaryType = 'arraybuffer';
    setupSenderDataChannel(dataChannel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', { target: peerId, sdp: offer });
  }
});

socket.on('offer', async ({ sender, sdp }) => {
  remotePeerId = sender;
  createPeerConnection();

  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('answer', { target: sender, sdp: answer });
});

socket.on('answer', async ({ sdp }) => {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', async ({ candidate }) => {
  if (candidate && peerConnection) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (_) {}
  }
});

socket.on('peer-disconnected', () => {
  if (isTransferring) {
    systemStatus.textContent = 'Peer disconnected unexpectedly.';
  }
});

function createPeerConnection() {
  if (peerConnection) return;

  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && remotePeerId) {
      socket.emit('ice-candidate', { target: remotePeerId, candidate: event.candidate });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'failed') {
      systemStatus.textContent = 'Direct connection disconnected or failed.';
      isTransferring = false;
    }
  };

  peerConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    dataChannel.binaryType = 'arraybuffer';
    setupReceiverDataChannel(dataChannel);
  };
}

// ================= DATA PIPELINE (SENDER) =================

function setupSenderDataChannel(channel) {
  channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

  channel.onopen = () => {
    isTransferring = true;
    senderView.classList.add('hidden');
    transferView.classList.remove('hidden');
    updateNavState('transfer-view');

    document.getElementById('transfer-role-text').textContent = 'Sending Payload';
    document.getElementById('transfer-file-name').textContent = selectedFile.name;
    document.getElementById('transfer-file-size').textContent = formatBytes(selectedFile.size);
    systemStatus.textContent = 'Direct P2P established. Streaming raw bytes...';

    channel.send(JSON.stringify({
      type: 'metadata',
      name: selectedFile.name,
      size: selectedFile.size
    }));

    streamFile();
  };
}

async function streamFile() {
  let offset = 0;
  const total = selectedFile.size;
  lastSpeedCalcTime = Date.now();
  bytesTransferredLastInterval = 0;
  speedSamples = [];

  function readNextChunk() {
    if (!isTransferring) return;

    if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
      dataChannel.onbufferedamountlow = () => {
        dataChannel.onbufferedamountlow = null;
        readNextChunk();
      };
      return;
    }

    if (offset < total) {
      const slice = selectedFile.slice(offset, offset + CHUNK_SIZE);
      const reader = new FileReader();

      reader.onload = (e) => {
        if (dataChannel.readyState !== 'open') return;

        dataChannel.send(e.target.result);
        const bytesRead = e.target.result.byteLength;
        offset += bytesRead;
        bytesTransferredLastInterval += bytesRead;

        updateMetricsUI(offset, total);
        readNextChunk();
      };

      reader.readAsArrayBuffer(slice);
    } else {
      dataChannel.send(JSON.stringify({ type: 'EOF' }));
      finishTransferSuccess(selectedFile.name);
    }
  }

  readNextChunk();
}

// ================= DATA PIPELINE (RECEIVER) =================

async function flushDiskBuffer() {
  if (diskWriteBuffer.length === 0 || !fileWritableStream || isWritingToDisk) return;
  isWritingToDisk = true;

  const chunks = diskWriteBuffer;
  diskWriteBuffer = [];
  diskWriteBufferSize = 0;

  try {
    const blob = new Blob(chunks);
    await fileWritableStream.write(blob);
  } catch (err) {
    console.error('Batched disk write error:', err);
  } finally {
    isWritingToDisk = false;
    if (diskWriteBufferSize >= WRITE_BUFFER_SIZE) {
      flushDiskBuffer();
    }
  }
}

function setupReceiverDataChannel(channel) {
  channel.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.type === 'metadata') {
        incomingMetadata = msg;
        receivedBytes = 0;
        diskWriteBuffer = [];
        diskWriteBufferSize = 0;
        receivedChunksFallback = [];
        speedSamples = [];
        bytesTransferredLastInterval = 0;
        lastSpeedCalcTime = Date.now();
        isTransferring = true;

        document.getElementById('transfer-role-text').textContent = 'Receiving Payload';
        document.getElementById('transfer-file-name').textContent = msg.name;
        document.getElementById('transfer-file-size').textContent = formatBytes(msg.size);

        if ('showSaveFilePicker' in window && window.isSecureContext) {
          try {
            const handle = await window.showSaveFilePicker({ suggestedName: msg.name });
            fileWritableStream = await handle.createWritable();
            systemStatus.textContent = 'Writing directly to disk (Zero-RAM batching)...';
          } catch (_) {
            fileWritableStream = null;
            systemStatus.textContent = 'Receiving into memory cache...';
          }
        } else {
          fileWritableStream = null;
          systemStatus.textContent = 'Receiving into memory cache...';
        }
      } else if (msg.type === 'EOF') {
        if (fileWritableStream) {
          while (isWritingToDisk) {
            await new Promise(r => setTimeout(r, 20));
          }
          if (diskWriteBuffer.length > 0) {
            await fileWritableStream.write(new Blob(diskWriteBuffer));
          }
          await fileWritableStream.close();
          finishTransferSuccess(incomingMetadata.name);
        } else {
          const blob = new Blob(receivedChunksFallback);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = incomingMetadata.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          const manualContainer = document.getElementById('manual-download-container');
          manualContainer.innerHTML = `
            <a href="${url}" download="${incomingMetadata.name}" class="text-xs text-cyan-400 hover:text-cyan-300 underline font-mono">
              Click to download again if download didn't trigger
            </a>`;
          manualContainer.classList.remove('hidden');

          finishTransferSuccess(incomingMetadata.name);
        }
      }
      return;
    }

    const chunkSize = event.data.byteLength;
    receivedBytes += chunkSize;
    bytesTransferredLastInterval += chunkSize;

    if (fileWritableStream) {
      diskWriteBuffer.push(event.data);
      diskWriteBufferSize += chunkSize;
      if (diskWriteBufferSize >= WRITE_BUFFER_SIZE && !isWritingToDisk) {
        flushDiskBuffer();
      }
    } else {
      receivedChunksFallback.push(event.data);
    }

    updateMetricsUI(receivedBytes, incomingMetadata.size);
  };
}

// ================= METRICS & TELEMETRY =================

function updateMetricsUI(current, total) {
  const percent = Math.min(100, ((current / total) * 100));
  progressBarFill.style.width = `${percent}%`;
  percentageText.textContent = `${percent.toFixed(1)}%`;

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

    const remainingBytes = total - current;
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

// ================= FINALIZE & RESET =================

function finishTransferSuccess(fileName) {
  isTransferring = false;
  transferView.classList.add('hidden');
  completeView.classList.remove('hidden');
  updateNavState('complete-view');

  document.getElementById('complete-details').textContent =
    `"${fileName}" was transferred and finalized successfully.`;

  playCompletionChime();
  sendNativeNotification(fileName);
  lucide.createIcons();
}

function resetApplicationState(confirmIfBusy = false) {
  if (confirmIfBusy && isTransferring) {
    const proceed = confirm('A file transfer is actively in progress. Returning home will cancel it. Continue?');
    if (!proceed) return;
  }

  // 1. Terminate DataChannel
  if (dataChannel) {
    try {
      dataChannel.onclose = null;
      dataChannel.close();
    } catch (_) {}
    dataChannel = null;
  }

  // 2. Terminate Peer Connection
  if (peerConnection) {
    try {
      peerConnection.onicecandidate = null;
      peerConnection.ondatachannel = null;
      peerConnection.close();
    } catch (_) {}
    peerConnection = null;
  }

  // 3. Abort disk stream if open
  if (fileWritableStream) {
    try {
      fileWritableStream.abort();
    } catch (_) {}
    fileWritableStream = null;
  }

  // 4. Notify signaling server to leave room
  if (currentRoomId && socket.connected) {
    socket.emit('leave-room', currentRoomId);
  }

  // 5. Clear application state
  selectedFile = null;
  currentRoomId = null;
  remotePeerId = null;
  isInitiator = false;
  isTransferring = false;
  incomingMetadata = null;
  receivedBytes = 0;
  diskWriteBuffer = [];
  diskWriteBufferSize = 0;
  receivedChunksFallback = [];
  speedSamples = [];

  // 6. Reset UI progress & metric indicators
  progressBarFill.style.width = '0%';
  percentageText.textContent = '0.0%';
  speedText.textContent = '0.00 MB/s';
  etaText.textContent = 'Calculating...';
  manualCodeInput.value = '';
  fileInput.value = '';

  const manualContainer = document.getElementById('manual-download-container');
  if (manualContainer) manualContainer.classList.add('hidden');

  // 7. Clean up the URL query parameters without reloading the page
  window.history.replaceState({}, document.title, window.location.pathname);

  // 8. Restore views
  completeView.classList.add('hidden');
  transferView.classList.add('hidden');
  senderView.classList.add('hidden');
  selectionView.classList.remove('hidden');

  updateNavState('selection-view');
  lucide.createIcons();
}

// Navigation event bindings
brandHomeLink.addEventListener('click', () => resetApplicationState(true));
navBackHomeBtn.addEventListener('click', () => resetApplicationState(true));

if (sendAnotherBtn) {
  sendAnotherBtn.addEventListener('click', () => {
    resetApplicationState(false);
    fileInput.click();
  });
}

if (completeBackHomeBtn) {
  completeBackHomeBtn.addEventListener('click', () => {
    resetApplicationState(false);
  });
}

cancelTransferBtn.addEventListener('click', () => {
  resetApplicationState(true);
});

// Troubleshooting Modal
openModalBtn.addEventListener('click', () => {
  infoModal.classList.remove('hidden');
  infoModal.classList.add('flex');
});

closeModalBtn.addEventListener('click', () => {
  infoModal.classList.add('hidden');
  infoModal.classList.remove('flex');
});