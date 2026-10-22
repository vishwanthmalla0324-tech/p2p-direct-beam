import { Application } from 'https://unpkg.com/@splinetool/runtime@1.9.28/build/runtime.js';

/**
 * DIRECT BEAM — Spline 3D Connecting Card Engine
 * Integrates Spline 3D Scene: https://prod.spline.design/9qtORpDVi7CPR6P5/scene.splinecode
 */

(() => {
  'use strict';

  const container = document.getElementById('beam-container');
  const canvas = document.getElementById('spline-canvas');
  const loader = document.getElementById('spline-loader');

  if (!canvas) return;

  const SCENE_URL = 'https://prod.spline.design/9qtORpDVi7CPR6P5/scene.splinecode';

  let splineApp = null;
  let isBeamActive = false;

  try {
    splineApp = new Application(canvas);

    splineApp.load(SCENE_URL)
      .then(() => {
        console.log('[Spline 3D] Scene loaded successfully');
        if (loader) {
          loader.classList.add('opacity-0', 'pointer-events-none');
          setTimeout(() => {
            loader.style.display = 'none';
          }, 400);
        }

        // Store reference on window for inspection if needed
        window.splineApp = splineApp;
      })
      .catch((err) => {
        console.warn('[Spline 3D] Error loading scene:', err);
        if (loader) {
          loader.innerHTML = `
            <div class="text-center p-4">
              <p class="text-xs text-rose-400 font-mono">3D Mesh Standby</p>
            </div>
          `;
        }
      });
  } catch (err) {
    console.error('[Spline 3D] Runtime initialization error:', err);
  }

  // --- Global Control API (Maintains seamless compatibility with app.js) ---
  window.setBeamActive = function(active) {
    isBeamActive = !!active;

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

})();
