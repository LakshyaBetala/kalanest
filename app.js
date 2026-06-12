/* ═══════════════════════════════════════════════════
   KALANEST — Dual-aspect scroll-driven frame engine
   Desktop: 465 frames (1280×720, 16:9)
   Mobile:  576 frames (1080×1920, 9:16)
   rAF-throttled · Orientation-aware · Emil motion
   ═══════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Device & Aspect Detection ── */
  const isPortrait = window.innerWidth < window.innerHeight;
  const isSmallScreen = window.innerWidth < 768;
  const useMobileFrames = isPortrait && isSmallScreen;

  /* ── Config — dual-aspect paths ── */
  const DESKTOP_FRAMES  = 465;
  const MOBILE_FRAMES   = 576;
  const TOTAL_FRAMES    = useMobileFrames ? MOBILE_FRAMES : DESKTOP_FRAMES;

  const FRAME_PATH = useMobileFrames
    ? 'public/frames-mobile/frame-'
    : 'public/frames/frame-';
  const FRAME_EXT = '.webp';

  /* Scroll speed — tuned per platform for natural pacing */
  const PX_PER_FRAME = useMobileFrames ? 7 : (isSmallScreen ? 8 : 12);

  /* Overlay frame mapping ratio (overlays are authored for 465 desktop frames) */
  const OVERLAY_RATIO = useMobileFrames ? (DESKTOP_FRAMES / MOBILE_FRAMES) : 1;

  /* ── DOM refs (cached once) ── */
  const $ = (id) => document.getElementById(id);
  const canvas       = $('frameCanvas');
  const ctx          = canvas.getContext('2d', { alpha: false });
  const scrollSpacer = $('scrollSpacer');
  const loader       = $('loader');
  const loaderBar    = $('loaderBar');
  const loaderPct    = $('loaderPercent');
  const loaderStatus = $('loaderStatus');
  const nav          = $('nav');
  const progressTrack = $('progressTrack');
  const progressFill  = $('progressFill');
  const scrollPrompt  = $('scrollPrompt');
  const canvasStage   = $('canvasStage');
  const textOverlayContainer = $('textOverlays');
  const overlayEls    = document.querySelectorAll('.text-overlay');
  const mainContent   = $('mainContent');

  /* ── State ── */
  const images      = new Array(TOTAL_FRAMES);
  let loaded        = 0;
  let currentFrame  = -1;
  let isReady       = false;
  let hasScrolled   = false;
  let rafId         = null;
  let lastScrollY   = -1;
  let targetFrame   = 0;
  let smoothFrame   = 0;
  let canvasW       = 0;
  let canvasH       = 0;
  let videoScrollDist = 0;

  /* ── Scroll spacer ── */
  function setSpacerHeight() {
    videoScrollDist = TOTAL_FRAMES * PX_PER_FRAME;
    scrollSpacer.style.height = (videoScrollDist + window.innerHeight) + 'px';
  }

  /* ── Canvas sizing ── */
  function updateCanvasSize() {
    canvasW = window.innerWidth;
    canvasH = window.innerHeight;
    canvas.width  = canvasW;
    canvas.height = canvasH;
  }

  /* ── Draw frame (cover-fit, optimized) ── */
  function drawFrame(index) {
    if (index === currentFrame) return;
    const img = images[index];
    if (!img) return;
    currentFrame = index;

    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const scale = Math.max(canvasW / iw, canvasH / ih);
    const dw = (iw * scale) | 0;
    const dh = (ih * scale) | 0;
    const dx = ((canvasW - dw) >> 1);
    const dy = ((canvasH - dh) >> 1);

    ctx.drawImage(img, dx, dy, dw, dh);
  }

  /* ── Frame loading — priority batches ── */
  function padNum(n) {
    return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n;
  }

  function loadFrame(index) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        images[index] = img;
        loaded++;
        const pct = (loaded / TOTAL_FRAMES * 100) | 0;
        loaderBar.style.width = pct + '%';
        loaderPct.textContent = pct + '%';
        if (pct > 85) loaderStatus.textContent = 'Almost ready';
        resolve();
      };
      img.onerror = () => { loaded++; resolve(); };
      img.src = FRAME_PATH + padNum(index + 1) + FRAME_EXT;
    });
  }

  async function loadAllFrames() {
    /* Priority 1: First 8 frames (instant first paint) */
    const p1 = [];
    for (let i = 0; i < Math.min(8, TOTAL_FRAMES); i++) p1.push(loadFrame(i));
    await Promise.all(p1);

    /* Show first frame immediately */
    if (images[0]) {
      updateCanvasSize();
      drawFrame(0);
    }

    /* Priority 2: Load rest in batches of 20 */
    const batchSize = 20;
    for (let i = 8; i < TOTAL_FRAMES; i += batchSize) {
      const batch = [];
      const end = Math.min(i + batchSize, TOTAL_FRAMES);
      for (let j = i; j < end; j++) batch.push(loadFrame(j));
      await Promise.all(batch);
    }
  }

  /* ── Text overlay updates ── */
  function updateOverlays(frameIndex) {
    /* Map mobile frame index → desktop overlay space */
    const overlayFrame = OVERLAY_RATIO !== 1
      ? Math.round(frameIndex * OVERLAY_RATIO)
      : frameIndex;

    for (let i = 0; i < overlayEls.length; i++) {
      const el = overlayEls[i];
      const start = +el.dataset.start;
      const peak  = +el.dataset.peak;
      const end   = +el.dataset.end;

      if (overlayFrame >= start && overlayFrame <= end) {
        if (overlayFrame >= peak) {
          el.classList.remove('is-visible');
          el.classList.add('is-fading');
        } else {
          el.classList.add('is-visible');
          el.classList.remove('is-fading');
        }
      } else {
        el.classList.remove('is-visible', 'is-fading');
      }
    }
  }

  /* ═══════════════════════════════════════════════════
     SOUND ENGINE — Web Audio API, fully procedural
     Synthesises: ambient drone, water flow + drips,
     clock ticks, transition chimes. Zero audio files.
     Sound zones mapped to desktop frame space.
     ═══════════════════════════════════════════════════ */
  const sound = {
    ctx: null, master: null, enabled: false,
    drone: null, water: null, noiseBuffer: null,
    lastFrame: -1, lastTick: -1,

    /* — Initialise AudioContext (must follow user gesture) — */
    init() {
      if (this.ctx) return;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);

      /* Pre-generate reusable noise buffer (2 s) */
      const len = this.ctx.sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this._startDrone();
      this._startWater();
    },

    /* — Warm ambient drone (two detuned sines + triangle, ≈80-170 Hz) — */
    _startDrone() {
      const c = this.ctx;
      const o1 = c.createOscillator(); o1.type = 'sine';     o1.frequency.value = 85;
      const o2 = c.createOscillator(); o2.type = 'sine';     o2.frequency.value = 128;
      const o3 = c.createOscillator(); o3.type = 'triangle'; o3.frequency.value = 170;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 200;
      const g  = c.createGain(); g.gain.value = 0;
      o1.connect(lp); o2.connect(lp); o3.connect(lp);
      lp.connect(g); g.connect(this.master);
      o1.start(); o2.start(); o3.start();
      this.drone = { g };
    },

    /* — Continuous water ambience (band-passed looping noise) — */
    _startWater() {
      const c = this.ctx;
      const src = c.createBufferSource();
      src.buffer = this.noiseBuffer; src.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 600; bp.Q.value = 1.5;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass';  lp.frequency.value = 1200;
      const g  = c.createGain(); g.gain.value = 0;
      src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(this.master);
      src.start();
      this.water = { g };
    },

    /* — Single water drip (short filtered noise burst) — */
    _drip() {
      const c = this.ctx, now = c.currentTime;
      const len = (c.sampleRate * 0.06) | 0;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 800 + Math.random() * 600; bp.Q.value = 12;
      const g = c.createGain();
      g.gain.setValueAtTime(0.18, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start(); src.stop(now + 0.07);
    },

    /* — Clock tick (metallic sine impulse + soft secondary click) — */
    _tick() {
      const c = this.ctx, now = c.currentTime;
      const o = c.createOscillator(); o.frequency.value = 1800 + Math.random() * 400; o.type = 'sine';
      const g = c.createGain();
      g.gain.setValueAtTime(0.22, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      o.connect(g); g.connect(this.master);
      o.start(); o.stop(now + 0.04);
      /* Secondary click for realism */
      const o2 = c.createOscillator(); o2.frequency.value = 3200;
      const g2 = c.createGain();
      g2.gain.setValueAtTime(0.08, now + 0.008);
      g2.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
      o2.connect(g2); g2.connect(this.master);
      o2.start(now + 0.008); o2.stop(now + 0.04);
    },

    /* — Soft chime (on text overlay transitions) — */
    _chime() {
      const c = this.ctx, now = c.currentTime;
      const freq = [523, 659, 784, 880][(Math.random() * 4) | 0]; /* C5-A5 */
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      const g = c.createGain();
      g.gain.setValueAtTime(0.12, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      o.connect(g); g.connect(this.master);
      o.start(); o.stop(now + 0.55);
    },

    /* — Per-frame update (called from animate loop) — */
    update(frameIndex) {
      if (!this.enabled || !this.ctx) return;

      /* Map to desktop frame space so sound zones are consistent */
      const f = useMobileFrames ? Math.round(frameIndex * OVERLAY_RATIO) : frameIndex;
      const now = this.ctx.currentTime;
      const frameChanged = f !== this.lastFrame;

      /* ---- Continuous ambience (runs even when not scrolling) ---- */

      /* Drone: warm room presence throughout the video */
      if (this.drone) {
        this.drone.g.gain.setTargetAtTime(f < 462 ? 0.08 : 0, now, 0.4);
      }

      /* Water zone: desktop frames ~260-420 (curated interiors / water features) */
      const inWater = f >= 260 && f <= 420;
      if (this.water) {
        this.water.g.gain.setTargetAtTime(inWater ? 0.12 : 0, now, 0.6);
      }
      /* Random drips continue even when scrolling stops */
      if (inWater && Math.random() < 0.012) this._drip();

      if (!frameChanged) return;
      this.lastFrame = f;

      /* ---- Event sounds (only fire on frame changes) ---- */

      /* Clock zone: desktop frames ~100-210 (heritage timepieces) */
      if (f >= 100 && f <= 210) {
        const bucket = (f / 18) | 0;  /* tick every ~18 frames */
        if (bucket !== this.lastTick) {
          this.lastTick = bucket;
          this._tick();
        }
      }
    },

    /* — Toggle on/off — */
    toggle() {
      const soundBtn = document.getElementById('soundToggle');
      if (!this.enabled) {
        this.enabled = true;
        this.init();
        
        if (soundBtn) {
          soundBtn.classList.add('is-on');
          soundBtn.setAttribute('aria-label', 'Mute sound');
        }

        const runInitVolume = () => {
          if (!this.enabled) return;
          this.master.gain.setTargetAtTime(0.8, this.ctx.currentTime, 0.15);
          this.update(Math.round(smoothFrame));
          this._chime();
        };

        if (this.ctx.state === 'suspended') {
          this.ctx.resume().then(runInitVolume);
        } else {
          runInitVolume();
        }
      } else {
        this.enabled = false;
        
        if (soundBtn) {
          soundBtn.classList.remove('is-on');
          soundBtn.setAttribute('aria-label', 'Enable sound');
        }

        if (this.ctx) {
          this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
          setTimeout(() => {
            if (!this.enabled && this.ctx && this.ctx.state === 'running') {
              this.ctx.suspend();
            }
          }, 200);
        }
      }
    }
  };

  /* ── Scroll handler (passive — only updates target) ── */
  function onScroll() {
    const scrollY = window.pageYOffset | 0;

    /* Hide scroll prompt on first scroll */
    if (!hasScrolled && scrollY > 10) {
      hasScrolled = true;
      scrollPrompt.classList.add('is-fading');
      setTimeout(() => scrollPrompt.classList.remove('is-visible', 'is-fading'), 500);
    }

    /* Update target — the animation loop will glide toward it */
    const rawFrame = scrollY / PX_PER_FRAME;
    targetFrame = Math.min(Math.max(rawFrame, 0), TOTAL_FRAMES - 1);

    /* Progress bar updates instantly for responsiveness */
    const videoProgress = Math.min(scrollY / videoScrollDist, 1);
    progressFill.style.width = (videoProgress * 100) + '%';

    /* Transition: video → content */
    if (scrollY >= videoScrollDist) {
      canvasStage.style.opacity = '0';
      textOverlayContainer.style.opacity = '0';
      progressTrack.classList.remove('is-visible');
    } else {
      canvasStage.style.opacity = '1';
      textOverlayContainer.style.opacity = '1';
      if (isReady) progressTrack.classList.add('is-visible');
    }
  }

  /* ── Animation loop (continuous lerp toward target) ── */
  /* Damping factor: 0.08 = silky glide, 0.12 = snappier, 0.05 = heavy inertia */
  const DAMPING = 0.08;

  function animate() {
    const diff = targetFrame - smoothFrame;

    /* Only redraw when there's meaningful movement (> 1/100th of a frame) */
    if (Math.abs(diff) > 0.01) {
      smoothFrame += diff * DAMPING;

      /* Snap to target when extremely close to avoid infinite micro-drifts */
      if (Math.abs(targetFrame - smoothFrame) < 0.05) smoothFrame = targetFrame;

      const frameIndex = Math.min(Math.round(smoothFrame) | 0, TOTAL_FRAMES - 1);
      drawFrame(frameIndex);
      updateOverlays(frameIndex);
      sound.update(frameIndex);
    }

    rafId = requestAnimationFrame(animate);
  }

  /* ── Section reveals (IntersectionObserver) ── */
  function initReveals() {
    const els = document.querySelectorAll(
      '.manifesto, .collections__header, .collections__grid, .philosophy, .cta-block'
    );
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-revealed');
            obs.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '-30px' }
    );
    els.forEach((el) => obs.observe(el));
  }

  /* ── Resize (debounced) ── */
  let resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      updateCanvasSize();
      setSpacerHeight();
      currentFrame = -1;
      /* Recalculate and snap to avoid drift after resize */
      const rawFrame = (window.pageYOffset | 0) / PX_PER_FRAME;
      targetFrame = Math.min(Math.max(rawFrame, 0), TOTAL_FRAMES - 1);
      smoothFrame = targetFrame;
    }, 150);
  }

  /* ── Visibility API — pause when tab hidden ── */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    } else {
      if (isReady && !rafId) rafId = requestAnimationFrame(animate);
    }
  });

  /* ── Boot ── */
  async function init() {
    setSpacerHeight();
    updateCanvasSize();

    /* Smooth transitions for video → content handoff */
    canvasStage.style.transition = 'opacity 0.5s ease';
    textOverlayContainer.style.transition = 'opacity 0.4s ease';

    await loadAllFrames();

    isReady = true;
    loaderStatus.textContent = 'Welcome';

    /* Hide loader with polish delay */
    setTimeout(() => {
      loader.classList.add('is-hidden');
      nav.classList.add('is-visible');
      scrollPrompt.classList.add('is-visible');
      progressTrack.classList.add('is-visible');

      window.addEventListener('scroll', onScroll, { passive: true });
      rafId = requestAnimationFrame(animate);
      window.addEventListener('resize', onResize);

      /* Sound toggle (opt-in, muted by default) */
      const soundBtn = $('soundToggle');
      if (soundBtn) {
        soundBtn.addEventListener('click', () => {
          sound.toggle();
        });
      }
    }, 350);

    initReveals();
  }

  init();
})();
