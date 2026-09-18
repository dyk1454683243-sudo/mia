/**
 * One-shot synthesizer for the three table samples. Run from the repo root:
 *   node scripts/generate-table-sounds.mjs
 * The committed WAVs are the product; this file exists so they can be remade.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 22_050;
const DIR = join(dirname(fileURLToPath(import.meta.url)), "../client/src/sounds");

function writeWav(name, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.writeInt16LE(Math.round(x * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const path = join(DIR, name);
  writeFileSync(path, Buffer.concat([header, data]));
  console.log(`${name}  ${data.length + 44} bytes  ${(samples.length / RATE).toFixed(3)}s`);
}

function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0x1_0000_0000) * 2 - 1;
  };
}

function envelope(t, attack, decay) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) / decay);
}

/** Four short noise bursts — dice shaking in a leather cup. */
function cupRattle() {
  const n = Math.round(RATE * 0.32);
  const out = new Float64Array(n);
  const rnd = noise(0xC0FFEE);
  const bursts = [0.02, 0.09, 0.16, 0.23];
  let hp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let amp = 0;
    for (const start of bursts) {
      const u = t - start;
      if (u >= 0 && u < 0.035) amp += envelope(u, 0.003, 0.012);
    }
    const raw = rnd();
    hp = 0.55 * hp + 0.45 * raw;
    out[i] = (raw - hp) * amp * 0.72;
  }
  return out;
}

/** A hard click plus a couple of wooden resonances. */
function dieOnWood() {
  const n = Math.round(RATE * 0.14);
  const out = new Float64Array(n);
  const rnd = noise(0xD1CE);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const click = envelope(t, 0.001, 0.006) * rnd() * 0.55;
    const body =
      Math.sin(2 * Math.PI * 187 * t) * envelope(t, 0.002, 0.045) * 0.42 +
      Math.sin(2 * Math.PI * 346 * t) * envelope(t, 0.002, 0.03) * 0.28 +
      Math.sin(2 * Math.PI * 712 * t) * envelope(t, 0.001, 0.018) * 0.16;
    out[i] = click + body;
  }
  return out;
}

/** Low, short thud — the reveal stamp. */
function revealThud() {
  const n = Math.round(RATE * 0.28);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = envelope(t, 0.006, 0.09);
    out[i] =
      Math.sin(2 * Math.PI * 58 * t) * env * 0.7 +
      Math.sin(2 * Math.PI * 86 * t) * env * 0.28 +
      Math.sin(2 * Math.PI * 42 * t) * envelope(t, 0.008, 0.12) * 0.18;
  }
  return out;
}

writeWav("cup-rattle.wav", cupRattle());
writeWav("die-on-wood.wav", dieOnWood());
writeWav("reveal-thud.wav", revealThud());
