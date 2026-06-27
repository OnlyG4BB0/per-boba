import * as THREE from 'three';

const MEDIA_BASE = 'ricordi/';
const MANIFEST_URL = `${MEDIA_BASE}manifest.json`;
const PRELOAD_CONCURRENCY = 6;
const PRELOAD_RADIUS = 10;

function mediaUrl(file) {
  if (!file) return null;
  return encodeURI(`${MEDIA_BASE}${file}`);
}

function getMediaSize(source) {
  const w = source.videoWidth || source.naturalWidth || source.width || 4;
  const h = source.videoHeight || source.naturalHeight || source.height || 3;
  return { w, h, aspect: w / h };
}

function fitFrameSize(aspect, maxW, maxH) {
  const maxAspect = maxW / maxH;
  if (aspect >= maxAspect) {
    return { width: maxW, height: maxW / aspect };
  }
  return { width: maxH * aspect, height: maxH };
}

function resetTextureMapping(tex) {
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1, 1);
  tex.offset.set(0, 0);
  tex.center.set(0.5, 0.5);
  tex.needsUpdate = true;
}

export async function initGalleryReel() {
  const wrapper = document.getElementById('gallery-wrapper');
  const canvas = document.getElementById('gallery-canvas');
  const captionEl = document.getElementById('gallery-caption');
  const counterEl = document.getElementById('gallery-counter');
  const lightbox = document.getElementById('gallery-lightbox');
  const lightboxInner = document.getElementById('gallery-lightbox-inner');
  const lightboxClose = document.getElementById('gallery-lightbox-close');

  if (!wrapper || !canvas) return;

  let items = [];
  try {
    const res = await fetch(MANIFEST_URL);
    const data = await res.json();
    items = Array.isArray(data.items)
      ? data.items.filter(i => i.file && i.type !== 'video')
      : [];
  } catch {
    items = [];
  }

  if (items.length === 0) {
    items = [{ file: null, type: 'placeholder', caption: 'Aggiungi foto in ricordi/' }];
  }

  const MAX_W = 2.35;
  const MAX_H = 1.55;
  const FRAME_GAP = 0.28;
  const DEFAULT_STEP = MAX_W + FRAME_GAP;

  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
  camera.position.set(0, 0, 5.1);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));

  const stripGroup = new THREE.Group();
  scene.add(stripGroup);

  const frames = [];
  const videoEls = [];
  const slotState = items.map(() => ({ loaded: false, loading: false }));
  /** @type {Map<string, { image?: HTMLImageElement, promise?: Promise<HTMLImageElement>, ready?: boolean }>} */
  const imageCache = new Map();

  const filmBaseMat = new THREE.MeshBasicMaterial({ color: 0x0c0a10 });
  const filmEdgeMat = new THREE.MeshBasicMaterial({
    color: 0xc9a84c,
    transparent: true,
    opacity: 0.35,
  });

  function makePerforationTexture() {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 16;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#16121a';
    ctx.fillRect(0, 0, 128, 16);
    for (let x = 6; x < 128; x += 20) {
      ctx.fillStyle = '#08060e';
      ctx.fillRect(x, 4, 10, 8);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(4, 1);
    return tex;
  }

  const perfTex = makePerforationTexture();
  const perfMat = new THREE.MeshBasicMaterial({ map: perfTex, transparent: true });

  function makePlaceholderTexture(label) {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 432;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#141018';
    ctx.fillRect(0, 0, 640, 432);
    ctx.fillStyle = 'rgba(232,160,176,.45)';
    ctx.font = '64px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('♥', 320, 210);
    ctx.fillStyle = 'rgba(154,138,144,.85)';
    ctx.font = '16px sans-serif';
    ctx.fillText(label, 320, 260);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function replacePlaneGeometry(mesh, width, height) {
    mesh.geometry.dispose();
    mesh.geometry = new THREE.PlaneGeometry(width, height);
  }

  function resizeFrameChrome(frame, mediaW, mediaH) {
    const padX = 0.12;
    const padY = 0.14;
    const outerW = mediaW + padX * 2;
    const outerH = mediaH + padY * 2;
    const { back, edge, topPerf, botPerf } = frame.userData;

    replacePlaneGeometry(back, outerW, outerH);
    replacePlaneGeometry(edge, mediaW + 0.05, mediaH + 0.05);
    replacePlaneGeometry(topPerf, outerW, 0.09);
    replacePlaneGeometry(botPerf, outerW, 0.09);

    topPerf.position.y = mediaH / 2 + padY * 0.52;
    botPerf.position.y = -(mediaH / 2 + padY * 0.52);
    frame.userData.mediaW = mediaW;
    frame.userData.mediaH = mediaH;
  }

  function buildFrameShell(item, index) {
    const group = new THREE.Group();
    group.userData.index = index;
    group.userData.item = item;
    group.userData.mediaUrl = mediaUrl(item.file);
    group.userData.video = null;
    group.userData.mediaW = MAX_W * 0.85;
    group.userData.mediaH = MAX_H * 0.85;

    const mediaW = group.userData.mediaW;
    const mediaH = group.userData.mediaH;
    const padX = 0.12;
    const padY = 0.14;
    const outerW = mediaW + padX * 2;
    const outerH = mediaH + padY * 2;

    const back = new THREE.Mesh(new THREE.PlaneGeometry(outerW, outerH), filmBaseMat);
    group.add(back);

    const topPerf = new THREE.Mesh(new THREE.PlaneGeometry(outerW, 0.09), perfMat);
    topPerf.position.y = mediaH / 2 + padY * 0.52;
    topPerf.position.z = 0.002;
    group.add(topPerf);

    const botPerf = topPerf.clone();
    botPerf.position.y = -(mediaH / 2 + padY * 0.52);
    group.add(botPerf);

    const edge = new THREE.Mesh(
      new THREE.PlaneGeometry(mediaW + 0.05, mediaH + 0.05),
      filmEdgeMat,
    );
    edge.position.z = 0.004;
    group.add(edge);

    const loadingTex = makePlaceholderTexture('…');
    const photo = new THREE.Mesh(
      new THREE.PlaneGeometry(mediaW, mediaH),
      new THREE.MeshBasicMaterial({ map: loadingTex, toneMapped: false }),
    );
    photo.position.z = 0.008;
    group.add(photo);

    group.userData.back = back;
    group.userData.edge = edge;
    group.userData.topPerf = topPerf;
    group.userData.botPerf = botPerf;
    group.userData.photoMesh = photo;

    group.position.x = index * DEFAULT_STEP;
    stripGroup.add(group);
    frames.push(group);
    return group;
  }

  items.forEach((item, i) => buildFrameShell(item, i));

  function preloadImageToCache(url) {
    if (!url) return Promise.reject(new Error('missing url'));
    const existing = imageCache.get(url);
    if (existing?.ready) return Promise.resolve(existing.image);
    if (existing?.promise) return existing.promise;

    const entry = {};
    entry.promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = async () => {
        try {
          if (img.decode) await img.decode();
        } catch {
          /* decode optional */
        }
        entry.image = img;
        entry.ready = true;
        resolve(img);
      };
      img.onerror = () => reject(new Error(`failed: ${url}`));
      img.src = url;
    });
    imageCache.set(url, entry);
    return entry.promise;
  }

  function startImagePreloadQueue() {
    const jobs = items
      .map((item, index) => ({ item, index, url: mediaUrl(item.file) }))
      .filter(({ item, url }) => url && item.type !== 'video');

    const priority = new Set([0, Math.floor(items.length / 2), items.length - 1]);
    jobs.sort((a, b) => {
      const da = Math.min(...[...priority].map(p => Math.abs(a.index - p)));
      const db = Math.min(...[...priority].map(p => Math.abs(b.index - p)));
      return da - db;
    });

    let cursor = 0;
    async function worker() {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        try {
          await preloadImageToCache(job.url);
        } catch {
          /* skip broken files */
        }
      }
    }

    for (let w = 0; w < PRELOAD_CONCURRENCY; w++) worker();
  }

  function scheduleIdleHydration() {
    let index = 0;

    function step(deadline) {
      while (index < items.length && deadline.timeRemaining() > 4) {
        const i = index;
        const item = items[i];
        const url = mediaUrl(item.file);
        index += 1;
        if (!url || item.type === 'video' || slotState[i].loaded) continue;
        const cached = imageCache.get(url);
        if (cached?.ready) {
          loadMedia(i);
        } else if (cached?.promise) {
          cached.promise.then(() => {
            if (!slotState[i].loaded) loadMedia(i);
          }).catch(() => {});
        }
      }
      if (index < items.length) {
        requestIdleCallback(step, { timeout: 120 });
      }
    }

    requestIdleCallback(step, { timeout: 300 });
  }

  function relayoutStripPositions() {
    let x = 0;
    frames.forEach((group) => {
      group.position.x = x + group.userData.mediaW / 2;
      x += group.userData.mediaW + FRAME_GAP;
    });
  }

  function loadMedia(index) {
    if (slotState[index].loaded || slotState[index].loading) return slotState[index].promise;
    const item = items[index];
    const url = mediaUrl(item.file);
    const frame = frames[index];
    const photo = frame?.userData.photoMesh;
    if (!url || !photo) return Promise.resolve();

    slotState[index].loading = true;
    slotState[index].promise = (async () => {
      let tex;
      let video = null;
      let mediaSize = { aspect: 4 / 3 };

      if (item.type === 'video') {
        video = document.createElement('video');
        video.src = url;
        video.crossOrigin = 'anonymous';
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        try {
          await new Promise((resolve, reject) => {
            video.addEventListener('loadeddata', resolve, { once: true });
            video.addEventListener('error', reject, { once: true });
          });
          mediaSize = getMediaSize(video);
          tex = new THREE.VideoTexture(video);
          tex.colorSpace = THREE.SRGBColorSpace;
          resetTextureMapping(tex);
          videoEls.push(video);
          frame.userData.video = video;
        } catch {
          tex = makePlaceholderTexture('Video');
          mediaSize = { aspect: 640 / 432 };
        }
      } else {
        try {
          const img = await preloadImageToCache(url);
          tex = new THREE.Texture(img);
          tex.colorSpace = THREE.SRGBColorSpace;
          mediaSize = getMediaSize(img);
          resetTextureMapping(tex);
        } catch {
          tex = makePlaceholderTexture('Foto');
          mediaSize = { aspect: 640 / 432 };
        }
      }

      const { width, height } = fitFrameSize(mediaSize.aspect, MAX_W, MAX_H);
      resizeFrameChrome(frame, width, height);
      replacePlaneGeometry(photo, width, height);

      photo.material.map?.dispose?.();
      photo.material.map = tex;
      photo.material.needsUpdate = true;

      slotState[index].loaded = true;
      slotState[index].loading = false;
      relayoutStripPositions();
    })();

    return slotState[index].promise;
  }

  function preloadAround(centerIndex) {
    for (let i = Math.max(0, centerIndex - PRELOAD_RADIUS); i <= Math.min(items.length - 1, centerIndex + PRELOAD_RADIUS); i++) {
      loadMedia(i);
    }
  }

  startImagePreloadQueue();
  scheduleIdleHydration();
  preloadAround(0);

  let floatIndex = 0;
  let isDragging = false;
  let lastPointerX = 0;
  let dragMoved = false;
  let activeIndex = 0;
  let isVisible = false;

  function clampIndex(i) {
    return THREE.MathUtils.clamp(i, 0, items.length - 1);
  }

  function layoutFrames(current) {
    const i0 = Math.floor(current);
    const i1 = Math.min(i0 + 1, items.length - 1);
    const t = current - i0;
    const x0 = frames[i0]?.position.x ?? 0;
    const x1 = frames[i1]?.position.x ?? x0;
    const focusX = x0 + (x1 - x0) * t;

    frames.forEach((group, i) => {
      const dist = (group.position.x - focusX) / DEFAULT_STEP;
      group.rotation.y = THREE.MathUtils.clamp(-dist * 0.34, -0.85, 0.85);
      group.position.z = -Math.abs(dist) * 0.12;
      const scale = THREE.MathUtils.clamp(1 - Math.abs(dist) * 0.06, 0.78, 1);
      group.scale.setScalar(scale);
      group.visible = Math.abs(dist) < 5.5;
    });
    stripGroup.position.x = -focusX;
  }

  function goTo(index) {
    floatIndex = clampIndex(index);
    layoutFrames(floatIndex);
    updateUI(floatIndex);
  }

  function updateUI(index) {
    const i = clampIndex(Math.round(index));
    if (i !== activeIndex) {
      frames[activeIndex]?.userData.video?.pause();
      activeIndex = i;
      const v = frames[activeIndex]?.userData.video;
      if (v && isVisible) v.play().catch(() => {});
      preloadAround(activeIndex);
    }
    if (captionEl) captionEl.textContent = items[activeIndex]?.caption || '';
    if (counterEl) counterEl.textContent = `${activeIndex + 1} / ${items.length}`;
  }

  function resize() {
    const w = W();
    const h = H();
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  resize();
  window.addEventListener('resize', resize);

  const io = new IntersectionObserver(
    (entries) => {
      isVisible = entries[0]?.isIntersecting ?? false;
      if (!isVisible) {
        videoEls.forEach(v => v.pause());
      } else {
        frames[activeIndex]?.userData.video?.play().catch(() => {});
      }
    },
    { threshold: 0.08 },
  );
  io.observe(wrapper);

  function openLightbox(item, url) {
    if (!url || !lightbox || !lightboxInner) return;
    lightboxInner.innerHTML = '';

    if (item.type === 'video') {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.muted = false;
      v.volume = 1;
      lightboxInner.appendChild(v);
      v.play().catch(() => {
        v.muted = true;
        v.play().catch(() => {});
      });
    } else if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = item.caption || 'Ricordo';
      lightboxInner.appendChild(img);
    } else return;

    lightbox.hidden = false;
    lightbox.classList.add('is-open');
  }

  canvas.addEventListener('pointerdown', (e) => {
    isDragging = true;
    dragMoved = false;
    lastPointerX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastPointerX;
    if (Math.abs(dx) > 3) dragMoved = true;
    lastPointerX = e.clientX;
    floatIndex = clampIndex(floatIndex - dx / (canvas.clientWidth * 0.22));
    layoutFrames(floatIndex);
    updateUI(floatIndex);
  });

  canvas.addEventListener('pointerup', () => { isDragging = false; });
  canvas.addEventListener('pointercancel', () => { isDragging = false; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    floatIndex = clampIndex(floatIndex + delta * 0.0035);
    layoutFrames(floatIndex);
    updateUI(floatIndex);
  }, { passive: false });

  canvas.addEventListener('click', () => {
    if (dragMoved) return;
    const item = items[activeIndex];
    const url = frames[activeIndex]?.userData.mediaUrl;
    openLightbox(item, url);
  });

  function closeLightbox() {
    if (!lightbox || !lightboxInner) return;
    lightbox.querySelectorAll('video').forEach(v => {
      v.pause();
      v.src = '';
    });
    lightbox.classList.remove('is-open');
    lightbox.hidden = true;
    lightboxInner.innerHTML = '';
  }

  lightboxClose?.addEventListener('click', closeLightbox);
  lightbox?.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
    if (!isVisible) return;
    if (e.key === 'ArrowLeft') goTo(floatIndex - 1);
    if (e.key === 'ArrowRight') goTo(floatIndex + 1);
  });

  const prevBtn = document.getElementById('gallery-prev');
  const nextBtn = document.getElementById('gallery-next');
  prevBtn?.addEventListener('click', () => goTo(floatIndex - 1));
  nextBtn?.addEventListener('click', () => goTo(floatIndex + 1));

  function animate() {
    requestAnimationFrame(animate);
    layoutFrames(floatIndex);
    updateUI(floatIndex);
    frames.forEach(f => {
      const map = f.userData.photoMesh?.material?.map;
      if (map?.isVideoTexture) map.needsUpdate = true;
    });
    renderer.render(scene, camera);
  }
  animate();
}
