import * as THREE from 'three';

/**
 * DIRECT BEAM — 3D WebGL P2P Data Beam Visualizer
 * Renders two floating glowing peer nodes and an energetic dynamic particle stream
 * along a 3D bezier spline curve with cyan/indigo additive blending.
 */

(() => {
  'use strict';

  const container = document.getElementById('beam-container');
  if (!container) return;

  // --- Configuration Constants ---
  const PARTICLE_COUNT = 240;
  const IDLE_SPEED = 0.0035;
  const ACTIVE_SPEED = 0.016;

  let isBeamActive = false;
  let currentSpeedMultiplier = IDLE_SPEED;
  let targetSpeedMultiplier = IDLE_SPEED;

  // --- Scene, Camera, Renderer ---
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    42,
    container.clientWidth / (container.clientHeight || 240),
    0.1,
    100
  );
  camera.position.set(0, -0.1, 7.6);

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight || 240);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  // Position canvas inside container
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.pointerEvents = 'auto';

  // --- Ambient & Point Lights ---
  const ambientLight = new THREE.AmbientLight(0x0f172a, 1.5);
  scene.add(ambientLight);

  const cyanLight = new THREE.PointLight(0x06b6d4, 3.5, 12);
  cyanLight.position.set(-2.8, 0.5, 1.5);
  scene.add(cyanLight);

  const indigoLight = new THREE.PointLight(0x6366f1, 3.5, 12);
  indigoLight.position.set(2.8, 0.5, 1.5);
  scene.add(indigoLight);

  // --- Procedural Glowing Particle Texture ---
  function createParticleTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.2, 'rgba(34, 211, 238, 0.95)'); // Cyan core
    grad.addColorStop(0.55, 'rgba(99, 102, 241, 0.45)'); // Indigo halo
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  }

  const particleTexture = createParticleTexture();

  // --- Helper to Create Glowing Peer Nodes ---
  function createPeerNode(colorHex, haloHex, posX) {
    const group = new THREE.Group();
    group.position.x = posX;

    // 1. Core Sphere
    const coreGeo = new THREE.SphereGeometry(0.48, 32, 32);
    const coreMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0.8,
      roughness: 0.15,
      metalness: 0.85
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    group.add(coreMesh);

    // 2. Outer Glowing Aura
    const haloGeo = new THREE.SphereGeometry(0.68, 32, 32);
    const haloMat = new THREE.MeshBasicMaterial({
      color: haloHex,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide
    });
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    group.add(haloMesh);

    // 3. Orbiting Gyro Rings
    const ringGeo = new THREE.TorusGeometry(0.78, 0.016, 16, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending
    });
    const ring1 = new THREE.Mesh(ringGeo, ringMat);
    ring1.rotation.x = Math.PI / 3;
    group.add(ring1);

    const ring2 = new THREE.Mesh(ringGeo, ringMat);
    ring2.rotation.y = Math.PI / 2.5;
    group.add(ring2);

    scene.add(group);
    return { group, coreMesh, haloMesh, ring1, ring2, initialX: posX };
  }

  // Node A: Local Host (Left, Cyan)
  const nodeA = createPeerNode(0x06b6d4, 0x22d3ee, -2.6);
  // Node B: Remote Peer (Right, Indigo)
  const nodeB = createPeerNode(0x6366f1, 0x818cf8, 2.6);

  // --- Dynamic Particle Beam System ---
  const particleGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  const sizes = new Float32Array(PARTICLE_COUNT);

  // Per-particle state
  const particleData = [];
  const colorCyan = new THREE.Color(0x22d3ee);
  const colorIndigo = new THREE.Color(0x818cf8);
  const tempColor = new THREE.Color();

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const t = i / PARTICLE_COUNT; // Initial progress along beam
    particleData.push({
      t: t,
      speedRate: 0.8 + Math.random() * 0.4,
      radius: 0.08 + Math.random() * 0.16,
      angle: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 4
    });

    // Color gradient from Node A (cyan) to Node B (indigo)
    tempColor.copy(colorCyan).lerp(colorIndigo, t);
    colors[i * 3] = tempColor.r;
    colors[i * 3 + 1] = tempColor.g;
    colors[i * 3 + 2] = tempColor.b;

    sizes[i] = 16 + Math.random() * 14;
  }

  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  particleGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const particleMat = new THREE.PointsMaterial({
    size: 0.35,
    map: particleTexture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true
  });

  const particleSystem = new THREE.Points(particleGeo, particleMat);
  scene.add(particleSystem);

  // --- Subtle Guide Conduit Line ---
  const lineCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.6, 0, 0),
    new THREE.Vector3(0, 0.2, 0),
    new THREE.Vector3(2.6, 0, 0)
  ]);
  const linePoints = lineCurve.getPoints(50);
  const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x06b6d4,
    transparent: true,
    opacity: 0.2,
    blending: THREE.AdditiveBlending
  });
  const guideLine = new THREE.Line(lineGeo, lineMat);
  scene.add(guideLine);

  // --- Background Starfield ---
  const starGeo = new THREE.BufferGeometry();
  const starPositions = new Float32Array(120 * 3);
  for (let i = 0; i < 120 * 3; i += 3) {
    starPositions[i] = (Math.random() - 0.5) * 14;
    starPositions[i + 1] = (Math.random() - 0.5) * 8;
    starPositions[i + 2] = -2 - Math.random() * 6;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsMaterial({
    size: 0.08,
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending
  });
  const starField = new THREE.Points(starGeo, starMat);
  scene.add(starField);

  // --- Interactive Mouse / Touch Camera Tilt ---
  let targetRotX = 0;
  let targetRotY = 0;

  function onPointerMove(e) {
    const rect = container.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const x = (clientX - rect.left) / rect.width - 0.5;
    const y = (clientY - rect.top) / rect.height - 0.5;

    targetRotY = x * 0.35;
    targetRotX = -y * 0.25;
  }

  function onPointerLeave() {
    targetRotX = 0;
    targetRotY = 0;
  }

  container.addEventListener('mousemove', onPointerMove);
  container.addEventListener('mouseleave', onPointerLeave);
  container.addEventListener('touchmove', onPointerMove, { passive: true });
  container.addEventListener('touchend', onPointerLeave);

  // --- Resize Handler ---
  function onResize() {
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight || 240;

    camera.aspect = width / height;
    // Adjust camera distance for small screens so both nodes remain fully visible
    if (width < 480) {
      camera.position.z = 9.4;
      camera.position.y = -0.05;
    } else if (width < 640) {
      camera.position.z = 8.4;
      camera.position.y = -0.08;
    } else {
      camera.position.z = 7.6;
      camera.position.y = -0.1;
    }
    camera.updateProjectionMatrix();

    renderer.setSize(width, height);
  }

  window.addEventListener('resize', onResize);
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(container);
  onResize();

  // --- Global Control API ---
  window.setBeamActive = function(active) {
    isBeamActive = !!active;
    targetSpeedMultiplier = isBeamActive ? ACTIVE_SPEED : IDLE_SPEED;

    // Update status dot and badge text
    const statusDot = document.getElementById('beam-status-dot');
    const statusText = document.getElementById('beam-status-text');

    if (statusDot && statusText) {
      if (isBeamActive) {
        statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-ping';
        statusText.textContent = 'STREAMING P2P';
        statusText.className = 'text-emerald-400 font-semibold';
      } else {
        statusDot.className = 'w-2 h-2 rounded-full bg-cyan-400 animate-pulse';
        statusText.textContent = 'MESH READY';
        statusText.className = 'text-cyan-400 font-semibold';
      }
    }
  };

  window.updateBeamTelemetry = function({ speed, latency, protocol, packetLoss, roomCode, status }) {
    if (speed !== undefined) {
      const speedEl = document.getElementById('telemetry-speed');
      const speedBar = document.getElementById('telemetry-speed-bar');
      if (speedEl) speedEl.textContent = speed;
      if (speedBar) {
        const numSpeed = parseFloat(speed) || 0;
        const pct = Math.min(100, (numSpeed / 50) * 100);
        speedBar.style.width = `${pct}%`;
      }
    }

    if (roomCode) {
      const roomText = document.getElementById('beam-room-text');
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

  // --- Animation Loop ---
  let clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const time = clock.getElapsedTime();

    // Smooth speed multiplier transition
    currentSpeedMultiplier += (targetSpeedMultiplier - currentSpeedMultiplier) * 0.08;

    // Camera tilt smoothing
    camera.rotation.y += (targetRotY - camera.rotation.y) * 0.06;
    camera.rotation.x += (targetRotX - camera.rotation.x) * 0.06;

    // Node A (Local Host) floating & ring spinning
    nodeA.group.position.y = Math.sin(time * 1.6) * 0.12;
    nodeA.ring1.rotation.z += 0.015;
    nodeA.ring2.rotation.x += 0.012;

    // Node B (Remote Peer) floating & ring spinning
    nodeB.group.position.y = Math.cos(time * 1.4) * 0.12;
    nodeB.ring1.rotation.z -= 0.015;
    nodeB.ring2.rotation.y += 0.012;

    // Dynamic Central Spline Curve with organic wave
    const waveY = Math.sin(time * 2.2) * (isBeamActive ? 0.35 : 0.18);
    const waveZ = Math.cos(time * 1.8) * (isBeamActive ? 0.25 : 0.12);

    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(nodeA.group.position.x + 0.48, nodeA.group.position.y, 0),
      new THREE.Vector3(-0.9, waveY, waveZ),
      new THREE.Vector3(0.9, -waveY, -waveZ),
      new THREE.Vector3(nodeB.group.position.x - 0.48, nodeB.group.position.y, 0)
    );

    // Update Particles Along Curve
    const posAttr = particleGeo.attributes.position;
    const colAttr = particleGeo.attributes.color;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = particleData[i];
      p.t += currentSpeedMultiplier * p.speedRate;
      if (p.t > 1) p.t -= 1;

      // Sample curve position
      const point = curve.getPoint(p.t);

      // Helical spiral dispersion
      p.angle += p.rotSpeed * delta * (isBeamActive ? 4 : 1.5);
      const perpX = Math.cos(p.angle) * p.radius;
      const perpY = Math.sin(p.angle) * p.radius;

      posAttr.setXYZ(i, point.x, point.y + perpY, point.z + perpX);

      // Color transition from Cyan to Indigo
      tempColor.copy(colorCyan).lerp(colorIndigo, p.t);
      colAttr.setXYZ(i, tempColor.r, tempColor.g, tempColor.b);
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;

    // Pulsing light intensity when active
    cyanLight.intensity = 3.0 + Math.sin(time * 4) * (isBeamActive ? 2.0 : 0.8);
    indigoLight.intensity = 3.0 + Math.cos(time * 4) * (isBeamActive ? 2.0 : 0.8);

    // Starfield gentle rotation
    starField.rotation.y = time * 0.02;

    renderer.render(scene, camera);
  }

  animate();
})();
