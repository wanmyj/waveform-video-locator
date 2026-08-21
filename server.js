const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3334;
// pkg's snapshot fs is read-only, so writable state (cache, config) must live
// next to the actual .exe rather than under __dirname when packaged.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const VIDEO_EXT = new Set(['.mp4', '.avi', '.mkv', '.mov']);

let config = { videoDir: '', ffmpegDir: '' };
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch {}
if (!config.videoDir) config.videoDir = process.env.VIDEO_DIR || path.join(__dirname, 'mock');
if (!config.ffmpegDir) config.ffmpegDir = process.env.FFMPEG_DIR || '';

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function ffmpegBin() { return path.join(config.ffmpegDir, 'ffmpeg.exe'); }
function ffprobeBin() { return path.join(config.ffmpegDir, 'ffprobe.exe'); }

// Checks the configured dirs are actually usable; returned as a map so the
// web UI can show which field is wrong.
function configErrors(videoDir, ffmpegDir) {
  const errors = {};
  if (!videoDir || !fs.existsSync(videoDir) || !fs.statSync(videoDir).isDirectory()) {
    errors.videoDir = `目录不存在：${videoDir || '(未填写)'}`;
  }
  if (!ffmpegDir || !fs.existsSync(path.join(ffmpegDir, 'ffmpeg.exe')) || !fs.existsSync(path.join(ffmpegDir, 'ffprobe.exe'))) {
    errors.ffmpegDir = `该目录下未找到 ffmpeg.exe / ffprobe.exe：${ffmpegDir || '(未填写)'}`;
  }
  return errors;
}

fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ ...config, errors: configErrors(config.videoDir, config.ffmpegDir) });
});

app.post('/api/config', (req, res) => {
  const videoDir = String(req.body?.videoDir || '').trim();
  const ffmpegDir = String(req.body?.ffmpegDir || '').trim();
  const errors = configErrors(videoDir, ffmpegDir);
  if (Object.keys(errors).length) return res.status(400).json({ errors });
  config = { videoDir, ffmpegDir };
  saveConfig();
  res.json({ ...config });
});

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function listVideos() {
  if (!fs.existsSync(config.videoDir)) return [];
  return fs.readdirSync(config.videoDir)
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
    .sort();
}

// Resolve a client-supplied filename to a real path inside the configured
// video dir, refusing anything not present in the directory listing (blocks
// path traversal).
function resolveVideo(name) {
  const base = path.basename(String(name || ''));
  if (!listVideos().includes(base)) return null;
  return path.join(config.videoDir, base);
}

async function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobeBin(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(parseFloat(out.trim()));
      else reject(new Error(`ffprobe exited ${code}: ${err.slice(-500)}`));
    });
  });
}

function parseFilesParam(req) {
  return String(req.query.files || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function buildOffsets(names) {
  const available = listVideos();
  const files = names.filter((n) => available.includes(n)).sort();
  let offset = 0;
  const result = [];
  for (const file of files) {
    const filePath = path.join(config.videoDir, file);
    const duration = await ffprobeDuration(filePath);
    result.push({ file, offset, duration });
    offset += duration;
  }
  return result;
}

app.get('/api/files', (req, res) => {
  const files = listVideos().map((name) => {
    const stat = fs.statSync(path.join(config.videoDir, name));
    return { name, size: stat.size };
  });
  res.json(files);
});

app.get('/api/offsets', async (req, res) => {
  try {
    const offsets = await buildOffsets(parseFilesParam(req));
    res.json(offsets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/waveform-audio', async (req, res) => {
  try {
    const available = listVideos();
    const files = parseFilesParam(req).filter((n) => available.includes(n)).sort();
    if (!files.length) return res.status(400).json({ error: 'no files' });

    const key = crypto.createHash('md5').update(files.join('|')).digest('hex');
    const outPath = path.join(CACHE_DIR, `waveform_${key}.wav`);

    if (!fs.existsSync(outPath)) {
      // Extract each file's audio in parallel (independent ffmpeg calls) rather
      // than one-at-a-time — this is what made loading 3+ files slow.
      const tmpWavs = files.map((_, i) => path.join(CACHE_DIR, `_tmp_${key}_${i}.wav`));
      await Promise.all(files.map((f, i) =>
        run(ffmpegBin(), ['-y', '-i', path.join(config.videoDir, f), '-vn', '-ac', '1', '-ar', '8000', tmpWavs[i]])
      ));
      const listFile = path.join(CACHE_DIR, `_tmp_${key}_list.txt`);
      const listContent = tmpWavs
        .map((p) => `file '${p.replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(listFile, listContent);

      await run(ffmpegBin(), ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);

      for (const t of tmpWavs) fs.unlinkSync(t);
      fs.unlinkSync(listFile);
    }

    res.sendFile(outPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', (req, res) => {
  const filePath = resolveVideo(req.query.file);
  if (!filePath) return res.status(404).end();
  res.sendFile(filePath); // express's `send` handles Range requests for us
});

app.get('/api/thumbnail', async (req, res) => {
  try {
    const filePath = resolveVideo(req.query.file);
    if (!filePath) return res.status(404).end();
    const t = Math.max(0, parseFloat(req.query.t) || 0);
    const bucket = Math.floor(t);
    const key = path.basename(req.query.file).replace(/[^a-z0-9._-]/gi, '_');
    const outPath = path.join(CACHE_DIR, `thumb_${key}_${bucket}.jpg`);

    if (!fs.existsSync(outPath)) {
      await run(ffmpegBin(), ['-y', '-ss', String(bucket), '-i', filePath, '-frames:v', '1', '-q:v', '4', outPath]);
    }
    res.sendFile(outPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`soundwave server running at http://localhost:${PORT}`);
});
