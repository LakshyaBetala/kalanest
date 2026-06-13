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
     SOUND ENGINE — Synchronized Video Audio Scrubbing
     Loads the extracted audio tracks of the videos
     and scrubs them frame-by-frame in sync with scroll.
     ═══════════════════════════════════════════════════ */
  const sound = {
    enabled: false,
    bgAudio: null,
    clockAudio: null,
    waterAudio: null,
    pageTurnAudio: null,
    lastPastSplit: false,
    lastTransitionTime: 0,

    /* — Initialise Audio Elements — */
    init() {
      if (this.bgAudio) return;

      const bgPath = useMobileFrames ? 'public/audio/bg_mobile.mp3' : 'public/audio/bg_desktop.mp3';
      const clockPath = useMobileFrames ? 'public/audio/clock_sfx_mobile.mp3' : 'public/audio/clock_sfx.mp3';
      const waterPath = useMobileFrames ? 'public/audio/water_sfx_mobile.mp3' : 'public/audio/water_sfx.mp3';
      const pageTurnPath = useMobileFrames ? 'public/audio/page_turn_sfx_mobile.mp3' : 'public/audio/page_turn_sfx.mp3';

      this.bgAudio = new Audio(bgPath);
      this.clockAudio = new Audio(clockPath);
      this.waterAudio = new Audio(waterPath);
      this.pageTurnAudio = new Audio(pageTurnPath);

      this.bgAudio.preload = 'auto';
      this.clockAudio.preload = 'auto';
      this.waterAudio.preload = 'auto';
      this.pageTurnAudio.preload = 'auto';

      this.bgAudio.loop = true;
      this.clockAudio.loop = true;
      this.waterAudio.loop = true;
      this.pageTurnAudio.loop = false;

      this.bgAudio.volume = 0;
      this.clockAudio.volume = 0;
      this.waterAudio.volume = 0;
      this.pageTurnAudio.volume = 0;
    },

    /* — Per-frame update (called from animate loop) — */
    update(frameIndex) {
      if (!this.enabled || !this.bgAudio) return;

      // Ensure background is playing at steady volume
      if (this.bgAudio.paused) {
        this.bgAudio.play().catch(() => {});
      }
      // Smoothly target background volume
      if (this.bgAudio.volume < 0.35) {
        this.bgAudio.volume = Math.min(0.35, this.bgAudio.volume + 0.05);
      }

      const splitFrame = useMobileFrames ? 276 : 240;

      // ─── 1. Clock SFX Zone ───
      // Active in frames 100 to 210
      if (frameIndex >= 100 && frameIndex <= 210) {
        const center = 155;
        const radius = 55;
        const dist = Math.abs(frameIndex - center);
        const volCoeff = Math.max(0, 1 - dist / radius);

        if (this.clockAudio.paused) {
          this.clockAudio.play().catch(() => {});
        }
        this.clockAudio.volume = volCoeff * 0.7; // Max volume 0.7
      } else {
        if (!this.clockAudio.paused) {
          this.clockAudio.volume = 0;
          this.clockAudio.pause();
        }
      }

      // ─── 2. Water Statue SFX Zone ───
      // Active in frames 260 to 420
      if (frameIndex >= 260 && frameIndex <= 420) {
        const center = 340;
        const radius = 80;
        const dist = Math.abs(frameIndex - center);
        const volCoeff = Math.max(0, 1 - dist / radius);

        if (this.waterAudio.paused) {
          this.waterAudio.play().catch(() => {});
        }
        this.waterAudio.volume = volCoeff * 0.8; // Max volume 0.8
      } else {
        if (!this.waterAudio.paused) {
          this.waterAudio.volume = 0;
          this.waterAudio.pause();
        }
      }

      // ─── 3. Page Turn SFX (Transition) ───
      const isPastSplit = frameIndex >= splitFrame;
      if (isPastSplit !== this.lastPastSplit) {
        this.lastPastSplit = isPastSplit;
        const now = Date.now();
        if (now - this.lastTransitionTime > 1500) {
          this.lastTransitionTime = now;
          this.pageTurnAudio.currentTime = 0;
          this.pageTurnAudio.volume = 0.55;
          this.pageTurnAudio.play().catch(() => {});
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

        // Initialize state so transition doesn't fire immediately on load
        this.lastPastSplit = Math.round(smoothFrame) >= (useMobileFrames ? 276 : 240);
        this.lastTransitionTime = Date.now();

        // Trigger immediate sound update
        this.update(Math.round(smoothFrame));
      } else {
        this.enabled = false;
        
        if (soundBtn) {
          soundBtn.classList.remove('is-on');
          soundBtn.setAttribute('aria-label', 'Enable sound');
        }

        // Mute and pause all audio elements
        const audios = [this.bgAudio, this.clockAudio, this.waterAudio, this.pageTurnAudio];
        audios.forEach((audio) => {
          if (audio) {
            audio.volume = 0;
            audio.pause();
          }
        });
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

    sound.lastScrollTime = Date.now();

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
    }

    const currentFrameIndex = Math.min(Math.round(smoothFrame) | 0, TOTAL_FRAMES - 1);
    sound.update(currentFrameIndex);

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
