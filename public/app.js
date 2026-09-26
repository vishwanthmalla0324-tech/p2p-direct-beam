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

socket.on('disconnect', () => {
  if (isTransferring) {
    systemStatus.textContent = 'Signaling disconnect. Direct P2P channels active.';
  }
});

const CHUNK_SIZE = 64 * 1024;
const WRITE_BUFFER_SIZE = 2 * 1024 * 1024;
const BUFFER_THRESHOLD = 8 * 1024 * 1024;

// Application State
let selectedFile = null;
let currentRoomId = null;
let isInitiator = false;
let isTransferring = false;

// Multi-Peer Connection Map: peerId -> { pc: RTCPeerConnection, dc: RTCDataChannel, status: string }
const peers = new Map();

// Receiver specific states (when this client is a receiver)
let receiverPeerConnection = null;
let receiverDataChannel = null;
let fileWritableStream = null;
let incomingMetadata = null;
let receivedBytes = 0;
let diskWriteBuffer = [];
let diskWriteBufferSize = 0;
let isWritingToDisk = false;
let receivedChunksFallback = [];

// Metrics & Rolling Calculation
let bytesTransferredLastInterval = 0;
let lastSpeedCalcTime = Date.now();
const SPEED_WINDOW_SIZE = 5;
let speedSamples = [];

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

// UI Elements
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
const startBroadcastBtn = document.getElementById('start-broadcast-btn');
const activeDevicesPill = document.getElementById('active-devices-pill');

const progressBarFill = document.getElementById('progress-bar-fill');
const percentageText = document.getElementById('percentage-text');
const speedText = document.getElementById('speed-text');
const etaText = document.getElementById('eta-text');
const systemStatus = document.getElementById('system-status');
const senderStatusPill = document.getElementById('sender-status-pill');
const cancelTransferBtn = document.getElementById('cancel-transfer-btn');

const brandHomeLink = document.getElementById('brand-home-link');
const navBackHomeBtn = document.getElementById('nav-back-home-btn');
const sendAnotherBtn = document.getElementById('send-another-btn');
const completeBackHomeBtn = document.getElementById('complete-back-home-btn');

const scanQrBtn = document.getElementById('scan-qr-btn');
const scannerWrapper = document.getElementById('scanner-wrapper');
const closeScannerBtn = document.getElementById('close-scanner-btn');
const flipCameraBtn = document.getElementById('flip-camera-btn');

const infoModal = document.getElementById('info-modal');
const openModalBtn = document.getElementById('open-modal-btn');
const closeModalBtn = document.getElementById('close-modal-btn');

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

window.addEventListener('beforeunload', (e) => {
  if (isTransferring) {
    e.preventDefault();
    e.returnValue = 'Direct streaming in progress. Leaving will abort the transfer.';
  }
});

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

// SENDER: Start Broadcast Button
startBroadcastBtn.addEventListener('click', () => {
  if (getReadyDataChannels().length === 0) return;
  startBroadcasting();
});

function updateSenderPeerCountUI() {
  const count = peers.size;
  senderStatusPill.textContent = `${count} Device${count === 1 ? '' : 's'} Connected`;
  
  if (count > 0) {
    senderStatusPill.className = 'text-[11px] font-mono px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 whitespace-nowrap';
    startBroadcastBtn.disabled = false;
    startBroadcastBtn.textContent = `Beam File to ${count} Device${count === 1 ? '' : 's'}`;
  } else {
    senderStatusPill.className = 'text-[11px] font-mono px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 whitespace-nowrap';
    startBroadcastBtn.disabled = true;
    startBroadcastBtn.textContent = 'Waiting for Devices to Join...';
  }
}

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

  document.getElementById('transfer-role-text').textContent = 'Receiver Standby';
  activeDevicesPill.textContent = 'P2P Connected';
  systemStatus.textContent = 'Waiting for sender to start broadcast...';

  socket.emit('join-room', currentRoomId);
}

// ================= MULTI-PEER WEBRTC PIPELINE =================

// Triggered when a new device enters the room
socket.on('peer-joined', async (peerId) => {
  if (isInitiator) {
    // Setup dedicated RTCPeerConnection for this new device
    const pc = new RTCPeerConnection(rtcConfig);
    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

    peers.set(peerId, { pc, dc, status: 'connecting' });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { target: peerId, candidate: event.candidate });
      }
    };

    dc.onopen = () => {
      if (peers.has(peerId)) {
        peers.get(peerId).status = 'open';
      }
      updateSenderPeerCountUI();

      // If a broadcast is already underway when this peer joins, send metadata and catch them up
      if (isTransferring) {
        dc.send(JSON.stringify({
          type: 'metadata',
          name: selectedFile.name,
          size: selectedFile.size
        }));
      }
    };

    dc.onclose = () => {
      peers.delete(peerId);
      updateSenderPeerCountUI();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { target: peerId, sdp: offer });

    updateSenderPeerCountUI();
  }
});

// Receiver receives offer from sender
socket.on('offer', async ({ sender, sdp }) => {
  if (!isInitiator) {
    receiverPeerConnection = new RTCPeerConnection(rtcConfig);

    receiverPeerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { target: sender, candidate: event.candidate });
      }
    };

    receiverPeerConnection.ondatachannel = (event) => {
      receiverDataChannel = event.channel;
      receiverDataChannel.binaryType = 'arraybuffer';
      setupReceiverDataChannel(receiverDataChannel);
    };

    await receiverPeerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await receiverPeerConnection.createAnswer();
    await receiverPeerConnection.setLocalDescription(answer);

    socket.emit('answer', { target: sender, sdp: answer });
  }
});

// Sender receives answer from specific receiver
socket.on('answer', async ({ sender, sdp }) => {
  if (isInitiator && peers.has(sender)) {
    const peer = peers.get(sender);
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

socket.on('ice-candidate', async ({ sender, candidate }) => {
  if (candidate) {
    try {
      if (isInitiator && peers.has(sender)) {
        await peers.get(sender).pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else if (!isInitiator && receiverPeerConnection) {
        await receiverPeerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (_) {}
  }
});

socket.on('peer-disconnected', (peerId) => {
  if (isInitiator && peers.has(peerId)) {
    const p = peers.get(peerId);
    try { p.dc.close(); } catch (_) {}
    try { p.pc.close(); } catch (_) {}
    peers.delete(peerId);
    updateSenderPeerCountUI();
  }
});

function getReadyDataChannels() {
  const readyChannels = [];
  for (const [_, p] of peers) {
    if (p.dc && p.dc.readyState === 'open') {
      readyChannels.push(p.dc);
    }
  }
  return readyChannels;
}

// ================= MULTI-DEVICE BROADCAST ENGINE =================

function startBroadcasting() {
  const openChannels = getReadyDataChannels();
  if (openChannels.length === 0) {
    showToast('No active peer connections open');
    return;
  }

  isTransferring = true;
  senderView.classList.add('hidden');
  transferView.classList.remove('hidden');
  updateNavState('transfer-view');

  const count = openChannels.length;
  document.getElementById('transfer-role-text').textContent = 'Broadcasting Payload';
  activeDevicesPill.textContent = `${count} Device${count === 1 ? '' : 's'}`;
  document.getElementById('transfer-file-name').textContent = selectedFile.name;
  document.getElementById('transfer-file-size').textContent = formatBytes(selectedFile.size);
  systemStatus.textContent = `Streaming to ${count} device${count === 1 ? '' : 's'} via direct DataChannels...`;

  // Send metadata header to all peers
  const metaMsg = JSON.stringify({
    type: 'metadata',
    name: selectedFile.name,
    size: selectedFile.size
  });
  openChannels.forEach(dc => dc.send(metaMsg));

  streamMultiDeviceFile();
}

async function streamMultiDeviceFile() {
  let offset = 0;
  const total = selectedFile.size;
  lastSpeedCalcTime = Date.now();
  bytesTransferredLastInterval = 0;
  speedSamples = [];

  function readNextChunk() {
    if (!isTransferring) return;

    const channels = getReadyDataChannels();
    if (channels.length === 0) {
      systemStatus.textContent = 'All receivers disconnected.';
      isTransferring = false;
      return;
    }

    // Backpressure check across all connected devices
    let isSaturated = false;
    for (const ch of channels) {
      if (ch.bufferedAmount > BUFFER_THRESHOLD) {
        isSaturated = true;
        ch.onbufferedamountlow = () => {
          ch.onbufferedamountlow = null;
          readNextChunk();
        };
        break;
      }
    }
    if (isSaturated) return;

    if (offset < total) {
      const slice = selectedFile.slice(offset, offset + CHUNK_SIZE);
      const reader = new FileReader();

      reader.onload = (e) => {
        if (!isTransferring) return;

        const buffer = e.target.result;
        // Fan out this slice to every device simultaneously
        channels.forEach(ch => {
          if (ch.readyState === 'open') {
            ch.send(buffer);
          }
        });

        const bytesRead = buffer.byteLength;
        offset += bytesRead;
        bytesTransferredLastInterval += bytesRead;

        updateMetricsUI(offset, total);
        readNextChunk();
      };

      reader.readAsArrayBuffer(slice);
    } else {
      channels.forEach(ch => {
        if (ch.readyState === 'open') {
          ch.send(JSON.stringify({ type: 'EOF' }));
        }
      });
      finishTransferSuccess(selectedFile.name);
    }
  }

  readNextChunk();
}

// ================= DATA RECEIVER PIPELINE =================

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
    `"${fileName}" was transferred and finalized successfully across all devices.`;

  playCompletionChime();
  sendNativeNotification(fileName);
  lucide.createIcons();
}

function resetApplicationState(confirmIfBusy = false) {
  if (confirmIfBusy && isTransferring) {
    const proceed = confirm('A transfer is active across one or more devices. Returning home will terminate it. Continue?');
    if (!proceed) return;
  }

  // 1. Close all multi-peer connections
  for (const [id, p] of peers) {
    try { p.dc?.close(); } catch (_) {}
    try { p.pc?.close(); } catch (_) {}
  }
  peers.clear();

  // 2. Close receiver connection
  if (receiverDataChannel) {
    try { receiverDataChannel.close(); } catch (_) {}
    receiverDataChannel = null;
  }
  if (receiverPeerConnection) {
    try { receiverPeerConnection.close(); } catch (_) {}
    receiverPeerConnection = null;
  }

  // 3. Abort disk stream
  if (fileWritableStream) {
    try { fileWritableStream.abort(); } catch (_) {}
    fileWritableStream = null;
  }

  // 4. Notify signaling server to exit room
  if (currentRoomId && socket.connected) {
    socket.emit('leave-room', currentRoomId);
  }

  selectedFile = null;
  currentRoomId = null;
  isInitiator = false;
  isTransferring = false;
  incomingMetadata = null;
  receivedBytes = 0;
  diskWriteBuffer = [];
  diskWriteBufferSize = 0;
  receivedChunksFallback = [];
  speedSamples = [];

  progressBarFill.style.width = '0%';
  percentageText.textContent = '0.0%';
  speedText.textContent = '0.00 MB/s';
  etaText.textContent = 'Calculating...';
  manualCodeInput.value = '';
  fileInput.value = '';

  const manualContainer = document.getElementById('manual-download-container');
  if (manualContainer) manualContainer.classList.add('hidden');

  window.history.replaceState({}, document.title, window.location.pathname);

  completeView.classList.add('hidden');
  transferView.classList.add('hidden');
  senderView.classList.add('hidden');
  selectionView.classList.remove('hidden');

  updateNavState('selection-view');
  lucide.createIcons();
}

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

openModalBtn.addEventListener('click', () => {
  infoModal.classList.remove('hidden');
  infoModal.classList.add('flex');
});

closeModalBtn.addEventListener('click', () => {
  infoModal.classList.add('hidden');
  infoModal.classList.remove('flex');
});