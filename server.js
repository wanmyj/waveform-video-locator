const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3334;
const MOCK_DIR = path.join(__dirname, 'mock');
const CACHE_DIR = path.join(__dirname, 'cache');
const VIDEO_EXT = new Set(['.mp4', '.avi', '.mkv', '.mov']);

fs.mkdirSync(MOCK_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

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
  return fs.readdirSync(MOCK_DIR)
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
    .sort();
}

// Resolve a client-supplied filename to a real path inside MOCK_DIR, refusing
// anything not present in the directory listing (blocks path traversal).
function resolveVideo(name) {
  const base = path.basename(String(name || ''));
  if (!listVideos().includes(base)) return null;
  return path.join(MOCK_DIR, base);
}

async function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
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
    const filePath = path.join(MOCK_DIR, file);
    const duration = await ffprobeDuration(filePath);
    result.push({ file, offset, duration });
    offset += duration;
  }
  return result;
}

app.get('/api/files', (req, res) => {
  const files = listVideos().map((name) => {
    const stat = fs.statSync(path.join(MOCK_DIR, name));
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
      const tmpWavs = [];
      for (let i = 0; i < files.length; i++) {
        const src = path.join(MOCK_DIR, files[i]);
        const tmp = path.join(CACHE_DIR, `_tmp_${key}_${i}.wav`);
        await run('ffmpeg', ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '8000', tmp]);
        tmpWavs.push(tmp);
      }
      const listFile = path.join(CACHE_DIR, `_tmp_${key}_list.txt`);
      const listContent = tmpWavs
        .map((p) => `file '${p.replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(listFile, listContent);

      await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);

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
      await run('ffmpeg', ['-y', '-ss', String(bucket), '-i', filePath, '-frames:v', '1', '-q:v', '4', outPath]);
    }
    res.sendFile(outPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`soundwave server running at http://localhost:${PORT}`);
});
