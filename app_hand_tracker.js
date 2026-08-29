// Hand-Controlled Word/Syllable Annotator
// Enhanced with WebSocket hand tracking support
//
// Everything runs client-side except hand tracking, which uses a Python server

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

const state = {
  audioCtx: null,
  audioBuffer: null,
  fileName: "",
  duration: 0,

  pxPerSecond: 120,
  specImage: null,

  words: [],
  nextId: 1,
  selectedWordId: null,
  selectedSyllableId: null,

  tool: "annotate",
  mode: "word",

  // Push & Lock Settings
  lockLineTime: 0,
  pushDirection: "forward",
  pushStyle: "block",

  // playback
  sourceNode: null,
  playing: false,
  playStartCtxTime: 0,
  playOffset: 0,
  playEndOffset: null,

  // drag
  drag: null,

  // Hand tracking
  handTrackingEnabled: false,
  socket: null,
  pauseDuration: 500,  // ms
  gestureSensitivity: 0.05,
  deadzoneThreshold: 0.02,
  enableHandVis: false,
  autoPlayTimeout: null,
  lastWordPlayTime: 0,
  handPositions: { left: null, right: null },
  wordBoundaryFromHands: false
};

const SPEC_HEIGHT = 300;
const WORD_LANE_Y = SPEC_HEIGHT;
const WORD_LANE_H = 60;
const SYLL_LANE_Y = WORD_LANE_Y + WORD_LANE_H;
const SYLL_LANE_H = 50;
const TOTAL_H = SYLL_LANE_Y + SYLL_LANE_H;
const HANDLE_PX = 6;
const MIN_WORD_DUR = 0.05;
const MIN_SYLL_DUR = 0.02;

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------

const els = {
  fileInput: document.getElementById("fileInput"),
  fileName: document.getElementById("fileName"),
  status: document.getElementById("status"),
  canvasScroll: document.getElementById("canvasScroll"),
  canvasStack: document.getElementById("canvasStack"),
  specCanvas: document.getElementById("specCanvas"),
  overlayCanvas: document.getElementById("overlayCanvas"),
  wordList: document.getElementById("wordList"),
  wordCount: document.getElementById("wordCount"),
  toolAnnotate: document.getElementById("toolAnnotate"),
  toolPlayback: document.getElementById("toolPlayback"),
  modeWord: document.getElementById("modeWord"),
  modeSyllable: document.getElementById("modeSyllable"),
  pushDirectionToggle: document.getElementById("pushDirectionToggle"),
  pushStyleToggle: document.getElementById("pushStyleToggle"),
  syllableControls: document.getElementById("syllableControls"),
  syllableSource: document.getElementById("syllableSource"),
  splitSyllable: document.getElementById("splitSyllable"),
  mergeSyllable: document.getElementById("mergeSyllable"),
  zoomIn: document.getElementById("zoomIn"),
  zoomOut: document.getElementById("zoomOut"),
  exportBtn: document.getElementById("exportBtn"),
  importInput: document.getElementById("importInput"),
  importTxtInput: document.getElementById("importTxtInput"),
  
  // Hand tracking elements
  handTrackingToggle: document.getElementById("handTrackingToggle"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  pauseDuration: document.getElementById("pauseDuration"),
  gestureSensitivity: document.getElementById("gestureSensitivity"),
  deadzoneThreshold: document.getElementById("deadzoneThreshold"),
  cameraSelect: document.getElementById("cameraSelect"),
  enableHandVis: document.getElementById("enableHandVis"),
  saveSettings: document.getElementById("saveSettings"),
  closeSettings: document.getElementById("closeSettings"),
  handStatus: document.getElementById("handStatus"),
  handVisualization: document.getElementById("handVisualization"),
  handVisCanvas: document.getElementById("handVisCanvas")
};

function setStatus(msg, ms = 3000) {
  els.status.textContent = msg;
  if (ms) setTimeout(() => { if (els.status.textContent === msg) els.status.textContent = ""; }, ms);
}

// ---------------------------------------------------------------------
// Hand Tracking WebSocket
// ---------------------------------------------------------------------

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;
  const port = window.location.port || (protocol === 'wss:' ? 443 : 80);
  const wsUrl = `${protocol}//${host}:${port === 80 ? 5000 : port}`;
  
  try {
    state.socket = new WebSocket(wsUrl + '/socket.io/?EIO=4&transport=websocket');
    
    state.socket.onopen = () => {
      console.log('WebSocket connected');
      setStatus('Connected to hand tracker', 2000);
      
      // Request camera list
      fetch('/api/cameras')
        .then(res => res.json())
        .then(data => {
          populateCameraList(data.cameras);
        });
    };
    
    state.socket.onmessage = (event) => {
      try {
        // Handle Socket.IO protocol messages
        if (event.data.startsWith('0{"sid"')) {
          // Connection acknowledgment, ignore
          return;
        }
        
        // Parse hand data
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (e) {
          // Might be Socket.IO ping/pong
          return;
        }
        
        if (data.type === 'hand_positions') {
          state.handPositions = {
            left: data.left,
            right: data.right
          };
          updateHandStatus();
          if (state.handTrackingEnabled) {
            processHandPositions();
          }
          if (state.enableHandVis) {
            drawHandVisualization();
          }
        } else if (data.type === 'gesture') {
          handleGesture(data.gesture);
        } else if (data.type === 'error') {
          setStatus(`Error: ${data.message}`);
        }
      } catch (e) {
        console.error('WebSocket error:', e);
      }
    };
    
    state.socket.onclose = () => {
      console.log('WebSocket disconnected');
      setStatus('Hand tracker disconnected', 2000);
      setTimeout(initWebSocket, 5000);  // Reconnect after 5 seconds
    };
    
    state.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      setStatus('WebSocket error: ' + error.message, 3000);
    };
    
  } catch (e) {
    console.error('WebSocket init error:', e);
    setStatus('WebSocket not available, hand tracking disabled', 3000);
  }
}

function sendSocketMessage(type, data = {}) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  
  const message = JSON.stringify({ type, ...data });
  try {
    state.socket.send(message);
  } catch (e) {
    console.error('Error sending WebSocket message:', e);
  }
}

function populateCameraList(cameras) {
  els.cameraSelect.innerHTML = '';
  cameras.forEach(cam => {
    const option = document.createElement('option');
    option.value = cam;
    option.textContent = `Camera ${cam}`;
    els.cameraSelect.appendChild(option);
  });
  
  if (cameras.length > 0) {
    els.cameraSelect.value = cameras[0];
  }
}

function updateHandStatus() {
  const left = state.handPositions.left;
  const right = state.handPositions.right;
  
  let status = '';
  if (left && right) {
    status = `L:${left.x.toFixed(2)}, R:${right.x.toFixed(2)}`;
  } else if (left) {
    status = `L:${left.x.toFixed(2)}`;
  } else if (right) {
    status = `R:${right.x.toFixed(2)}`;
  } else {
    status = 'No hands detected';
  }
  
  els.handStatus.textContent = status;
}

function drawHandVisualization() {
  const canvas = els.handVisCanvas;
  const ctx = canvas.getContext('2d');
  
  // Set canvas size
  canvas.width = 150;
  canvas.height = 100;
  
  // Clear
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  const left = state.handPositions.left;
  const right = state.handPositions.right;
  
  // Draw hands
  if (left) {
    ctx.fillStyle = '#5fb0ff';
    ctx.fillRect(
      left.x * canvas.width - 10,
      left.y * canvas.height - 10,
      20, 20
    );
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.fillText('L', left.x * canvas.width - 5, left.y * canvas.height + 5);
  }
  
  if (right) {
    ctx.fillStyle = '#ffb454';
    ctx.fillRect(
      right.x * canvas.width - 10,
      right.y * canvas.height - 10,
      20, 20
    );
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.fillText('R', right.x * canvas.width - 5, right.y * canvas.height + 5);
  }
}

// ---------------------------------------------------------------------
// Hand Position Processing
// ---------------------------------------------------------------------

function processHandPositions() {
  const left = state.handPositions.left;
  const right = state.handPositions.right;
  
  if (!left || !right) {
    state.wordBoundaryFromHands = false;
    return;
  }
  
  const selected = selectedWord();
  if (!selected || state.mode !== 'word') {
    return;
  }
  
  // Convert hand x positions to time values
  const startTime = left.x * state.duration;
  const endTime = right.x * state.duration;
  
  // Ensure valid duration
  const duration = endTime - startTime;
  if (duration < MIN_WORD_DUR) {
    return;
  }
  
  // Apply deadzone to prevent jitter
  const deadzone = state.deadzoneThreshold * state.duration;
  
  if (Math.abs(startTime - selected.start) > deadzone || 
      Math.abs(endTime - selected.end) > deadzone) {
    
    // Update word boundaries
    selected.start = Math.max(state.lockLineTime, startTime);
    selected.end = Math.max(selected.start + MIN_WORD_DUR, endTime);
    
    // Sync syllables
    syncWordEdgeToSyllables(selected, 'start');
    syncWordEdgeToSyllables(selected, 'end');
    
    state.wordBoundaryFromHands = true;
    
    // Update UI
    drawOverlay();
    renderWordList();
    
    // Cancel any pending auto-play and restart
    if (state.autoPlayTimeout) {
      clearTimeout(state.autoPlayTimeout);
    }
    startAutoPlay();
  }
}

function handleGesture(gesture) {
  if (!state.handTrackingEnabled) return;
  
  const selected = selectedWord();
  const words = [...state.words].sort((a, b) => a.start - b.start);
  
  if (gesture === 'double_grow') {
    // Advance to next word
    if (selected) {
      const currentIndex = words.findIndex(w => w.id === selected.id);
      if (currentIndex < words.length - 1) {
        selectWord(words[currentIndex + 1].id);
        const x = timeToX(words[currentIndex + 1].start);
        els.canvasScroll.scrollLeft = Math.max(0, x - 100);
        drawOverlay();
        renderWordList();
        startAutoPlay();
      }
    } else if (words.length > 0) {
      selectWord(words[0].id);
      startAutoPlay();
    }
    
  } else if (gesture === 'double_shrink') {
    // Go to previous word
    if (selected) {
      const currentIndex = words.findIndex(w => w.id === selected.id);
      if (currentIndex > 0) {
        selectWord(words[currentIndex - 1].id);
        const x = timeToX(words[currentIndex - 1].start);
        els.canvasScroll.scrollLeft = Math.max(0, x - 100);
        drawOverlay();
        renderWordList();
        startAutoPlay();
      }
    }
  }
  
  setStatus(`Gesture: ${gesture}`, 1000);
}

// ---------------------------------------------------------------------
// Auto-Play Functionality
// ---------------------------------------------------------------------

function startAutoPlay() {
  if (!state.handTrackingEnabled) return;
  
  const selected = selectedWord();
  if (!selected) {
    stopAutoPlay();
    return;
  }
  
  // Stop current playback
  stopPlayback();
  
  // Play the selected word
  playFrom(selected.start, selected.end);
  
  // Schedule next play
  state.autoPlayTimeout = setTimeout(() => {
    const stillSelected = selectedWord();
    if (stillSelected && stillSelected.id === selected.id) {
      startAutoPlay();
    }
  }, state.pauseDuration);
}

function stopAutoPlay() {
  if (state.autoPlayTimeout) {
    clearTimeout(state.autoPlayTimeout);
    state.autoPlayTimeout = null;
  }
  stopPlayback();
}

// ---------------------------------------------------------------------
// Hand Tracking Toggle
// ---------------------------------------------------------------------

function toggleHandTracking(enabled) {
  state.handTrackingEnabled = enabled;
  
  if (enabled) {
    els.handTrackingToggle.textContent = 'Hand Control ON';
    els.handTrackingToggle.classList.add('active');
    els.handTrackingToggle.classList.remove('inactive');
    
    // Enable hand visualization if setting is on
    if (els.enableHandVis.checked) {
      els.handVisualization.style.display = 'block';
      state.enableHandVis = true;
    }
    
    // Start auto-play for selected word
    startAutoPlay();
    
    sendSocketMessage('toggle_hand_tracking', { enabled: true });
    
  } else {
    els.handTrackingToggle.textContent = 'Hand Control OFF';
    els.handTrackingToggle.classList.remove('active');
    els.handTrackingToggle.classList.add('inactive');
    
    els.handVisualization.style.display = 'none';
    state.enableHandVis = false;
    
    stopAutoPlay();
    
    sendSocketMessage('toggle_hand_tracking', { enabled: false });
  }
  
  updateHandStatus();
}

els.handTrackingToggle.addEventListener('click', () => {
  toggleHandTracking(!state.handTrackingEnabled);
});

// ---------------------------------------------------------------------
// Settings Panel
// ---------------------------------------------------------------------

els.settingsBtn.addEventListener('click', () => {
  els.settingsPanel.style.display = 'block';
  
  // Load current settings
  els.pauseDuration.value = state.pauseDuration;
  els.gestureSensitivity.value = state.gestureSensitivity;
  els.deadzoneThreshold.value = state.deadzoneThreshold;
  els.enableHandVis.checked = state.enableHandVis;
});

els.closeSettings.addEventListener('click', () => {
  els.settingsPanel.style.display = 'none';
});

els.saveSettings.addEventListener('click', () => {
  // Update state
  state.pauseDuration = parseInt(els.pauseDuration.value) || 500;
  state.gestureSensitivity = parseFloat(els.gestureSensitivity.value) || 0.05;
  state.deadzoneThreshold = parseFloat(els.deadzoneThreshold.value) || 0.02;
  state.enableHandVis = els.enableHandVis.checked;
  
  // Update UI
  if (state.enableHandVis && state.handTrackingEnabled) {
    els.handVisualization.style.display = 'block';
  } else {
    els.handVisualization.style.display = 'none';
  }
  
  // Send to server
  sendSocketMessage('settings', {
    pauseDuration: state.pauseDuration,
    gestureSensitivity: state.gestureSensitivity,
    deadzoneThreshold: state.deadzoneThreshold,
    cameraIndex: parseInt(els.cameraSelect.value) || 0
  });
  
  // Restart auto-play with new settings
  if (state.handTrackingEnabled) {
    stopAutoPlay();
    startAutoPlay();
  }
  
  els.settingsPanel.style.display = 'none';
  setStatus('Settings saved', 2000);
});

// Close settings when clicking outside
els.settingsPanel.addEventListener('click', (e) => {
  if (e.target === els.settingsPanel) {
    els.settingsPanel.style.display = 'none';
  }
});

// ---------------------------------------------------------------------
// Time <-> pixel helpers
// ---------------------------------------------------------------------

const timeToX = (t) => t * state.pxPerSecond;
const xToTime = (x) => Math.max(0, Math.min(state.duration, x / state.pxPerSecond));

function findWord(id) { return state.words.find((w) => w.id === id); }
function selectedWord() { return state.selectedWordId != null ? findWord(state.selectedWordId) : null; }
function selectedSyllable() {
  const w = selectedWord();
  if (!w) return null;
  return w.syllables.find((s) => s.id === state.selectedSyllableId) || null;
}

// ---------------------------------------------------------------------
// FFT (iterative radix-2 Cooley-Tukey)
// ---------------------------------------------------------------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + half] * curWr - im[i + k + half] * curWi;
        const vi = re[i + k + half] * curWi + im[i + k + half] * curWr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const nwr = curWr * wr - curWi * wi;
        const nwi = curWr * wi + curWi * wr;
        curWr = nwr; curWi = nwi;
      }
    }
  }
}

const VIRIDIS_STOPS = [
  [68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37],
];
function viridis(t) {
  const n = VIRIDIS_STOPS.length - 1;
  const scaled = t * n;
  const i = Math.max(0, Math.min(n - 1, Math.floor(scaled)));
  const frac = scaled - i;
  const a = VIRIDIS_STOPS[i], b = VIRIDIS_STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

function computeSpectrogram(buffer) {
  const channelData = buffer.getChannelData(0);
  const fftSize = 1024;
  let hop = 256;
  const maxFrames = 20000;
  const estFrames = Math.floor((channelData.length - fftSize) / hop) + 1;
  if (estFrames > maxFrames) {
    hop = Math.ceil((channelData.length - fftSize) / maxFrames);
  }
  const numFrames = Math.max(1, Math.floor((channelData.length - fftSize) / hop) + 1);
  const numBins = fftSize / 2;

  const window = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

  const magnitudes = new Float32Array(numFrames * numBins);
  const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
  let minDb = Infinity, maxDb = -Infinity;

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = channelData[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < numBins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      const db = 20 * Math.log10(mag + 1e-8);
      magnitudes[f * numBins + b] = db;
      if (db < minDb) minDb = db;
      if (db > maxDb) maxDb = db;
    }
  }
  return { magnitudes, numFrames, numBins, minDb, maxDb };
}

function renderSpectrogramImage(spec) {
  const { magnitudes, numFrames, numBins, minDb, maxDb } = spec;
  const canvas = document.createElement("canvas");
  canvas.width = numFrames;
  canvas.height = numBins;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(numFrames, numBins);
  const range = maxDb - minDb || 1;
  const floor = maxDb - Math.min(range, 70);
  const floorRange = maxDb - floor || 1;

  for (let f = 0; f < numFrames; f++) {
    for (let b = 0; b < numBins; b++) {
      const db = magnitudes[f * numBins + b];
      let t = (db - floor) / floorRange;
      t = Math.max(0, Math.min(1, t));
      const [r, g, bl] = viridis(t);
      const y = numBins - 1 - b;
      const idx = (y * numFrames + f) * 4;
      img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = bl; img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------
// Loading audio
// ---------------------------------------------------------------------

els.fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus("Decoding audio…", 0);
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const arrayBuffer = await file.arrayBuffer();
  const buffer = await state.audioCtx.decodeAudioData(arrayBuffer);
  state.audioBuffer = buffer;
  state.duration = buffer.duration;
  state.fileName = file.name;
  els.fileName.textContent = file.name;

  setStatus("Computing spectrogram…", 0);
  await new Promise((r) => setTimeout(r, 20));
  const spec = computeSpectrogram(buffer);
  state.specImage = renderSpectrogramImage(spec);

  state.words = [];
  state.nextId = 1;
  state.selectedWordId = null;
  state.selectedSyllableId = null;
  state.lockLineTime = 0;

  resizeCanvases();
  drawSpectrogram();
  drawOverlay();
  renderWordList();
  setStatus(`Loaded ${file.name} (${buffer.duration.toFixed(2)}s)`);
  
  // If hand tracking is enabled, select first word if available
  if (state.handTrackingEnabled && state.words.length > 0) {
    selectWord(state.words[0].id);
    startAutoPlay();
  }
});

// ---------------------------------------------------------------------
// Canvas sizing / zoom
// ---------------------------------------------------------------------

function resizeCanvases() {
  const width = Math.max(1, Math.ceil(state.duration * state.pxPerSecond));
  for (const c of [els.specCanvas, els.overlayCanvas]) {
    c.width = width;
    c.height = TOTAL_H;
    c.style.width = width + "px";
    c.style.height = TOTAL_H + "px";
  }
  els.canvasStack.style.width = width + "px";
  els.canvasStack.style.height = TOTAL_H + "px";
}

function drawSpectrogram() {
  const ctx = els.specCanvas.getContext("2d");
  ctx.clearRect(0, 0, els.specCanvas.width, SPEC_HEIGHT);
  if (!state.specImage) return;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(state.specImage, 0, 0, state.specImage.width, state.specImage.height, 0, 0, els.specCanvas.width, SPEC_HEIGHT);
  ctx.fillStyle = "#181b21";
  ctx.fillRect(0, WORD_LANE_Y, els.specCanvas.width, WORD_LANE_H);
  ctx.fillStyle = "#15171c";
  ctx.fillRect(0, SYLL_LANE_Y, els.specCanvas.width, SYLL_LANE_H);
}

els.zoomIn.addEventListener("click", () => rezoom(state.pxPerSecond * 1.5));
els.zoomOut.addEventListener("click", () => rezoom(state.pxPerSecond / 1.5));
function rezoom(px) {
  if (!state.duration) return;
  state.pxPerSecond = Math.max(10, Math.min(2000, px));
  resizeCanvases();
  drawSpectrogram();
  drawOverlay();
}

// ---------------------------------------------------------------------
// Overlay drawing (words, syllables, playhead, lockline, hands)
// ---------------------------------------------------------------------

function drawOverlay() {
  const ctx = els.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, els.overlayCanvas.width, TOTAL_H);

  for (const w of state.words) {
    drawWordRegion(ctx, w);
  }

  const sel = selectedWord();
  if (sel && state.mode === "syllable") {
    for (const s of sel.syllables) drawSyllableRegion(ctx, sel, s);
  }

  // Draw Lockline
  if (state.audioBuffer) {
    const lx = timeToX(state.lockLineTime);
    ctx.strokeStyle = "#b15fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx, 0);
    ctx.lineTo(lx, TOTAL_H);
    ctx.stroke();

    ctx.fillStyle = "#b15fff";
    ctx.beginPath();
    ctx.arc(lx, 10, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw hand positions if enabled
  if (state.handTrackingEnabled && state.handPositions.left && state.handPositions.right) {
    const leftX = timeToX(state.handPositions.left.x * state.duration);
    const rightX = timeToX(state.handPositions.right.x * state.duration);
    
    // Left hand indicator
    ctx.fillStyle = "rgba(95, 176, 255, 0.3)";
    ctx.strokeStyle = "#5fb0ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(leftX, WORD_LANE_Y + WORD_LANE_H + 20, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    // Right hand indicator
    ctx.fillStyle = "rgba(255, 180, 84, 0.3)";
    ctx.strokeStyle = "#ffb454";
    ctx.beginPath();
    ctx.arc(rightX, WORD_LANE_Y + WORD_LANE_H + 20, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    // Hand distance indicator
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftX, WORD_LANE_Y + WORD_LANE_H + 20);
    ctx.lineTo(rightX, WORD_LANE_Y + WORD_LANE_H + 20);
    ctx.stroke();
  }

  // playhead
  const t = currentPlayTime();
  if (t != null) {
    const x = timeToX(t);
    ctx.strokeStyle = "#ff5f6d";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TOTAL_H);
    ctx.stroke();
  }
}

function drawWordRegion(ctx, w) {
  const x0 = timeToX(w.start), x1 = timeToX(w.end);
  const boxWidth = x1 - x0;
  const selected = w.id === state.selectedWordId;
  const isLocked = w.end <= state.lockLineTime;
  
  if (isLocked) {
    ctx.fillStyle = selected ? "rgba(100,100,100,0.5)" : "rgba(100,100,100,0.3)";
    ctx.strokeStyle = "rgba(150,150,150,0.8)";
  } else {
    ctx.fillStyle = selected ? "rgba(95,176,255,0.38)" : "rgba(95,176,255,0.18)";
    ctx.strokeStyle = "rgba(95,176,255,0.85)";
  }

  ctx.fillRect(x0, WORD_LANE_Y, boxWidth, WORD_LANE_H);
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 + 1, WORD_LANE_Y + 1, Math.max(1, boxWidth - 2), WORD_LANE_H - 2);

  if (w.syllables.length > 1) {
    ctx.strokeStyle = isLocked ? "rgba(150,150,150,0.7)" : "rgba(255,180,84,0.7)";
    ctx.lineWidth = 1;
    for (let i = 1; i < w.syllables.length; i++) {
      const sx = timeToX(w.syllables[i].start);
      ctx.beginPath();
      ctx.moveTo(sx, WORD_LANE_Y + WORD_LANE_H - 8);
      ctx.lineTo(sx, WORD_LANE_Y + WORD_LANE_H);
      ctx.stroke();
    }
  }

  ctx.fillStyle = "#e4e6eb";
  ctx.font = "12px sans-serif";
  const label = w.text || "(unlabeled)";
  const textWidth = ctx.measureText(label).width;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, WORD_LANE_Y, boxWidth, WORD_LANE_H);
  ctx.clip();

  if (textWidth + 8 > boxWidth) {
    ctx.translate(x0 + boxWidth / 2, WORD_LANE_Y + 6);
    ctx.rotate(Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 0); 
  } else {
    ctx.textBaseline = "middle";
    ctx.fillText(label, x0 + 4, WORD_LANE_Y + WORD_LANE_H / 2);
  }
  ctx.restore();
}

function drawSyllableRegion(ctx, word, s) {
  const x0 = timeToX(s.start), x1 = timeToX(s.end);
  const selected = s.id === state.selectedSyllableId;
  const isLocked = word.end <= state.lockLineTime;

  ctx.fillStyle = selected ? "rgba(255,180,84,0.4)" : "rgba(255,180,84,0.18)";
  ctx.strokeStyle = isLocked ? "rgba(150,150,150,0.8)" : "rgba(255,180,84,0.85)";

  ctx.fillRect(x0, SYLL_LANE_Y, x1 - x0, SYLL_LANE_H);
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 + 1, SYLL_LANE_Y + 1, Math.max(1, x1 - x0 - 2), SYLL_LANE_H - 2);

  const idx = word.syllables.indexOf(s);
  ctx.fillStyle = "#e4e6eb";
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(String(idx + 1), x0 + 4, SYLL_LANE_Y + SYLL_LANE_H / 2);
}

// ---------------------------------------------------------------------
// Word list sidebar
// ---------------------------------------------------------------------

function renderWordList() {
  els.wordList.innerHTML = "";
  els.wordCount.textContent = state.words.length ? `(${state.words.length})` : "";
  const sorted = [...state.words].sort((a, b) => a.start - b.start);
  for (const w of sorted) {
    const row = document.createElement("div");
    row.className = "word-row" + (w.id === state.selectedWordId ? " selected" : "");
    const lockIcon = w.end <= state.lockLineTime ? "🔒 " : "";
    row.innerHTML = `<span>${lockIcon}${escapeHtml(w.text || "(unlabeled)")}</span><span class="t">${w.start.toFixed(2)}\u2013${w.end.toFixed(2)}s</span>`;
    row.addEventListener("click", () => {
      selectWord(w.id);
      const x = timeToX(w.start);
      els.canvasScroll.scrollLeft = Math.max(0, x - 100);
      drawOverlay();
      renderWordList();
      
      // Start auto-play if hand tracking is enabled
      if (state.handTrackingEnabled) {
        startAutoPlay();
      }
    });
    els.wordList.appendChild(row);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function selectWord(id) {
  state.selectedWordId = id;
  state.selectedSyllableId = null;
  const w = findWord(id);
  updateSyllableControlsVisibility();
  if (w && state.mode === "syllable" && w.syllables.length === 0) {
    initSyllablesForWord(w);
  }
}

// ---------------------------------------------------------------------
// Phonetic syllable seeding
// ---------------------------------------------------------------------

function estimateSyllableCountOffline(wordText) {
  let clean = wordText.toLowerCase().replace(/[^a-z]/g, "");
  if (!clean) return 1;
  if (clean.length <= 3) return 1;
  clean = clean.replace(/(?:[^laeiouy]es|ed|e)$/i, "");
  clean = clean.replace(/^y/, "");
  const groups = clean.match(/[aeiouy]{1,2}/g);
  return groups ? Math.max(1, groups.length) : 1;
}

function isMetaLabel(text) {
  return /^\\[.*\\]$/.test(text.trim());
}

async function initSyllablesForWord(w) {
  if (!w.text) {
    setStatus("Label the word before splitting it into syllables.");
    w.syllables = [{ id: state.nextId++, start: w.start, end: w.end }];
    drawOverlay();
    return;
  }

  if (isMetaLabel(w.text)) {
    w.syllables = [{ id: state.nextId++, start: w.start, end: w.end }];
    els.syllableSource.textContent = "meta label (not split)";
    drawOverlay();
    renderWordList();
    return;
  }

  let count, source;
  try {
    const res = await fetch(`/api/phonemes?word=${encodeURIComponent(w.text)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    count = Math.max(1, data.syllable_count || 1);
    source = data.source;
  } catch (e) {
    count = estimateSyllableCountOffline(w.text);
    source = "offline-fallback";
    setStatus("Couldn't reach local server — using offline guess.");
  }
  w.syllables = evenSplit(w.start, w.end, count);
  els.syllableSource.textContent =
    source === "cmudict" ? "phonetic (CMUdict)" :
    source === "heuristic" ? "heuristic guess" :
    "offline guess";
  drawOverlay();
  renderWordList();
}

function evenSplit(start, end, count) {
  const out = [];
  const step = (end - start) / count;
  for (let i = 0; i < count; i++) {
    out.push({ id: state.nextId++, start: start + i * step, end: start + (i + 1) * step });
  }
  return out;
}

// ---------------------------------------------------------------------
// Tool / Mode / Push Toggles
// ---------------------------------------------------------------------

function setTool(tool) {
  state.tool = tool;
  els.toolAnnotate.classList.toggle("active", tool === "annotate");
  els.toolPlayback.classList.toggle("active", tool === "playback");
}
els.toolAnnotate.addEventListener("click", () => setTool("annotate"));
els.toolPlayback.addEventListener("click", () => setTool("playback"));

function setMode(mode) {
  state.mode = mode;
  els.modeWord.classList.toggle("active", mode === "word");
  els.modeSyllable.classList.toggle("active", mode === "syllable");
  updateSyllableControlsVisibility();
  const w = selectedWord();
  if (mode === "syllable" && w && w.syllables.length === 0) initSyllablesForWord(w);
  drawOverlay();
}
els.modeWord.addEventListener("click", () => setMode("word"));
els.modeSyllable.addEventListener("click", () => setMode("syllable"));

// Push Direction & Style Toggles
els.pushDirectionToggle.addEventListener("click", () => {
  state.pushDirection = state.pushDirection === 'forward' ? 'both' : 'forward';
  els.pushDirectionToggle.textContent = state.pushDirection === 'forward' ? 'Push Forward Only' : 'Push Left & Right';
  els.pushDirectionToggle.classList.toggle('active', state.pushDirection === 'forward');
  els.pushDirectionToggle.classList.toggle('inactive', state.pushDirection === 'both');
});

els.pushStyleToggle.addEventListener("click", () => {
  state.pushStyle = state.pushStyle === 'block' ? 'squish' : 'block';
  els.pushStyleToggle.textContent = state.pushStyle === 'block' ? 'Push as Blocks' : 'Squish Words';
  els.pushStyleToggle.classList.toggle('active', state.pushStyle === 'block');
  els.pushStyleToggle.classList.toggle('inactive', state.pushStyle === 'squish');
});

function updateSyllableControlsVisibility() {
  els.syllableControls.hidden = state.mode !== "syllable" || !selectedWord();
}

els.splitSyllable.addEventListener("click", () => {
  const w = selectedWord();
  const s = selectedSyllable();
  if (!w || !s) return;
  if (w.end <= state.lockLineTime) { setStatus("Word is locked."); return; }
  const mid = (s.start + s.end) / 2;
  const idx = w.syllables.indexOf(s);
  const a = { id: state.nextId++, start: s.start, end: mid };
  const b = { id: state.nextId++, start: mid, end: s.end };
  w.syllables.splice(idx, 1, a, b);
  state.selectedSyllableId = a.id;
  drawOverlay();
});

els.mergeSyllable.addEventListener("click", () => {
  const w = selectedWord();
  const s = selectedSyllable();
  if (!w || !s) return;
  if (w.end <= state.lockLineTime) { setStatus("Word is locked."); return; }
  const idx = w.syllables.indexOf(s);
  if (idx === w.syllables.length - 1) {
    if (idx === 0) return;
    const prev = w.syllables[idx - 1];
    prev.end = s.end;
    w.syllables.splice(idx, 1);
    state.selectedSyllableId = prev.id;
  } else {
    const next = w.syllables[idx + 1];
    s.end = next.end;
    w.syllables.splice(idx + 1, 1);
  }
  drawOverlay();
});

// ---------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------

function currentPlayTime() {
  if (!state.audioBuffer) return null;
  if (!state.playing) return state.playOffset;
  return state.playOffset + (state.audioCtx.currentTime - state.playStartCtxTime);
}

function stopPlayback() {
  if (state.sourceNode) {
    try { state.sourceNode.onended = null; state.sourceNode.stop(); } catch (e) {}
    state.sourceNode = null;
  }
  state.playing = false;
}

function playFrom(offset, endOffset = null) {
  if (!state.audioBuffer) return;
  stopPlayback();
  const src = state.audioCtx.createBufferSource();
  src.buffer = state.audioBuffer;
  src.connect(state.audioCtx.destination);
  state.sourceNode = src;
  state.playOffset = offset;
  state.playEndOffset = endOffset;
  state.playStartCtxTime = state.audioCtx.currentTime;
  const dur = endOffset != null ? Math.max(0.01, endOffset - offset) : undefined;
  src.start(0, offset, dur);
  state.playing = true;
  src.onended = () => {
    state.playing = false;
    state.playOffset = endOffset != null ? endOffset : offset;
    state.sourceNode = null;
    drawOverlay();
  };
  requestAnimationFrame(playheadLoop);
}

function playheadLoop() {
  drawOverlay();
  if (state.playing) requestAnimationFrame(playheadLoop);
}

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  e.preventDefault();
  if (state.mode === "word") {
    const w = selectedWord();
    if (w) playFrom(w.start, w.end);
  } else {
    const s = selectedSyllable();
    if (s) playFrom(s.start, s.end);
  }
});

// ---------------------------------------------------------------------
// Mouse interaction & Collision Engine
// ---------------------------------------------------------------------

function getMouse(e) {
  const rect = els.overlayCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function nearHandle(x, targetX) {
  return Math.abs(x - targetX) <= HANDLE_PX;
}

function hitTestLockline(x) {
  return Math.abs(x - timeToX(state.lockLineTime)) <= HANDLE_PX * 1.5;
}

function hitTestWord(x, y) {
  if (y < WORD_LANE_Y || y > WORD_LANE_Y + WORD_LANE_H) return null;
  for (const w of state.words) {
    const x0 = timeToX(w.start), x1 = timeToX(w.end);
    if (nearHandle(x, x0)) return { word: w, edge: "start" };
    if (nearHandle(x, x1)) return { word: w, edge: "end" };
    if (x > x0 && x < x1) return { word: w, edge: "body" };
  }
  return null;
}

function hitTestSyllableBoundary(x, y, word) {
  if (y < SYLL_LANE_Y || y > SYLL_LANE_Y + SYLL_LANE_H) return null;
  for (let i = 0; i < word.syllables.length - 1; i++) {
    const bx = timeToX(word.syllables[i].end);
    if (nearHandle(x, bx)) return { index: i };
  }
  return null;
}

function hitTestSyllableBody(x, y, word) {
  if (y < SYLL_LANE_Y || y > SYLL_LANE_Y + SYLL_LANE_H) return null;
  for (const s of word.syllables) {
    if (x >= timeToX(s.start) && x <= timeToX(s.end)) return s;
  }
  return null;
}

function resolveCollisions(dragIndex) {
  state.words.sort((a, b) => a.start - b.start);
  const draggedWord = state.words[dragIndex];

  // Rightward Cascade
  for (let i = dragIndex + 1; i < state.words.length; i++) {
    const prev = state.words[i - 1];
    const curr = state.words[i];
    if (curr.start >= prev.end) break;

    let overlap = prev.end - curr.start;
    if (state.pushStyle === 'squish') {
      const dur = curr.end - curr.start;
      const canSquish = Math.max(0, dur - MIN_WORD_DUR);
      const squishAmt = Math.min(overlap, canSquish);
      curr.start += squishAmt;
      overlap -= squishAmt;
    }
    
    if (overlap > 0) {
      curr.start += overlap;
      curr.end += overlap;
    }
  }

  // Leftward Cascade
  if (state.pushDirection === 'forward') {
    const leftNeighbor = state.words[dragIndex - 1];
    const minStart = leftNeighbor ? Math.max(state.lockLineTime, leftNeighbor.end) : state.lockLineTime;
    
    if (draggedWord.start < minStart) {
      const correction = minStart - draggedWord.start;
      draggedWord.start += correction;
      draggedWord.end += correction;
      resolveCollisions(state.words.indexOf(draggedWord));
    }
  } else {
    for (let i = dragIndex - 1; i >= 0; i--) {
      const next = state.words[i + 1];
      const curr = state.words[i];

      if (next.start < state.lockLineTime) {
          const correction = state.lockLineTime - next.start;
          next.start += correction;
          next.end += correction;
          resolveCollisions(state.words.indexOf(next));
          break;
      }

      if (curr.end <= next.start) break;

      let overlap = curr.end - next.start;
      if (state.pushStyle === 'squish') {
        const dur = curr.end - curr.start;
        const canSquish = Math.max(0, dur - MIN_WORD_DUR);
        const squishAmt = Math.min(overlap, canSquish);
        curr.end -= squishAmt;
        overlap -= squishAmt;
      }

      if (overlap > 0) {
        curr.start -= overlap;
        curr.end -= overlap;
      }
      
      if (curr.start < state.lockLineTime) {
        const correction = state.lockLineTime - curr.start;
        curr.start += correction;
        curr.end += correction;
        resolveCollisions(state.words.indexOf(curr));
        break;
      }
    }
  }
}

els.overlayCanvas.addEventListener("mousedown", (e) => {
  if (!state.audioBuffer) return;
  const { x, y } = getMouse(e);
  const t = xToTime(x);

  if (state.tool === "playback") {
    playFrom(t);
    return;
  }

  if (hitTestLockline(x) && y <= 30) {
    state.drag = { type: "lockline" };
    return;
  }

  if (state.mode === "word") {
    const hit = hitTestWord(x, y);
    if (hit) {
      if (hit.word.end <= state.lockLineTime) {
        setStatus("Word is before lockline and is locked.");
        return;
      }
      if (hit.edge !== "body") {
        state.drag = { type: "word-edge", id: hit.word.id, edge: hit.edge };
        return;
      }
      if (hit.edge === "body") {
        state.drag = { type: "word-body", id: hit.word.id, lastT: t };
        selectWord(hit.word.id);
        drawOverlay();
        renderWordList();
        return;
      }
    }
    if (y <= WORD_LANE_Y + WORD_LANE_H) {
      state.drag = { type: "create-word", anchor: Math.max(t, state.lockLineTime) };
    }
  } else {
    const w = selectedWord();
    if (!w) return;
    if (w.end <= state.lockLineTime) { setStatus("Word is locked."); return; }
    
    const boundary = hitTestSyllableBoundary(x, y, w);
    if (boundary) {
      state.drag = { type: "syll-boundary", index: boundary.index };
      return;
    }
    const body = hitTestSyllableBody(x, y, w);
    if (body) {
      state.selectedSyllableId = body.id;
      updateSyllableControlsVisibility();
      drawOverlay();
      return;
    }
  }
});

window.addEventListener("mousemove", (e) => {
  if (!state.drag) return;
  const { x } = getMouse(e);
  const t = xToTime(x);

  if (state.drag.type === "lockline") {
    state.lockLineTime = Math.max(0, Math.min(state.duration, t));
    drawOverlay();
    renderWordList();
  } else if (state.drag.type === "word-body") {
    const w = findWord(state.drag.id);
    if (!w) return;
    const dt = t - state.drag.lastT;
    state.drag.lastT = t;
    
    w.start += dt;
    w.end += dt;

    if (w.start < state.lockLineTime) {
      const correction = state.lockLineTime - w.start;
      w.start += correction;
      w.end += correction;
    }

    state.words.sort((a, b) => a.start - b.start);
    const dragIndex = state.words.findIndex(word => word.id === state.drag.id);
    resolveCollisions(dragIndex);
    syncWordEdgeToSyllables(w, "start"); 
    syncWordEdgeToSyllables(w, "end");
    drawOverlay();
    renderWordList();
  } else if (state.drag.type === "word-edge") {
    const w = findWord(state.drag.id);
    if (!w) return;
    
    if (state.drag.edge === "start") {
      w.start = Math.max(state.lockLineTime, Math.min(t, w.end - MIN_WORD_DUR));
    } else {
      w.end = Math.max(t, w.start + MIN_WORD_DUR);
    }
    syncWordEdgeToSyllables(w, state.drag.edge);
    drawOverlay();
    renderWordList();
  } else if (state.drag.type === "create-word") {
    drawOverlay();
    const ctx = els.overlayCanvas.getContext("2d");
    const anchor = Math.max(state.drag.anchor, state.lockLineTime);
    const x0 = timeToX(Math.min(anchor, Math.max(t, state.lockLineTime)));
    const x1 = timeToX(Math.max(anchor, Math.max(t, state.lockLineTime)));
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fillRect(x0, WORD_LANE_Y, x1 - x0, WORD_LANE_H);
    ctx.strokeStyle = "#fff";
    ctx.strokeRect(x0, WORD_LANE_Y, x1 - x0, WORD_LANE_H);
  } else if (state.drag.type === "syll-boundary") {
    const w = selectedWord();
    if (!w) return;
    const i = state.drag.index;
    const a = w.syllables[i], b = w.syllables[i + 1];
    const lo = a.start + MIN_SYLL_DUR;
    const hi = b.end - MIN_SYLL_DUR;
    const clamped = Math.max(lo, Math.min(hi, t));
    a.end = clamped;
    b.start = clamped;
    drawOverlay();
  }
});

window.addEventListener("mouseup", (e) => {
  if (!state.drag) return;
  const { x } = getMouse(e);
  const t = xToTime(x);

  if (state.drag.type === "create-word") {
    let start = Math.max(state.lockLineTime, Math.min(state.drag.anchor, t));
    let end = Math.max(state.lockLineTime, Math.max(state.drag.anchor, t));
    if (end - start < MIN_WORD_DUR) end = start + 0.3;
    const label = window.prompt("Word text:", "");
    if (label !== null) {
      const w = { id: state.nextId++, text: label.trim(), start, end, syllables: [] };
      state.words.push(w);
      state.words.sort((a, b) => a.start - b.start);
      selectWord(w.id);
    }
    drawOverlay();
    renderWordList();
  }

  state.drag = null;
});

els.overlayCanvas.addEventListener("dblclick", (e) => {
  if (state.mode !== "word") return;
  const { x, y } = getMouse(e);
  const hit = hitTestWord(x, y);
  if (hit && hit.edge === "body") {
    if (hit.word.end <= state.lockLineTime) {
      setStatus("Cannot edit locked word.");
      return;
    }
    const label = window.prompt("Word text:", hit.word.text);
    if (label !== null) {
      hit.word.text = label.trim();
      hit.word.syllables = []; 
      drawOverlay();
      renderWordList();
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (state.mode !== "word" || !state.selectedWordId) return;
  e.preventDefault();
  
  const w = findWord(state.selectedWordId);
  if (w && w.end <= state.lockLineTime) {
    setStatus("Cannot delete a locked word.");
    return;
  }

  state.words = state.words.filter((w) => w.id !== state.selectedWordId);
  state.selectedWordId = null;
  drawOverlay();
  renderWordList();
  
  // Stop auto-play if word was deleted
  if (state.handTrackingEnabled && state.words.length > 0) {
    selectWord(state.words[0].id);
    startAutoPlay();
  } else {
    stopAutoPlay();
  }
});

function syncWordEdgeToSyllables(w, edge) {
  if (w.syllables.length === 0) return;
  if (edge === "start") w.syllables[0].start = w.start;
  else w.syllables[w.syllables.length - 1].end = w.end;
}

// ---------------------------------------------------------------------
// Export / Import (JSON & TXT)
// ---------------------------------------------------------------------

els.exportBtn.addEventListener("click", () => {
  const data = {
    audioFile: state.fileName,
    duration: state.duration,
    words: [...state.words]
      .sort((a, b) => a.start - b.start)
      .map((w) => ({
        text: w.text,
        start: Number(w.start.toFixed(4)),
        end: Number(w.end.toFixed(4)),
        syllables: w.syllables.map((s) => ({
          start: Number(s.start.toFixed(4)),
          end: Number(s.end.toFixed(4)),
        })),
      })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const base = (state.fileName || "annotation").replace(/\.[^.]+$/, "");
  a.download = `${base}.index.json`;
  a.click();
});

els.importInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (err) { setStatus("Invalid JSON."); return; }
  if (!state.audioBuffer) { setStatus("Load the matching MP3 first, then import."); return; }
  state.words = (data.words || []).map((w) => ({
    id: state.nextId++,
    text: w.text || "",
    start: w.start,
    end: w.end,
    syllables: (w.syllables || []).map((s) => ({ id: state.nextId++, start: s.start, end: s.end })),
  }));
  state.selectedWordId = null;
  state.selectedSyllableId = null;
  drawOverlay();
  renderWordList();
  setStatus(`Imported ${state.words.length} words.`);
  
  // Select first word if hand tracking is enabled
  if (state.handTrackingEnabled && state.words.length > 0) {
    selectWord(state.words[0].id);
    startAutoPlay();
  }
});

// Import verbatim TXT sequentially from lockline
els.importTxtInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!state.audioBuffer) { setStatus("Load an MP3 first, then import."); return; }
  
  const text = await file.text();
  const newWords = text.trim().split(/\s+/).filter(Boolean);
  if (!newWords.length) return;

  let t = state.lockLineTime;
  const defaultDur = 0.3;
  const gap = 0.05;

  newWords.forEach(w => {
    state.words.push({
      id: state.nextId++,
      text: w,
      start: t,
      end: t + defaultDur,
      syllables: []
    });
    t += defaultDur + gap;
  });

  state.words.sort((a, b) => a.start - b.start);
  drawOverlay();
  renderWordList();
  setStatus(`Imported ${newWords.length} verbatim words starting from lockline.`);
  
  // Select first word if hand tracking is enabled
  if (state.handTrackingEnabled && state.words.length > 0) {
    selectWord(state.words[0].id);
    startAutoPlay();
  }
});

// ---------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------

// Start WebSocket connection when page loads
window.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
  
  // Set initial toggle state
  els.handTrackingToggle.classList.add('inactive');
});

// Handle page visibility changes
window.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Pause hand tracking when page is hidden
    if (state.handTrackingEnabled) {
      toggleHandTracking(false);
    }
  }
});
