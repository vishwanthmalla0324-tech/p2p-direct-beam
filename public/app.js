const socket = io();

// High-Throughput Constants
const CHUNK_SIZE = 64 * 1024; // 64 KB slices over wire
const WRITE_BUFFER_SIZE = 2 * 1024 * 1024; // 2 MB batched disk write
const BUFFER_THRESHOLD = 8 * 1024 * 1024; // 8 MB sender backpressure limit

let selectedFile = null;
let currentRoomId = null;
let peerConnection = null;
let dataChannel = null;
let remotePeerId = null;
let isInitiator = false;

// Receiver State
let fileWritableStream = null;
let incomingMetadata = null;
let receivedBytes = 0;
let diskWriteBuffer = [];
let diskWriteBufferSize = 0;
let isWritingToDisk = false;
let receivedChunksFallback = [];

let bytesTransferredLastSec = 0;
let lastSpeedCalcTime = Date.now();

// Scanner State
let html5QrScanner = null;
let availableCameras = [];
let activeCameraIndex = 0;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// UI Elements
const selectionView = document.getElementById('selection-view');
const senderView = document.getElementById('sender-view');
const transferView = document.getElementById('transfer-view');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const manualCodeInput = document.getElementById('manual-code-input');
const joinBtn = document.getElementById('join-btn');
const displayCode = document.getElementById('display-code');
const qrCodeContainer = document.getElementById('qrcode');
const progressBarFill = document.getElementById('progress-bar-fill');
const percentageText = document.getElementById('percentage-text');
const speedText = document.getElementById('speed-text');
const systemStatus = document.getElementById('system-status');
const transferStatusText = document.getElementById('transfer-status-text');

// Scanner Controls
const scanQrBtn = document.getElementById('scan-qr-btn');
const scannerWrapper = document.getElementById('scanner-wrapper');
const closeScannerBtn = document.getElementById('close-scanner-btn');
const flipCameraBtn = document.getElementById('flip-camera-btn');

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room');
  if (roomFromUrl) {
    manualCodeInput.value = roomFromUrl;
    initiateReceiver(roomFromUrl);
  }
});

// Dropzone & File Pickers
dropZone.addEventListener('click', (e) => {
  if (e.target !== fileInput) {
    fileInput.click();
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    handleFileSelected(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    handleFileSelected(e.target.files[0]);
  }
});

function handleFileSelected(file) {
  try {
    if (!file) return;
    selectedFile = file;
    isInitiator = true;
    currentRoomId = Math.floor(100000 + Math.random() * 900000).toString();

    document.getElementById('sender-file-name').textContent = file.name;
    document.getElementById('sender-file-size').textContent = formatBytes(file.size);
    displayCode.textContent = currentRoomId;

    qrCodeContainer.innerHTML = '';
    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(currentRoomId)}`;
    img.width = 160;
    img.height = 160;
    img.style.display = 'block';
    qrCodeContainer.appendChild(img);

    selectionView.classList.add('hidden');
    senderView.classList.remove('hidden');

    socket.emit('join-room', currentRoomId);
  } catch (err) {
    alert("Error selecting file: " + err.message);
  }
}

// Camera Scanner Setup
scanQrBtn.addEventListener('click', async () => {
  scannerWrapper.classList.remove('hidden');

  try {
    availableCameras = await Html5Qrcode.getCameras();
    if (!availableCameras || availableCameras.length === 0) {
      alert("No camera found on this device.");
      stopScanner();
      return;
    }

    if (availableCameras.length <= 1) {
      flipCameraBtn.style.display = 'none';
    } else {
      flipCameraBtn.style.display = 'flex';
    }

    activeCameraIndex = availableCameras.length > 1 ? availableCameras.length - 1 : 0;
    startSelectedCamera();
  } catch (err) {
    alert("Camera unavailable: " + err);
    stopScanner();
  }
});

flipCameraBtn.addEventListener('click', async () => {
  if (availableCameras.length <= 1) return;
  activeCameraIndex = (activeCameraIndex + 1) % availableCameras.length;
  await startSelectedCamera();
});

async function startSelectedCamera() {
  if (html5QrScanner) {
    try { await html5QrScanner.stop(); } catch (_) {}
  }

  const cameraId = availableCameras[activeCameraIndex].id;
  html5QrScanner = new Html5Qrcode("qr-reader");

  const config = { fps: 15, qrbox: { width: 220, height: 220 }, aspectRatio: 1.0 };

  try {
    await html5QrScanner.start(
      cameraId,
      config,
      (decodedText) => {
        stopScanner();

        let code = decodedText.trim();
        const match = code.match(/\b\d{6}\b/);
        if (match) code = match[0];

        if (code.length === 6) {
          manualCodeInput.value = code;
          initiateReceiver(code);
        } else {
          alert(`Scanned: ${decodedText}. Please enter 6-digit code manually.`);
        }
      },
      () => {}
    );
  } catch (e) {
    console.error("Camera start failure:", e);
  }
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
    alert('Please enter a valid 6-digit code');
  }
});

function initiateReceiver(roomId) {
  currentRoomId = roomId;
  isInitiator = false;
  selectionView.classList.add('hidden');
  transferView.classList.remove('hidden');
  systemStatus.textContent = 'Contacting sender...';

  socket.emit('join-room', currentRoomId);
}

// WebRTC Signaling
socket.on('peer-joined', async (peerId) => {
  remotePeerId = peerId;
  systemStatus.textContent = 'Peer detected. Setting up connection...';

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
    } catch (e) {
      console.error('ICE candidate error', e);
    }
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
    systemStatus.textContent = `Connection: ${peerConnection.iceConnectionState}`;
  };

  peerConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    dataChannel.binaryType = 'arraybuffer';
    setupReceiverDataChannel(dataChannel);
  };
}

function setupSenderDataChannel(channel) {
  channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

  channel.onopen = () => {
    senderView.classList.add('hidden');
    transferView.classList.remove('hidden');
    transferStatusText.textContent = 'Sending File...';
    document.getElementById('transfer-file-name').textContent = selectedFile.name;
    document.getElementById('transfer-file-size').textContent = formatBytes(selectedFile.size);
    systemStatus.textContent = 'Direct pipe open. Transferring...';

    const metadata = JSON.stringify({
      type: 'metadata',
      name: selectedFile.name,
      size: selectedFile.size
    });
    channel.send(metadata);

    streamFileChunks();
  };
}

async function streamFileChunks() {
  let offset = 0;
  const totalSize = selectedFile.size;
  lastSpeedCalcTime = Date.now();
  bytesTransferredLastSec = 0;

  function readNextChunk() {
    if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
      dataChannel.onbufferedamountlow = () => {
        dataChannel.onbufferedamountlow = null;
        readNextChunk();
      };
      return;
    }

    if (offset < totalSize) {
      const slice = selectedFile.slice(offset, offset + CHUNK_SIZE);
      const reader = new FileReader();

      reader.onload = (e) => {
        if (dataChannel.readyState !== 'open') return;

        dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        bytesTransferredLastSec += e.target.result.byteLength;

        updateProgressUI(offset, totalSize);
        readNextChunk();
      };

      reader.readAsArrayBuffer(slice);
    } else {
      dataChannel.send(JSON.stringify({ type: 'EOF' }));
      transferStatusText.textContent = 'Transfer Complete!';
      systemStatus.textContent = 'All bytes sent successfully.';
    }
  }

  readNextChunk();
}

async function flushDiskBuffer() {
  if (diskWriteBuffer.length === 0 || !fileWritableStream || isWritingToDisk) return;
  isWritingToDisk = true;

  const chunksToWrite = diskWriteBuffer;
  diskWriteBuffer = [];
  diskWriteBufferSize = 0;

  try {
    const combinedBlob = new Blob(chunksToWrite);
    await fileWritableStream.write(combinedBlob);
  } catch (err) {
    console.error("Disk write error:", err);
  } finally {
    isWritingToDisk = false;
    if (diskWriteBuffer.length >= WRITE_BUFFER_SIZE) {
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
        document.getElementById('transfer-file-name').textContent = msg.name;
        document.getElementById('transfer-file-size').textContent = formatBytes(msg.size);
        transferStatusText.textContent = 'Receiving File...';

        if ('showSaveFilePicker' in window && window.isSecureContext) {
          try {
            const handle = await window.showSaveFilePicker({ suggestedName: msg.name });
            fileWritableStream = await handle.createWritable();
            systemStatus.textContent = 'Streaming direct to disk (Batched I/O)...';
          } catch (err) {
            fileWritableStream = null;
            systemStatus.textContent = 'Receiving file into memory cache...';
          }
        } else {
          fileWritableStream = null;
          systemStatus.textContent = 'Receiving file into memory cache...';
        }

        lastSpeedCalcTime = Date.now();
      } else if (msg.type === 'EOF') {
        if (fileWritableStream) {
          while (isWritingToDisk) {
            await new Promise(res => setTimeout(res, 20));
          }
          if (diskWriteBuffer.length > 0) {
            const combinedBlob = new Blob(diskWriteBuffer);
            await fileWritableStream.write(combinedBlob);
          }
          await fileWritableStream.close();
          transferStatusText.textContent = 'Transfer Complete!';
          systemStatus.textContent = 'File saved directly to disk.';
        } else {
          const blob = new Blob(receivedChunksFallback);
          const downloadUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = incomingMetadata.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          transferStatusText.textContent = 'Transfer Complete!';
          systemStatus.innerHTML = `File downloaded to your Downloads folder! <br><a href="${downloadUrl}" download="${incomingMetadata.name}" style="color:var(--accent); text-decoration:underline; font-weight:bold; display:inline-block; margin-top:8px;">Click here if download didn't start</a>`;
        }
      }
      return;
    }

    const chunkSize = event.data.byteLength;
    receivedBytes += chunkSize;
    bytesTransferredLastSec += chunkSize;

    if (fileWritableStream) {
      diskWriteBuffer.push(event.data);
      diskWriteBufferSize += chunkSize;

      if (diskWriteBufferSize >= WRITE_BUFFER_SIZE && !isWritingToDisk) {
        flushDiskBuffer();
      }
    } else {
      receivedChunksFallback.push(event.data);
    }

    updateProgressUI(receivedBytes, incomingMetadata.size);
  };
}

function updateProgressUI(current, total) {
  const percentage = Math.min(100, ((current / total) * 100)).toFixed(1);
  progressBarFill.style.width = `${percentage}%`;
  percentageText.textContent = `${percentage}%`;

  const now = Date.now();
  const timeDelta = (now - lastSpeedCalcTime) / 1000;

  if (timeDelta >= 1) {
    const speedMBps = (bytesTransferredLastSec / (1024 * 1024)) / timeDelta;
    speedText.textContent = `${speedMBps.toFixed(2)} MB/s`;
    bytesTransferredLastSec = 0;
    lastSpeedCalcTime = now;
  }
}