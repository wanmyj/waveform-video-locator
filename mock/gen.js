// ponytail: quick synthetic test footage, not real camera output.
// Regenerates a handful of "continuous" surveillance-style clips with mostly
// silent audio and a few short noise bursts (stand-ins for a cough).
const path = require('path');
const { spawnSync } = require('child_process');

const OUT_DIR = __dirname;
const FFMPEG_DIR = process.env.FFMPEG_DIR || 'C:\\Users\\czhao6\\Downloads\\LosslessCut-win-x64\\resources';
const FFMPEG = process.env.FFMPEG_BIN || path.join(FFMPEG_DIR, 'ffmpeg.exe');

// [filename, durationSeconds, burstTimesSeconds]
const CLIPS = [
  ['20260101_120000.mp4', 20, [8]],
  ['20260101_120020.mp4', 20, [5, 15]],
  ['20260101_120040.mp4', 20, []],
  ['20260101_121000.mp4', 20, [18]],
];

function buildArgs(outPath, duration, bursts) {
  const inputs = [
    '-f', 'lavfi', '-i', `color=c=black:s=320x240:d=${duration}:r=15`,
    '-f', 'lavfi', '-i', `anullsrc=r=8000:cl=mono:d=${duration}`,
  ];
  const filterParts = [];
  const mixInputs = ['[1:a]'];

  bursts.forEach((t, idx) => {
    inputs.push('-f', 'lavfi', '-i', 'anoisesrc=d=0.35:c=pink:a=0.9');
    const inputIndex = 2 + idx;
    const delayMs = Math.round(t * 1000);
    filterParts.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs},apad=whole_dur=${duration}[n${idx}]`);
    mixInputs.push(`[n${idx}]`);
  });

  filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0[aout]`);

  return [
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-t', String(duration),
    '-y', outPath,
  ];
}

for (const [name, duration, bursts] of CLIPS) {
  const outPath = path.join(OUT_DIR, name);
  console.log(`generating ${name} (bursts at ${bursts.join(', ') || 'none'})`);
  const result = spawnSync(FFMPEG, buildArgs(outPath, duration, bursts), { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`failed to generate ${name}`);
    process.exit(1);
  }
}
console.log('done.');
