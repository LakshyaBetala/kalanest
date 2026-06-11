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

  /* ── Main scroll loop (rAF-throttled) ── */
  function scrollLoop() {
    const scrollY = window.pageYOffset | 0;

    if (scrollY !== lastScrollY) {
      lastScrollY = scrollY;

      /* Hide scroll prompt on first scroll */
      if (!hasScrolled && scrollY > 10) {
        hasScrolled = true;
        scrollPrompt.classList.add('is-fading');
        setTimeout(() => scrollPrompt.classList.remove('is-visible', 'is-fading'), 500);
      }

      /* Frame index from scroll */
      const rawFrame = scrollY / PX_PER_FRAME;
      const frameIndex = Math.min(Math.max(rawFrame | 0, 0), TOTAL_FRAMES - 1);

      drawFrame(frameIndex);
      updateOverlays(frameIndex);

      /* Progress bar */
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

    rafId = requestAnimationFrame(scrollLoop);
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
      lastScrollY = -1;
    }, 150);
  }

  /* ── Visibility API — pause when tab hidden ── */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    } else {
      if (isReady && !rafId) rafId = requestAnimationFrame(scrollLoop);
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

      rafId = requestAnimationFrame(scrollLoop);
      window.addEventListener('resize', onResize);
    }, 350);

    initReveals();
  }

  init();
})();
