// Synthesized sound effects via the Web Audio API — no audio files needed.

let ctx = null;
let muted = false;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setMuted(m) {
  muted = m;
}

export function isMuted() {
  return muted;
}

// Call once from a user gesture (click) so the browser lets audio play.
export function unlock() {
  ac();
}

function tone({ freq, dur = 0.15, type = 'sine', gain = 0.12, when = 0, glideTo = null }) {
  const a = ac();
  if (!a || muted) return;
  const t0 = a.currentTime + when;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noise({ dur = 0.06, gain = 0.08, when = 0 }) {
  const a = ac();
  if (!a || muted) return;
  const t0 = a.currentTime + when;
  const buf = a.createBuffer(1, a.sampleRate * dur, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const filter = a.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 1500;
  src.connect(filter).connect(g).connect(a.destination);
  src.start(t0);
}

export const sfx = {
  click() {
    tone({ freq: 700, dur: 0.06, type: 'square', gain: 0.05 });
  },
  // Dice rattling in the cup, then hitting the table.
  roll() {
    for (let i = 0; i < 7; i++) noise({ when: i * 0.09, dur: 0.04, gain: 0.06 });
    noise({ when: 0.65, dur: 0.09, gain: 0.12 });
  },
  place() {
    tone({ freq: 520, dur: 0.1, type: 'triangle', gain: 0.15 });
    tone({ freq: 780, dur: 0.12, type: 'triangle', gain: 0.12, when: 0.05 });
  },
  wild() {
    [880, 1108, 1318, 1760].forEach((f, i) =>
      tone({ freq: f, dur: 0.14, type: 'sine', gain: 0.09, when: i * 0.06 })
    );
  },
  pass() {
    tone({ freq: 220, dur: 0.25, type: 'sawtooth', gain: 0.06, glideTo: 140 });
  },
  // Yoink! — a ring gets stolen.
  steal() {
    tone({ freq: 900, dur: 0.18, type: 'sawtooth', gain: 0.08, glideTo: 300 });
    noise({ when: 0.12, dur: 0.05, gain: 0.08 });
    tone({ freq: 520, dur: 0.1, type: 'triangle', gain: 0.14, when: 0.16 });
    tone({ freq: 780, dur: 0.12, type: 'triangle', gain: 0.12, when: 0.21 });
  },
  // A little cartoon "boing" when an emoji reaction lands.
  react() {
    tone({ freq: 440, dur: 0.12, type: 'triangle', gain: 0.1, glideTo: 880 });
    tone({ freq: 1320, dur: 0.08, type: 'sine', gain: 0.06, when: 0.1 });
  },
  yourTurn() {
    tone({ freq: 660, dur: 0.1, type: 'sine', gain: 0.08 });
    tone({ freq: 990, dur: 0.12, type: 'sine', gain: 0.08, when: 0.09 });
  },
  // "RINGO!" fanfare.
  win() {
    const notes = [523, 659, 784, 1047, 784, 1047, 1319];
    notes.forEach((f, i) =>
      tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.14, when: i * 0.12 })
    );
    tone({ freq: 1568, dur: 0.5, type: 'triangle', gain: 0.12, when: notes.length * 0.12 });
  },
  lose() {
    [392, 330, 262].forEach((f, i) =>
      tone({ freq: f, dur: 0.25, type: 'triangle', gain: 0.1, when: i * 0.18 })
    );
  },
};
