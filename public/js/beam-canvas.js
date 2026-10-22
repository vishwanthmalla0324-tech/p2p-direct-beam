import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const canvas = document.getElementById('directbeam-webgl-canvas');
if (canvas) {
  const container = canvas.parentElement;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x030712, 0.08);

  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
  camera.position.set(0, 1.2, 5.5);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const lightCyan = new THREE.PointLight(0x38bdf8, 3, 15);
  lightCyan.position.set(-2.5, 0, 1);
  scene.add(lightCyan);

  const lightViolet = new THREE.PointLight(0xa855f7, 3, 15);
  lightViolet.position.set(2.5, 0, 1);
  scene.add(lightViolet);

  const gridHelper = new THREE.GridHelper(14, 14, 0x0369a1, 0x0f172a);
  gridHelper.position.y = -1.2;
  scene.add(gridHelper);

  function createNode(color, x) {
    const group = new THREE.Group();
    group.position.x = x;

    const coreGeo = new THREE.SphereGeometry(0.35, 32, 32);
    const coreMat = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.6,
      roughness: 0.2,
      metalness: 0.8
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);

    const ringGeo = new THREE.RingGeometry(0.48, 0.52, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2.5;
    group.add(ring);

    scene.add(group);
    return { group, ring };
  }

  const nodeA = createNode(0x38bdf8, -2.2);
  const nodeB = createNode(0x818cf8, 2.2);

  const particleCount = 350;
  const pPositions = new Float32Array(particleCount * 3);
  const pVelocities = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    pPositions[i * 3] = (Math.random() - 0.5) * 4.4;
    pPositions[i * 3 + 1] = (Math.random() - 0.5) * 0.25;
    pPositions[i * 3 + 2] = (Math.random() - 0.5) * 0.25;
    pVelocities[i] = 0.035 + Math.random() * 0.05;
  }

  const pGeometry = new THREE.BufferGeometry();
  pGeometry.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));

  const pMaterial = new THREE.PointsMaterial({
    size: 0.05,
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending
  });

  const particles = new THREE.Points(pGeometry, pMaterial);
  scene.add(particles);

  let mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
  let isDragging = false;
  let previousMousePosition = { x: 0, y: 0 };

  container.addEventListener('mousedown', (e) => {
    isDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener('mouseup', () => { isDragging = false; });

  container.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const deltaX = e.clientX - previousMousePosition.x;
      const deltaY = e.clientY - previousMousePosition.y;
      targetX += deltaX * 0.003;
      targetY += deltaY * 0.003;
      targetY = Math.max(-0.4, Math.min(0.4, targetY));
      previousMousePosition = { x: e.clientX, y: e.clientY };
    }
  });

  // Touch support for mobile dragging
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: true });

  window.addEventListener('touchend', () => { isDragging = false; });

  container.addEventListener('touchmove', (e) => {
    if (isDragging && e.touches.length === 1) {
      const deltaX = e.touches[0].clientX - previousMousePosition.x;
      const deltaY = e.touches[0].clientY - previousMousePosition.y;
      targetX += deltaX * 0.003;
      targetY += deltaY * 0.003;
      targetY = Math.max(-0.4, Math.min(0.4, targetY));
      previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: true });

  window.setDirectBeamTransferSpeed = function(isTransferring) {
    pMaterial.color.setHex(isTransferring ? 0x2dd4bf : 0x38bdf8);
    for (let i = 0; i < particleCount; i++) {
      pVelocities[i] = (isTransferring ? 0.09 : 0.035) + Math.random() * 0.04;
    }
  };

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const elapsedTime = clock.getElapsedTime();

    nodeA.group.position.y = Math.sin(elapsedTime * 2) * 0.08;
    nodeB.group.position.y = Math.sin(elapsedTime * 2 + Math.PI) * 0.08;
    nodeA.ring.rotation.z += 0.02;
    nodeB.ring.rotation.z -= 0.02;

    mouseX += (targetX - mouseX) * 0.05;
    mouseY += (targetY - mouseY) * 0.05;
    camera.position.x = Math.sin(mouseX) * 5.5;
    camera.position.z = Math.cos(mouseX) * 5.5;
    camera.position.y = 1.2 + mouseY * 2;
    camera.lookAt(0, 0, 0);

    const pos = pGeometry.attributes.position.array;
    for (let i = 0; i < particleCount; i++) {
      pos[i * 3] += pVelocities[i];
      if (pos[i * 3] > 2.2) {
        pos[i * 3] = -2.2;
      }
    }
    pGeometry.attributes.position.needsUpdate = true;

    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    if (!container) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
}
