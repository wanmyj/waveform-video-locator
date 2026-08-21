import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';

const fileListEl = document.getElementById('fileList');
const loadBtn = document.getElementById('loadBtn');
const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const waveformEl = document.getElementById('waveform');
const statusEl = document.getElementById('status');
const player = document.getElementById('player');
const thumbPreview = document.getElementById('thumbPreview');
const thumbImg = document.getElementById('thumbImg');
const thumbTime = document.getElementById('thumbTime');

let wavesurfer = null;
let offsets = []; // [{file, offset, duration}] sorted, cumulative
let totalDuration = 0;
let pxPerSec = 50;
let currentFile = null;

async function loadFileList() {
  const files = await fetch('/api/files').then((r) => r.json());
  if (!files.length) {
    fileListEl.textContent = 'mock/ 目录下没有找到视频文件，先运行 npm run mock 生成测试素材。';
    return;
  }
  fileListEl.innerHTML = files
    .map((f) => `<label><input type="checkbox" value="${f.name}"> ${f.name}</label>`)
    .join('');
}

function findAt(globalTime) {
  for (const o of offsets) {
    if (globalTime >= o.offset && globalTime < o.offset + o.duration) {
      return { file: o.file, localTime: globalTime - o.offset };
    }
  }
  const last = offsets[offsets.length - 1];
  if (last && globalTime >= last.offset) return { file: last.file, localTime: last.duration };
  return null;
}

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

async function loadWaveform(files) {
  statusEl.textContent = '正在提取拼接波形...';
  offsets = await fetch(`/api/offsets?files=${encodeURIComponent(files.join(','))}`).then((r) => r.json());
  totalDuration = offsets.length ? offsets[offsets.length - 1].offset + offsets[offsets.length - 1].duration : 0;

  if (wavesurfer) wavesurfer.destroy();
  wavesurfer = WaveSurfer.create({
    container: waveformEl,
    height: 150,
    waveColor: '#4da6ff',
    progressColor: '#2563eb',
    cursorColor: '#f87171',
    minPxPerSec: pxPerSec,
    url: `/api/waveform-audio?files=${encodeURIComponent(files.join(','))}`,
  });

  // We only use wavesurfer for the visual waveform + cursor; actual playback
  // happens on the <video> element per source file, so keep it muted.
  wavesurfer.on('ready', () => {
    statusEl.textContent = `已加载 ${files.length} 个文件，总时长 ${fmt(totalDuration)}`;
  });
  wavesurfer.setMuted(true);

  wavesurfer.on('interaction', (newTime) => seekTo(newTime));
  wavesurfer.on('drag', (relativeX) => previewAt(relativeX * totalDuration));
}

function seekTo(globalTime) {
  const hit = findAt(globalTime);
  if (!hit) return;
  hideThumb();
  currentFile = hit.file;
  const src = `/api/stream?file=${encodeURIComponent(hit.file)}`;
  if (!player.src.endsWith(src)) player.src = src;
  player.currentTime = hit.localTime;
  player.play().catch(() => {});
  statusEl.textContent = `定位到 ${hit.file} @ ${fmt(hit.localTime)}`;
}

let lastThumbFetch = 0;
let thumbInFlight = false;
function previewAt(globalTime) {
  const hit = findAt(globalTime);
  if (!hit) return;
  thumbTime.textContent = `${hit.file} @ ${fmt(hit.localTime)}`;
  thumbPreview.style.display = 'block';

  const now = performance.now();
  if (thumbInFlight || now - lastThumbFetch < 200) return;
  lastThumbFetch = now;
  thumbInFlight = true;
  fetch(`/api/thumbnail?file=${encodeURIComponent(hit.file)}&t=${hit.localTime.toFixed(2)}`)
    .then((r) => r.blob())
    .then((blob) => { thumbImg.src = URL.createObjectURL(blob); })
    .finally(() => { thumbInFlight = false; });
}

function hideThumb() {
  thumbPreview.style.display = 'none';
}

// Keep the floating thumbnail near the cursor while dragging on the waveform.
waveformEl.addEventListener('mousemove', (e) => {
  if (thumbPreview.style.display === 'block') {
    thumbPreview.style.left = `${e.clientX}px`;
    thumbPreview.style.top = `${e.clientY}px`;
  }
});
window.addEventListener('mouseup', hideThumb);

// Wheel: plain = pan horizontally, Ctrl = zoom.
waveformEl.addEventListener('wheel', (e) => {
  if (!wavesurfer) return;
  if (e.ctrlKey) {
    e.preventDefault();
    setZoom(pxPerSec * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  } else {
    waveformEl.scrollLeft += e.deltaY;
  }
}, { passive: false });

function setZoom(px) {
  pxPerSec = Math.min(500, Math.max(10, px));
  if (wavesurfer) wavesurfer.zoom(pxPerSec);
}
zoomInBtn.addEventListener('click', () => setZoom(pxPerSec * 1.5));
zoomOutBtn.addEventListener('click', () => setZoom(pxPerSec / 1.5));

// Move the waveform cursor to follow real playback so you can see where you
// are relative to the full selection while the video plays.
player.addEventListener('timeupdate', () => {
  if (!wavesurfer || !currentFile) return;
  const o = offsets.find((x) => x.file === currentFile);
  if (!o) return;
  wavesurfer.setTime(o.offset + player.currentTime);
});

loadBtn.addEventListener('click', () => {
  const selected = Array.from(fileListEl.querySelectorAll('input:checked')).map((el) => el.value);
  if (!selected.length) { statusEl.textContent = '请先勾选至少一个文件'; return; }
  loadWaveform(selected);
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); player.paused ? player.play() : player.pause(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); player.currentTime = Math.max(0, player.currentTime - 5); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); player.currentTime += 5; }
});

loadFileList();
