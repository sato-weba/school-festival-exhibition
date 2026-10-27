/**
 * 予期せぬ一枚
 * トップ → 注意事項同意 → 投稿 → ローディング → マッチ結果
 */

(() => {
  "use strict";

  const SCREENS = {
    top: "screen-top",
    upload: "screen-upload",
    loading: "screen-loading",
    result: "screen-result",
  };

  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MIN_DESC = 2;
  const MAX_DESC = 120;

  const LOADING_MESSAGES = [
    "画像の色と雰囲気を読み取り中",
    "過去の投稿画像と照合しています",
    "いちばん近い一枚を選び中",
  ];

  const LOADING_STEP_MS = 900;

  function apiUrl(pathname) {
    const path = String(pathname || "").replace(/^\//, "");
    if (location.protocol === "file:") return `http://localhost:3000/${path}`;
    return new URL(path, document.baseURI).href;
  }

  function resolveMediaUrl(url) {
    if (!url || url.startsWith("data:") || url.startsWith("blob:") || /^https?:/i.test(url)) return url;
    if (url.startsWith("/")) {
      return location.protocol === "file:" ? `http://localhost:3000${url}` : url;
    }
    return new URL(url, document.baseURI).href;
  }

  /** GitHub Pages など、API が無い静的公開でもシード画像と照合する */
  const HIST_BINS = 4;
  const GRID = 8;
  const featureCache = new Map();
  let seedCatalogPromise = null;
  let serverMode = null;

  function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function featuresFromRgba(raw, width, height) {
    const hist = new Array(HIST_BINS ** 3).fill(0);
    const grid = new Array(GRID * GRID * 3).fill(0);
    const cellW = width / GRID;
    const cellH = height / GRID;
    const cellCounts = new Array(GRID * GRID).fill(0);
    let pixels = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const r = raw[i];
        const g = raw[i + 1];
        const b = raw[i + 2];
        const ri = Math.min(HIST_BINS - 1, Math.floor((r / 256) * HIST_BINS));
        const gi = Math.min(HIST_BINS - 1, Math.floor((g / 256) * HIST_BINS));
        const bi = Math.min(HIST_BINS - 1, Math.floor((b / 256) * HIST_BINS));
        hist[ri * HIST_BINS * HIST_BINS + gi * HIST_BINS + bi] += 1;
        pixels += 1;

        const cx = Math.min(GRID - 1, Math.floor(x / cellW));
        const cy = Math.min(GRID - 1, Math.floor(y / cellH));
        const ci = cy * GRID + cx;
        grid[ci * 3] += r;
        grid[ci * 3 + 1] += g;
        grid[ci * 3 + 2] += b;
        cellCounts[ci] += 1;
      }
    }

    if (pixels > 0) {
      for (let i = 0; i < hist.length; i += 1) hist[i] /= pixels;
    }
    for (let i = 0; i < cellCounts.length; i += 1) {
      const n = cellCounts[i] || 1;
      grid[i * 3] = grid[i * 3] / n / 255;
      grid[i * 3 + 1] = grid[i * 3 + 1] / n / 255;
      grid[i * 3 + 2] = grid[i * 3 + 2] / n / 255;
    }
    return hist.concat(grid);
  }

  function scorePhraseFromSimilarity(score, method) {
    if (method === "random" || score <= 0) return "たまたま巡りあった一枚";
    if (score >= 0.85) return "見た目がとても近い一枚";
    if (score >= 0.7) return "色や雰囲気が通じる一枚";
    if (score >= 0.55) return "かすかに重なる一枚";
    return "意外なつながりの一枚";
  }

  async function featuresFromBlob(blob) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      bitmap = await createImageBitmap(blob);
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, 64, 64);
      const { data, width, height } = ctx.getImageData(0, 0, 64, 64);
      return featuresFromRgba(data, width, height);
    } finally {
      bitmap.close();
    }
  }

  async function featuresFromUrl(url) {
    if (featureCache.has(url)) return featureCache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error("画像を読み込めませんでした。");
    const features = await featuresFromBlob(await res.blob());
    featureCache.set(url, features);
    return features;
  }

  function loadSeedCatalog() {
    if (!seedCatalogPromise) {
      seedCatalogPromise = fetch(new URL("seeds/meta.json", document.baseURI).href)
        .then((res) => {
          if (!res.ok) throw new Error("シードを読み込めませんでした。");
          return res.json();
        })
        .then((meta) => {
          const list = Array.isArray(meta.entries) ? meta.entries : [];
          return list.filter((item) => item && item.id && item.filename && item.description);
        })
        .catch((err) => {
          seedCatalogPromise = null;
          throw err;
        });
    }
    return seedCatalogPromise;
  }

  async function serverAvailable() {
    if (serverMode !== null) return serverMode;
    try {
      const res = await fetch(apiUrl("/api/health"), { signal: AbortSignal.timeout(2000) });
      const type = res.headers.get("content-type") || "";
      serverMode = res.ok && type.includes("json");
    } catch {
      serverMode = false;
    }
    return serverMode;
  }

  async function matchAgainstSeeds(file) {
    const entries = await loadSeedCatalog();
    if (!entries.length) throw new Error("照合できる画像がありません。");

    const queryFeatures = await featuresFromBlob(file);
    const scored = [];
    for (const entry of entries) {
      const imageUrl = new URL(`seeds/images/${entry.filename}`, document.baseURI).href;
      try {
        const features = await featuresFromUrl(imageUrl);
        scored.push({
          entry,
          imageUrl,
          score: cosineSimilarity(queryFeatures, features),
        });
      } catch {
        /* 壊れたシードは候補から外す */
      }
    }
    if (!scored.length) throw new Error("照合できる画像がありません。");

    scored.sort((a, b) => b.score - a.score);
    const topScore = scored[0].score;
    let pick;
    let method = "image";
    if (topScore <= 0) {
      pick = scored[Math.floor(Math.random() * scored.length)];
      method = "random";
    } else {
      const tops = scored.filter((item) => Math.abs(item.score - topScore) < 1e-9);
      pick = tops[Math.floor(Math.random() * tops.length)];
    }

    return {
      ok: true,
      match: {
        id: pick.entry.id,
        description: pick.entry.description,
        imageUrl: pick.imageUrl,
        isSeed: true,
      },
      score: Math.round(pick.score * 1000) / 1000,
      scorePhrase: scorePhraseFromSimilarity(pick.score, method),
      method,
      staticPool: true,
    };
  }

  /** 簡易クライアント側 NG（サーバー側でも再チェック） */
  const NG_WORDS = [
    "死ね",
    "殺す",
    "殺害",
    "暴力",
    "強姦",
    "レイプ",
    "裸体",
    "裸",
    "ポルノ",
    "エロ",
    "セックス",
    "児童",
    "わいせつ",
    "麻薬",
    "覚せい剤",
    "大麻",
  ];

  let hasConsented = false;
  let selectedImageFile = null;
  let selectedImageDataUrl = null;
  let loadingStatusTimerId = null;
  let objectUrlToRevoke = null;
  let toPostLock = false;
  let diagTimer = null;
  let diagToken = 0;

  const els = {
    screens: {
      top: document.getElementById(SCREENS.top),
      upload: document.getElementById(SCREENS.upload),
      loading: document.getElementById(SCREENS.loading),
      result: document.getElementById(SCREENS.result),
    },
    modal: document.getElementById("notice-modal"),
    modalBackdrop: document.getElementById("modal-backdrop"),
    btnStart: document.getElementById("btn-start"),
    btnAgree: document.getElementById("btn-agree"),
    btnDisagree: document.getElementById("btn-disagree"),
    btnSubmit: document.getElementById("btn-submit"),
    btnBackTop: document.getElementById("btn-back-top"),
    btnRetry: document.getElementById("btn-retry"),
    btnHome: document.getElementById("btn-home"),
    imageInput: document.getElementById("image-input"),
    imagePreview: document.getElementById("image-preview"),
    uploadArea: document.querySelector(".upload-area"),
    descriptionInput: document.getElementById("description-input"),
    descCount: document.getElementById("desc-count"),
    descError: document.getElementById("desc-error"),
    loadingStatus: document.getElementById("loading-status"),
    scorePhrase: document.getElementById("score-phrase"),
    matchImage: document.getElementById("match-image"),
    matchDescription: document.getElementById("match-description"),
    yoursImage: document.getElementById("yours-image"),
    yoursDescription: document.getElementById("yours-description"),
    resultNote: document.getElementById("result-note"),
  };

  function init() {
    bindEvents();
    updateSubmitEnabled();
    showTop();
    playOpening();
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function whenPageReady() {
    if (document.readyState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      window.addEventListener("load", () => resolve(), { once: true });
    });
  }

  const SPIN_MS = 2800;
  const TAU = Math.PI * 2;

  function pointOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rect,
    };
  }

  function cornerLayout() {
    const frameScale = Math.min(window.innerWidth / 402, window.innerHeight / 874);
    const size = 318 * frameScale;
    return {
      size,
      blue: { left: window.innerWidth - size / 2, top: -size / 2 },
      gold: { left: -size / 2, top: window.innerHeight - size / 2 },
    };
  }

  function commitAnimations(el) {
    el.getAnimations().forEach((anim) => {
      if (typeof anim.commitStyles === "function") anim.commitStyles();
      anim.cancel();
    });
  }

  function keepCornerCircles(root) {
    const layer = document.createElement("div");
    layer.className = "opening-corners";
    root.querySelectorAll(".opening-sat").forEach((sat) => {
      commitAnimations(sat);
      const fill = sat.querySelector(".opening-sat-fill");
      if (fill) commitAnimations(fill);
      const clickable = sat.classList.contains("opening-sat--blue") || sat.classList.contains("opening-sat--gold");
      sat.style.pointerEvents = clickable ? "auto" : "none";
      if (sat.classList.contains("opening-sat--blue") || sat.classList.contains("opening-sat--gold")) {
        sat.classList.add("has-eyes");
      }
      layer.appendChild(sat);
    });
    document.body.appendChild(layer);
    bindMenuButton();
    bindChatButton();
  }

  function bindMenuButton() {
    const button = document.querySelector(".opening-sat--blue");
    if (!button || button.dataset.menuBound) return;
    button.dataset.menuBound = "1";
    button.setAttribute("role", "button");
    button.tabIndex = 0;
    button.setAttribute("aria-label", "メニュー");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", toggleMenu);
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleMenu();
    });
  }

  function onPostScreen() {
    const upload = document.getElementById("screen-upload");
    return Boolean(upload && upload.classList.contains("is-active"));
  }

  function menuAnchor() {
    return onPostScreen() ? "0% 0%" : "100% 0%";
  }

  function syncMenuCurrent() {
    const key = onPostScreen() ? "post" : "top";
    document.querySelectorAll(".nav-item").forEach((item) => {
      const current = item.dataset.nav === key;
      item.classList.toggle("is-current", current);
      if (current) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }

  function shiftGoldCircle(outward) {
    const gold = document.querySelector(".opening-sat--gold");
    if (!gold) return;
    const radius = gold.getBoundingClientRect().width / 2;
    const distance = Math.hypot(window.innerWidth, window.innerHeight) || 1;
    const push = radius + 28;
    const xSign = onPostScreen() ? 1 : -1;
    const x = outward ? (xSign * window.innerWidth / distance) * push : 0;
    const y = outward ? (window.innerHeight / distance) * push : 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    gold.style.transition = reduce ? "none" : "transform 0.75s cubic-bezier(0.45, 0, 0.2, 1)";
    gold.style.transform = `translate(${x}px, ${y}px)`;
  }

  function bindChatButton() {
    const button = document.querySelector(".opening-sat--gold");
    if (!button || button.dataset.chatBound) return;
    button.dataset.chatBound = "1";
    button.setAttribute("role", "button");
    button.tabIndex = 0;
    button.setAttribute("aria-label", "チャット");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", toggleChat);
    const closeChatButton = document.querySelector(".chat-close");
    if (closeChatButton) closeChatButton.addEventListener("click", closeChat);
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleChat();
    });
  }

  function chatAnchor() {
    return onPostScreen() ? "100% 100%" : "0% 100%";
  }

  function shiftBlueCircle(outward) {
    const blue = document.querySelector(".opening-sat--blue");
    if (!blue) return;
    const radius = blue.getBoundingClientRect().width / 2;
    const distance = Math.hypot(window.innerWidth, window.innerHeight) || 1;
    const push = radius + 28;
    const xSign = onPostScreen() ? -1 : 1;
    const x = outward ? (xSign * window.innerWidth / distance) * push : 0;
    const y = outward ? (-window.innerHeight / distance) * push : 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    blue.style.transition = reduce ? "none" : "transform 0.75s cubic-bezier(0.45, 0, 0.2, 1)";
    blue.style.transform = `translate(${x}px, ${y}px)`;
  }

  function toggleChat() {
    const panel = document.getElementById("chat-panel");
    if (!panel) return;
    if (panel.classList.contains("is-open")) closeChat();
    else openChat();
  }

  function openChat() {
    const panel = document.getElementById("chat-panel");
    const button = document.querySelector(".opening-sat--gold");
    const menu = document.getElementById("nav-menu");
    if (menu && menu.classList.contains("is-open")) closeMenu();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const radius = Math.hypot(window.innerWidth, window.innerHeight);
    const anchor = chatAnchor();
    const ease = "clip-path 0.75s cubic-bezier(0.45, 0, 0.2, 1)";
    panel.hidden = false;
    document.body.classList.add("is-chat-open");
    if (button) {
      button.setAttribute("aria-expanded", "true");
      button.style.pointerEvents = "none";
    }
    shiftBlueCircle(true);
    panel.style.transition = "none";
    panel.style.clipPath = `circle(0px at ${anchor})`;
    void panel.offsetWidth;
    panel.style.transition = reduce ? "none" : ease;
    panel.style.clipPath = `circle(${radius}px at ${anchor})`;
    panel.classList.add("is-open");
    window.setTimeout(() => {
      if (!panel.classList.contains("is-open")) return;
      mountChatFrame();
    }, reduce ? 0 : 750);
  }

  function mountChatFrame() {
    const frame = document.querySelector(".chat-frame");
    if (!frame || frame.dataset.ready === "1" || !frame.dataset.src) return;
    frame.dataset.ready = "1";
    frame.src = frame.dataset.src;
  }

  function closeChat() {
    const panel = document.getElementById("chat-panel");
    const button = document.querySelector(".opening-sat--gold");
    const anchor = chatAnchor();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.classList.remove("is-open");
    if (button) button.setAttribute("aria-expanded", "false");
    shiftBlueCircle(false);
    panel.style.transition = reduce ? "none" : "clip-path 0.75s cubic-bezier(0.45, 0, 0.2, 1)";
    panel.style.clipPath = `circle(0px at ${anchor})`;
    const finish = () => {
      if (panel.classList.contains("is-open")) return;
      panel.hidden = true;
      document.body.classList.remove("is-chat-open");
      if (button) button.style.pointerEvents = "auto";
    };
    panel.addEventListener("transitionend", finish, { once: true });
    window.setTimeout(finish, reduce ? 0 : 800);
  }

  function toggleMenu() {
    const menu = document.getElementById("nav-menu");
    if (!menu) return;
    if (menu.classList.contains("is-open")) closeMenu();
    else openMenu();
  }

  function openMenu() {
    const menu = document.getElementById("nav-menu");
    const flood = menu.querySelector(".nav-menu-flood");
    const button = document.querySelector(".opening-sat--blue");
    const chat = document.getElementById("chat-panel");
    if (chat && chat.classList.contains("is-open")) closeChat();
    const radius = Math.hypot(window.innerWidth, window.innerHeight);
    const anchor = menuAnchor();
    menu.hidden = false;
    document.body.classList.add("is-menu-open");
    if (button) button.setAttribute("aria-expanded", "true");
    syncMenuCurrent();
    shiftGoldCircle(true);
    flood.style.transition = "none";
    flood.style.clipPath = `circle(0px at ${anchor})`;
    void flood.offsetWidth;
    flood.style.transition = "clip-path 0.75s cubic-bezier(0.45, 0, 0.2, 1)";
    flood.style.clipPath = `circle(${radius}px at ${anchor})`;
    menu.classList.add("is-open");
  }

  function closeMenu() {
    const menu = document.getElementById("nav-menu");
    const flood = menu.querySelector(".nav-menu-flood");
    const button = document.querySelector(".opening-sat--blue");
    const anchor = menuAnchor();
    menu.classList.remove("is-open");
    if (button) button.setAttribute("aria-expanded", "false");
    shiftGoldCircle(false);
    flood.style.clipPath = `circle(0px at ${anchor})`;
    const finish = () => {
      if (menu.classList.contains("is-open")) return;
      menu.hidden = true;
      document.body.classList.remove("is-menu-open");
    };
    flood.addEventListener("transitionend", finish, { once: true });
    window.setTimeout(finish, 800);
  }

  function placeFinalCorners(root) {
    const layout = cornerLayout();
    root.querySelectorAll(".opening-sat").forEach((sat) => {
      const kind = sat.classList.contains("opening-sat--blue") ? "blue" : "gold";
      const end = layout[kind];
      sat.style.position = "fixed";
      sat.style.margin = "0";
      sat.style.transform = "none";
      sat.style.left = `${end.left}px`;
      sat.style.top = `${end.top}px`;
      sat.style.width = `${layout.size}px`;
      sat.style.height = `${layout.size}px`;
      const svg = sat.querySelector("svg");
      const fill = sat.querySelector(".opening-sat-fill");
      if (svg) svg.style.opacity = "0";
      if (fill) fill.style.opacity = "1";
    });
    keepCornerCircles(root);
  }

  function cssRotation(el) {
    const transform = getComputedStyle(el).transform;
    if (!transform || transform === "none") return 0;
    const matrix = new DOMMatrix(transform);
    return Math.atan2(matrix.b, matrix.a);
  }

  /** 画面座標で時計回りの差分（0〜2π） */
  function clockwiseDelta(current, target) {
    return ((target - current) % TAU + TAU) % TAU;
  }

  /**
   * ロード中は中心の円を固定し、2円が周回する。
   * 完了後は斜めガイドの方向まで周回を続け、その円が右上・左下の大きい円になる。
   * #8FABFF は円より手前に広がり、#FFFFFF がそれを覆うとき円が現れる。
   */
  async function playOpening() {
    const root = document.getElementById("opening");
    if (!root) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.documentElement.classList.add("is-opening");

    const started = performance.now();
    const minSpinMs = reduceMotion ? 0 : 1700;
    await whenPageReady();
    const remaining = minSpinMs - (performance.now() - started);
    if (remaining > 0) await delay(remaining);

    if (reduceMotion) {
      placeFinalCorners(root);
      root.classList.add("is-done");
      root.hidden = true;
      document.documentElement.classList.remove("is-opening");
      return;
    }

    const cover = Math.hypot(window.innerWidth, window.innerHeight) / 2 + 4;
    root.style.setProperty("--opening-cover", `${cover}px`);

    const rotor = root.querySelector(".opening-rotor");
    const stage = root.querySelector(".opening-stage");
    const blue = root.querySelector(".opening-sat--blue");
    const gold = root.querySelector(".opening-sat--gold");

    const angle = cssRotation(rotor);
    rotor.style.animation = "none";
    rotor.style.transform = `rotate(${angle}rad)`;

    const origin = pointOf(stage);
    const bluePoint = pointOf(blue);
    const current = Math.atan2(bluePoint.y - origin.y, bluePoint.x - origin.x);
    const towardTopRight = Math.atan2(-origin.y, window.innerWidth - origin.x);
    const delta = clockwiseDelta(current, towardTopRight);
    const alignMs = Math.max(380, (delta / TAU) * SPIN_MS);

    if (delta > 0.02) {
      const align = rotor.animate(
        [
          { transform: `rotate(${angle}rad)` },
          { transform: `rotate(${angle + delta}rad)` },
        ],
        { duration: alignMs, easing: "linear", fill: "forwards" }
      );
      await align.finished;
      rotor.style.transform = `rotate(${angle + delta}rad)`;
      align.cancel();
    }

    const frameScale = Math.min(window.innerWidth / 402, window.innerHeight / 874);
    const cornerSize = 318 * frameScale;
    const destinations = {
      blue: { left: window.innerWidth - cornerSize / 2, top: -cornerSize / 2 },
      gold: { left: -cornerSize / 2, top: window.innerHeight - cornerSize / 2 },
    };

    const travelMs = 1100;
    const travelEasing = "cubic-bezier(0.45, 0, 0.2, 1)";
    const reveal = document.createElement("div");
    reveal.className = "opening-reveal";
    root.appendChild(reveal);

    const travels = [blue, gold].map((sat) => {
      const { x, y } = pointOf(sat);
      const kind = sat.classList.contains("opening-sat--blue") ? "blue" : "gold";
      const end = destinations[kind];
      const svg = sat.querySelector("svg");
      const fill = sat.querySelector(".opening-sat-fill");
      const startSize = 68;
      const startLeft = x - startSize / 2;
      const startTop = y - startSize / 2;

      reveal.appendChild(sat);
      sat.style.position = "absolute";
      sat.style.margin = "0";
      sat.style.left = `${startLeft}px`;
      sat.style.top = `${startTop}px`;
      sat.style.width = `${startSize}px`;
      sat.style.height = `${startSize}px`;
      sat.style.transform = "none";
      sat.style.zIndex = "auto";

      if (svg) {
        svg.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 320,
          easing: "ease",
          fill: "forwards",
        });
      }
      if (fill) {
        fill.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 320,
          easing: "ease",
          fill: "forwards",
        });
      }

      return sat.animate(
        [
          {
            left: `${startLeft}px`,
            top: `${startTop}px`,
            width: `${startSize}px`,
            height: `${startSize}px`,
          },
          {
            left: `${end.left}px`,
            top: `${end.top}px`,
            width: `${cornerSize}px`,
            height: `${cornerSize}px`,
          },
        ],
        { duration: travelMs, easing: travelEasing, fill: "forwards" }
      ).finished;
    });

    await Promise.all(travels);

    root.classList.remove("is-spinning");
    root.classList.add("is-blue");
    await delay(1220);

    const coverRadius = root.style.getPropertyValue("--opening-cover") || "800px";
    reveal.style.transition = "none";
    reveal.style.clipPath = "circle(0px at 50% 50%)";
    reveal.style.zIndex = "5";
    void reveal.offsetWidth;
    reveal.style.transition = "clip-path 1.15s cubic-bezier(0.42, 0, 0.18, 1)";
    reveal.style.clipPath = `circle(${coverRadius} at 50% 50%)`;
    root.classList.add("is-white");
    await delay(1650);

    keepCornerCircles(root);
    root.classList.add("is-exit");
    await delay(460);

    root.classList.add("is-done");
    root.hidden = true;
    document.documentElement.classList.remove("is-opening");
  }

  function bindEvents() {
    els.btnStart.addEventListener("click", openNoticeModal);
    els.btnAgree.addEventListener("click", onAgree);
    els.btnDisagree.addEventListener("click", closeNoticeModal);
    els.modalBackdrop.addEventListener("click", closeNoticeModal);

    els.imageInput.addEventListener("change", onImageSelected);
    const postPhotoInput = document.getElementById("post-photo-input");
    if (postPhotoInput) postPhotoInput.addEventListener("change", onImageSelected);
    els.descriptionInput.addEventListener("input", onDescriptionInput);
    els.btnSubmit.addEventListener("click", onSubmit);
    els.btnBackTop.addEventListener("click", resetToTop);
    els.btnRetry.addEventListener("click", retryUpload);
    els.btnHome.addEventListener("click", resetToTop);
    const topItem = document.querySelector('.nav-item[data-nav="top"]');
    if (topItem) topItem.addEventListener("click", closeMenu);
    const postGreen = document.getElementById("btn-post-green");
    if (postGreen) {
      postGreen.addEventListener("click", () => {
        const stage = postGreen.closest(".post-stage");
        if (!stage || stage.classList.contains("is-green-open")) return;
        stage.classList.add("is-green-open");
        postGreen.setAttribute("aria-expanded", "true");
      });
    }
  }

  function switchScreen(screenKey) {
    Object.entries(els.screens).forEach(([key, el]) => {
      const isTarget = key === screenKey;
      if (!isTarget) {
        el.style.opacity = "";
        el.style.animation = "";
        el.style.transition = "";
      }
      el.classList.toggle("is-active", isTarget);
      el.hidden = !isTarget;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showTop() {
    clearLoadingTimers();
    switchScreen("top");
  }

  function showUpload() {
    clearLoadingTimers();
    switchScreen("upload");
  }

  function showLoading() {
    switchScreen("loading");
    startLoadingMessages();
  }

  function showResult(payload) {
    clearLoadingTimers();
    renderResult(payload);
    switchScreen("result");
  }

  function openNoticeModal() {
    els.modal.hidden = false;
    els.btnAgree.focus();
  }

  function closeNoticeModal() {
    els.modal.hidden = true;
  }

  function onAgree() {
    if (toPostLock) return;
    hasConsented = true;
    playStartToPost();
  }

  function dismissNotice() {
    if (els.modal.hidden) return Promise.resolve();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      closeNoticeModal();
      return Promise.resolve();
    }
    els.modal.classList.add("is-leaving");
    return new Promise((resolve) => {
      setTimeout(() => {
        closeNoticeModal();
        els.modal.classList.remove("is-leaving");
        resolve();
      }, 200);
    });
  }

  function commitAnim(el, anim, styles) {
    return anim.finished.then(() => {
      Object.assign(el.style, styles);
      anim.cancel();
    });
  }

  function postCornerLayout() {
    const layout = cornerLayout();
    return {
      size: layout.size,
      blue: { left: -layout.size / 2, top: -layout.size / 2 },
      gold: { left: window.innerWidth - layout.size / 2, top: window.innerHeight - layout.size / 2 },
    };
  }

  function placePostCorners() {
    const blue = document.querySelector(".opening-sat--blue");
    const gold = document.querySelector(".opening-sat--gold");
    const layout = postCornerLayout();
    [blue, gold].forEach((sat) => {
      if (!sat) return;
      sat.getAnimations().forEach((anim) => anim.cancel());
      sat.style.transition = "none";
      sat.style.transform = "none";
    });
    if (blue) {
      blue.style.left = `${layout.blue.left}px`;
      blue.style.top = `${layout.blue.top}px`;
      blue.style.pointerEvents = "none";
      blue.classList.add("is-face-left");
    }
    if (gold) {
      gold.style.left = `${layout.gold.left}px`;
      gold.style.top = `${layout.gold.top}px`;
      gold.classList.add("is-face-right");
    }
  }

  function restoreTopScene() {
    const layout = cornerLayout();
    const blue = document.querySelector(".opening-sat--blue");
    const gold = document.querySelector(".opening-sat--gold");
    if (blue) {
      blue.getAnimations().forEach((anim) => anim.cancel());
      blue.style.transition = "none";
      blue.style.transform = "none";
      blue.style.left = `${layout.blue.left}px`;
      blue.style.top = `${layout.blue.top}px`;
      blue.style.pointerEvents = "auto";
      blue.classList.remove("is-face-left");
    }
    if (gold) {
      gold.getAnimations().forEach((anim) => anim.cancel());
      gold.style.transition = "none";
      gold.style.transform = "none";
      gold.style.left = `${layout.gold.left}px`;
      gold.style.top = `${layout.gold.top}px`;
      gold.classList.remove("is-face-right");
    }
  }

  /**
   * 波の背景はそのままに、円だけ投稿画面の角へ移す。START ボタンは動かさない。
   * 青は右上から左上へ。黄はいったん画面外へ出てから右下に入る。
   */
  async function slideScreenAside() {
    const ease = "cubic-bezier(0.45, 0, 0.2, 1)";
    const blue = document.querySelector(".opening-sat--blue");
    const gold = document.querySelector(".opening-sat--gold");
    if (!blue || !gold) return;

    const menu = document.getElementById("nav-menu");
    if (menu && menu.classList.contains("is-open")) closeMenu();
    blue.classList.add("is-face-left");
    blue.style.pointerEvents = "none";
    blue.style.transition = "none";
    blue.style.transform = "none";
    gold.style.transition = "none";
    gold.style.transform = "none";

    const layout = postCornerLayout();
    const blueStart = blue.getBoundingClientRect();
    const goldStart = gold.getBoundingClientRect();
    const size = blueStart.width || layout.size;
    const goldOff = {
      left: -size - 20,
      top: window.innerHeight + 20,
    };
    const goldEnterFrom = {
      left: window.innerWidth + 20,
      top: window.innerHeight - size / 2,
    };

    const blueAnim = blue.animate(
      [
        { left: `${blueStart.left}px`, top: `${blueStart.top}px` },
        { left: `${layout.blue.left}px`, top: `${layout.blue.top}px` },
      ],
      { duration: 820, easing: ease, fill: "forwards" }
    );
    const goldExit = gold.animate(
      [
        { left: `${goldStart.left}px`, top: `${goldStart.top}px` },
        { left: `${goldOff.left}px`, top: `${goldOff.top}px` },
      ],
      { duration: 380, easing: ease, fill: "forwards" }
    );

    await goldExit.finished;
    gold.classList.add("is-face-right");
    gold.style.left = `${goldEnterFrom.left}px`;
    gold.style.top = `${goldEnterFrom.top}px`;
    goldExit.cancel();

    const goldEnter = gold.animate(
      [
        { left: `${goldEnterFrom.left}px`, top: `${goldEnterFrom.top}px` },
        { left: `${layout.gold.left}px`, top: `${layout.gold.top}px` },
      ],
      { duration: 440, easing: ease, fill: "forwards" }
    );

    await Promise.all([blueAnim.finished, goldEnter.finished]);
    blue.style.left = `${layout.blue.left}px`;
    blue.style.top = `${layout.blue.top}px`;
    blue.style.transform = "none";
    blueAnim.cancel();
    gold.style.left = `${layout.gold.left}px`;
    gold.style.top = `${layout.gold.top}px`;
    gold.style.transform = "none";
    goldEnter.cancel();
  }

  function clearStartMorph() {
    const btn = els.btnStart;
    if (!btn) return;
    btn.getAnimations().forEach((anim) => anim.cancel());
    btn.querySelectorAll(".top-start-label, .top-start-icon").forEach((el) => {
      el.getAnimations().forEach((anim) => anim.cancel());
      el.style.opacity = "";
    });
    btn.querySelectorAll(".top-start-bloom, .top-start-orb").forEach((el) => el.remove());
    btn.style.cssText = "";
    btn.classList.remove("is-morph");
    btn.disabled = false;
    document.body.classList.remove("is-to-post");
    toPostLock = false;
  }

  /**
   * 画面を右へ送って円を移してから、START ボタンが投稿画面になる。
   */
  async function playStartToPost() {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      closeNoticeModal();
      placePostCorners();
      showUpload();
      const blue = document.querySelector(".opening-sat--blue");
      if (blue) blue.style.pointerEvents = "auto";
      return;
    }

    toPostLock = true;
    await dismissNotice();

    const btn = els.btnStart;
    const stage = btn.closest(".top-stage");
    const stageRect = stage.getBoundingClientRect();
    const start = btn.getBoundingClientRect();
    const ease = "cubic-bezier(0.45, 0, 0.2, 1)";
    const left0 = start.left - stageRect.left;
    const top0 = start.top - stageRect.top;
    const centerX = left0 + start.width / 2;

    document.body.classList.add("is-to-post");
    btn.disabled = true;
    btn.classList.add("is-morph");
    btn.style.left = `${left0}px`;
    btn.style.top = `${top0}px`;
    btn.style.width = `${start.width}px`;
    btn.style.height = `${start.height}px`;
    btn.style.borderRadius = "36px";

    try {
      await slideScreenAside();

      const fadeOpts = { duration: 420, easing: "ease-out", fill: "forwards" };
      btn.querySelectorAll(".top-start-label, .top-start-icon").forEach((el) => {
        el.animate([{ opacity: 1 }, { opacity: 0 }], fadeOpts);
      });

      const endLeft = centerX - stageRect.width / 2;
      await commitAnim(
        btn,
        btn.animate(
          [
            { left: `${left0}px`, width: `${start.width}px`, borderRadius: "36px" },
            { left: `${endLeft}px`, width: `${stageRect.width}px`, borderRadius: "0px" },
          ],
          { duration: 560, easing: ease, fill: "forwards" }
        ),
        { left: "0px", width: `${stageRect.width}px`, borderRadius: "0px", transform: "none" }
      );

      await commitAnim(
        btn,
        btn.animate(
          [
            { top: `${top0}px`, height: `${start.height}px` },
            { top: "0px", height: `${stageRect.height}px` },
          ],
          { duration: 680, easing: ease, fill: "forwards" }
        ),
        { top: "0px", height: `${stageRect.height}px` }
      );

      const band = stageRect.height * (41 / 874);
      const mid = stageRect.height / 2;
      const maskImage = "linear-gradient(#000 0 0), linear-gradient(#000 0 0)";
      const closedMask = `100% ${mid}px, 100% ${mid}px`;
      const openMask = `100% ${band}px, 100% ${band}px`;
      btn.style.maskImage = maskImage;
      btn.style.webkitMaskImage = maskImage;
      btn.style.maskRepeat = "no-repeat, no-repeat";
      btn.style.webkitMaskRepeat = "no-repeat, no-repeat";
      btn.style.maskPosition = "center top, center bottom";
      btn.style.webkitMaskPosition = "center top, center bottom";
      btn.style.maskSize = closedMask;
      btn.style.webkitMaskSize = closedMask;

      await commitAnim(
        btn,
        btn.animate(
          [{ maskSize: closedMask }, { maskSize: openMask }],
          { duration: 680, easing: ease, fill: "forwards" }
        ),
        { maskSize: openMask, webkitMaskSize: openMask }
      );

      const upload = els.screens.upload;
      upload.style.transition = "none";
      upload.style.animation = "none";
      upload.style.opacity = "1";
      upload.style.visibility = "visible";
      upload.hidden = false;
      upload.classList.add("is-active");
      showUpload();
    } catch (err) {
      placePostCorners();
      showUpload();
    } finally {
      clearStartMorph();
      if (onPostScreen()) {
        const blue = document.querySelector(".opening-sat--blue");
        if (blue) blue.style.pointerEvents = "auto";
      }
    }
  }

  function beginDiagnosis(file) {
    const token = ++diagToken;
    const stage = document.querySelector(".post-stage");
    const matchTask = requestMatch({
      file,
      description: "写真",
      previewUrl: selectedImageDataUrl || "",
    }).catch(() => null);
    if (diagTimer) window.clearTimeout(diagTimer);
    diagTimer = window.setTimeout(() => {
      if (token !== diagToken || !stage) return;
      stage.classList.remove("is-result");
      stage.classList.add("is-diagnosing");
    }, 420);
    Promise.all([matchTask, delay(3420)]).then(([payload]) => {
      if (token !== diagToken) return;
      revealPostResult(payload);
    });
  }

  function revealPostResult(payload) {
    const stage = document.querySelector(".post-stage");
    const matchImg = document.getElementById("post-result-match");
    const yoursImg = document.getElementById("post-result-yours");
    if (yoursImg && selectedImageDataUrl) {
      yoursImg.src = selectedImageDataUrl;
      yoursImg.hidden = false;
    }
    const matchUrl = payload && payload.match && payload.match.imageUrl;
    const note = document.getElementById("post-result-note");
    if (matchImg) {
      if (matchUrl) {
        matchImg.src = resolveMediaUrl(matchUrl);
        matchImg.hidden = false;
      } else {
        matchImg.removeAttribute("src");
        matchImg.hidden = true;
      }
    }
    if (note) {
      note.hidden = Boolean(matchUrl);
      note.textContent = matchUrl
        ? ""
        : location.protocol === "file:"
          ? "ファイルを直接開いているため照合できません。GitHub Pages の公開URLか、npm start で開いた http://localhost:3000 を使ってください。"
          : "照合できませんでした。もう一度写真を選んでください。";
    }
    if (!stage) return;
    stage.classList.remove("is-diagnosing");
    stage.classList.add("is-result");
  }

  function onImageSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      clearPreview();
      return;
    }

    if (!file.type.startsWith("image/")) {
      setDescError("画像ファイルを選択してください。");
      clearPreview();
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setDescError("画像サイズは5MB以下にしてください。");
      clearPreview();
      return;
    }

    setDescError("");
    selectedImageFile = file;

    const reader = new FileReader();
    reader.onload = () => {
      selectedImageDataUrl = reader.result;
      els.imagePreview.src = selectedImageDataUrl;
      els.imagePreview.hidden = false;
      const postPhoto = document.getElementById("post-photo-preview");
      if (postPhoto) {
        postPhoto.src = selectedImageDataUrl;
        postPhoto.hidden = false;
      }
      els.uploadArea.classList.add("has-preview");
      updateSubmitEnabled();
      if (event.target && event.target.id === "post-photo-input") {
        beginDiagnosis(file);
      }
    };
    reader.readAsDataURL(file);
  }

  function clearPreview() {
    selectedImageFile = null;
    selectedImageDataUrl = null;
    els.imageInput.value = "";
    const postPhotoInput = document.getElementById("post-photo-input");
    if (postPhotoInput) postPhotoInput.value = "";
    els.imagePreview.removeAttribute("src");
    els.imagePreview.hidden = true;
    const postPhoto = document.getElementById("post-photo-preview");
    if (postPhoto) {
      postPhoto.removeAttribute("src");
      postPhoto.hidden = true;
    }
    els.uploadArea.classList.remove("has-preview");
    updateSubmitEnabled();
  }

  function onDescriptionInput() {
    const value = els.descriptionInput.value;
    els.descCount.textContent = String(value.length);
    validateDescriptionClient(value, false);
    updateSubmitEnabled();
  }

  function setDescError(message) {
    if (!message) {
      els.descError.hidden = true;
      els.descError.textContent = "";
      return;
    }
    els.descError.hidden = false;
    els.descError.textContent = message;
  }

  function validateDescriptionClient(raw, showEmptyError) {
    const text = String(raw || "").trim();
    if (!text) {
      if (showEmptyError) setDescError(`説明文は${MIN_DESC}文字以上で入力してください。`);
      else setDescError("");
      return false;
    }
    if (text.length < MIN_DESC) {
      setDescError(`説明文は${MIN_DESC}文字以上で入力してください。`);
      return false;
    }
    if (text.length > MAX_DESC) {
      setDescError(`説明文は${MAX_DESC}文字以内にしてください。`);
      return false;
    }
    const lower = text.toLowerCase();
    const hit = NG_WORDS.find((w) => lower.includes(w.toLowerCase()));
    if (hit) {
      setDescError("不適切な表現が含まれているため投稿できません。");
      return false;
    }
    setDescError("");
    return true;
  }

  function updateSubmitEnabled() {
    const descOk = validateDescriptionClient(els.descriptionInput.value, false);
    const ready = Boolean(hasConsented && selectedImageFile && descOk);
    els.btnSubmit.disabled = !ready;
  }

  async function onSubmit() {
    if (!hasConsented) {
      openNoticeModal();
      return;
    }
    if (!selectedImageFile) return;
    if (!validateDescriptionClient(els.descriptionInput.value, true)) return;

    showLoading();

    try {
      const data = await requestMatch({
        file: selectedImageFile,
        description: els.descriptionInput.value.trim(),
        previewUrl: selectedImageDataUrl,
      });
      showResult(data);
    } catch (err) {
      clearLoadingTimers();
      alert(err.message || "マッチに失敗しました。もう一度お試しください。");
      showUpload();
    }
  }

  function startLoadingMessages() {
    clearLoadingTimers();
    let stepIndex = 0;
    els.loadingStatus.textContent = LOADING_MESSAGES[0];
    els.loadingStatus.classList.remove("is-fading");

    loadingStatusTimerId = setInterval(() => {
      stepIndex += 1;
      if (stepIndex >= LOADING_MESSAGES.length) {
        clearInterval(loadingStatusTimerId);
        loadingStatusTimerId = null;
        return;
      }
      updateLoadingStatus(LOADING_MESSAGES[stepIndex]);
    }, LOADING_STEP_MS);
  }

  function updateLoadingStatus(text) {
    els.loadingStatus.classList.add("is-fading");
    setTimeout(() => {
      els.loadingStatus.textContent = text;
      els.loadingStatus.classList.remove("is-fading");
    }, 200);
  }

  function clearLoadingTimers() {
    if (loadingStatusTimerId) {
      clearInterval(loadingStatusTimerId);
      loadingStatusTimerId = null;
    }
  }

  /**
   * POST /api/match
   * @param {{ file: File, description: string, previewUrl: string }} payload
   */
  async function requestMatchFromServer(payload) {
    const form = new FormData();
    form.append("image", payload.file);
    form.append("description", payload.description);

    let res;
    try {
      res = await fetch(apiUrl("/api/match"), {
        method: "POST",
        body: form,
      });
    } catch {
      const error = new Error("照合サーバーに接続できません。");
      error.isNetwork = true;
      throw error;
    }

    let body;
    try {
      body = await res.json();
    } catch {
      const error = new Error("サーバーからの応答を読めませんでした。");
      error.isNetwork = !res.ok;
      throw error;
    }

    if (!res.ok || !body.ok) {
      throw new Error(body.error || "マッチに失敗しました。");
    }

    return {
      ...body,
      localPreviewUrl: payload.previewUrl,
    };
  }

  /**
   * サーバーがあれば投稿を保存して照合する。
   * GitHub Pages のように API が無いときは、同梱シード画像だけで照合する。
   */
  async function requestMatch(payload) {
    if (await serverAvailable()) {
      try {
        return await requestMatchFromServer(payload);
      } catch (err) {
        if (!err || !err.isNetwork) throw err;
        serverMode = false;
      }
    }

    const local = await matchAgainstSeeds(payload.file);
    return {
      ...local,
      yours: {
        description: payload.description,
        imageUrl: "",
      },
      localPreviewUrl: payload.previewUrl,
    };
  }

  function renderResult(data) {
    els.scorePhrase.textContent = data.scorePhrase || "予期せぬ一枚";
    els.matchImage.src = resolveMediaUrl(data.match.imageUrl);
    els.matchDescription.textContent = data.match.description;

    const yoursUrl = data.localPreviewUrl || resolveMediaUrl(data.yours?.imageUrl || "");
    els.yoursImage.src = yoursUrl;
    els.yoursDescription.textContent = data.yours?.description || "";

    if (data.method === "random") {
      els.resultNote.hidden = false;
      els.resultNote.textContent = "似た投稿が少なかったため、偶然の一枚を選びました。";
    } else {
      els.resultNote.hidden = true;
      els.resultNote.textContent = "";
    }
  }

  function resetUploadState() {
    clearPreview();
    els.descriptionInput.value = "";
    els.descCount.textContent = "0";
    setDescError("");
    updateSubmitEnabled();
  }

  function resetToTop() {
    clearLoadingTimers();
    clearStartMorph();
    restoreTopScene();
    resetUploadState();
    const stage = document.querySelector(".post-stage");
    const postGreen = document.getElementById("btn-post-green");
    diagToken += 1;
    if (diagTimer) {
      window.clearTimeout(diagTimer);
      diagTimer = null;
    }
    if (stage) {
      stage.classList.remove("is-green-open");
      stage.classList.remove("is-diagnosing");
      stage.classList.remove("is-result");
    }
    ["post-result-match", "post-result-yours"].forEach((id) => {
      const img = document.getElementById(id);
      if (!img) return;
      img.removeAttribute("src");
      img.hidden = true;
    });
    const resultNote = document.getElementById("post-result-note");
    if (resultNote) {
      resultNote.hidden = true;
      resultNote.textContent = "";
    }
    if (postGreen) postGreen.setAttribute("aria-expanded", "false");
    // 同意はセッション内で維持（毎回モーダルを出すなら hasConsented = false）
    showTop();
  }

  function retryUpload() {
    clearLoadingTimers();
    resetUploadState();
    if (!hasConsented) {
      openNoticeModal();
      return;
    }
    showUpload();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
