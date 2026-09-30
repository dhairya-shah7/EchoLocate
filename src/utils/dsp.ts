/**
 * DUAL-BRANCH DSP FEATURE EXTRACTION ENGINE
 * Implements:
 * 1. 1D Temporal Path: Cross-Correlation matched filtering + 0.5m-4.0m Acoustic Time-Gating
 * 2. 2D Spectral Path: Goertzel-DFT 64x64 Time-Frequency Spectrogram
 */

const SAMPLE_RATE = 48000;
const SPEED_OF_SOUND = 343; // metres per second

/**
 * Generates a normalized reference ultrasonic chirp template (18kHz to 22kHz sweep over 20ms).
 */
export function generateReferenceChirp(
  sampleRate: number = SAMPLE_RATE,
  durationSec: number = 0.02,
  fStart: number = 18000,
  fEnd: number = 22000
): Float32Array {
  const numSamples = Math.floor(sampleRate * durationSec);
  const chirp = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = fStart + (fEnd - fStart) * (t / (2 * durationSec));
    chirp[i] = Math.sin(2 * Math.PI * freq * t);
  }
  return chirp;
}

const REFERENCE_CHIRP = generateReferenceChirp();

/**
 * Helper to ensure a number is a finite float bounded strictly between 0.0 and 1.0.
 */
function sanitize(val: number): number {
  if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
    return 0.0;
  }
  if (val < 0.0) return 0.0;
  if (val > 1.0) return 1.0;
  return val;
}

/**
 * 1D TEMPORAL PATH:
 * Performs Cross-Correlation of raw PCM reflections against reference chirp,
 * applies 0.5m - 4.0m acoustic time-gating, and resamples to target length (2000).
 */
export function computeEnvelope(
  pcm: Int16Array,
  targetLength: number = 2000
): Float32Array {
  const envelope = new Float32Array(targetLength);
  if (!pcm || pcm.length === 0) return envelope;

  const n = pcm.length;
  const floatPcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sample = pcm[i] / 32768.0;
    floatPcm[i] = sanitize(sample);
  }

  // 1. Matched-Filter Normalized Cross-Correlation
  const m = REFERENCE_CHIRP.length;
  const xcorrLength = Math.max(1, n - m);
  const xcorr = new Float32Array(xcorrLength);
  let maxCorr = 1e-6;

  for (let i = 0; i < xcorrLength; i++) {
    let sum = 0;
    for (let j = 0; j < m; j++) {
      sum += floatPcm[i + j] * REFERENCE_CHIRP[j];
    }
    const absVal = Math.abs(sum);
    xcorr[i] = isNaN(absVal) || !isFinite(absVal) ? 0 : absVal;
    if (xcorr[i] > maxCorr) {
      maxCorr = xcorr[i];
    }
  }

  // Normalize cross-correlation output
  const normFactor = maxCorr > 1e-9 ? maxCorr : 1.0;
  for (let i = 0; i < xcorrLength; i++) {
    xcorr[i] = sanitize(xcorr[i] / normFactor);
  }

  // 2. 0.5m - 4.0m Acoustic Time-Gating
  // Round trip time: t = (2 * d) / c
  const tMin = (2 * 0.5) / SPEED_OF_SOUND; // ~2.915 ms -> sample 140
  const tMax = (2 * 4.0) / SPEED_OF_SOUND; // ~23.32 ms -> sample 1120

  const sampleStart = Math.min(xcorrLength - 1, Math.floor(tMin * SAMPLE_RATE));
  const sampleEnd = Math.min(xcorrLength, Math.ceil(tMax * SAMPLE_RATE));
  const gatedLength = Math.max(1, sampleEnd - sampleStart);

  // 3. Interpolate gated impulse response down to exactly `targetLength` (2000 samples)
  const step = gatedLength / targetLength;
  for (let i = 0; i < targetLength; i++) {
    const idx = sampleStart + Math.floor(i * step);
    const rawVal = xcorr[Math.min(xcorrLength - 1, Math.max(0, idx))] || 0;
    envelope[i] = sanitize(rawVal);
  }

  return envelope;
}

/**
 * 2D SPECTRAL PATH:
 * Computes Goertzel-DFT 64x64 Spectrogram across ultrasonic band (18kHz - 22kHz).
 */
export function computeSpectrogram(
  pcm: Int16Array,
  rows: number = 64,
  cols: number = 64
): Float32Array {
  const totalElements = rows * cols;
  const spec = new Float32Array(totalElements);
  if (!pcm || pcm.length === 0) return spec;

  const n = pcm.length;
  // 0.5m - 4.0m acoustic time gate bounds
  const tMin = (2 * 0.5) / SPEED_OF_SOUND;
  const tMax = (2 * 4.0) / SPEED_OF_SOUND;
  const gateStart = Math.floor(tMin * SAMPLE_RATE);
  const gateEnd = Math.min(n, Math.ceil(tMax * SAMPLE_RATE));
  const gatedRegionLength = Math.max(128, gateEnd - gateStart);

  const frameSize = 128;
  const hopSize = Math.max(1, Math.floor((gatedRegionLength - frameSize) / cols));

  // Goertzel target frequencies across 18kHz to 22kHz band
  const fStart = 18000;
  const fEnd = 22000;
  const freqStep = (fEnd - fStart) / Math.max(1, rows - 1);

  let globalMax = 1e-6;

  for (let c = 0; c < cols; c++) {
    const frameOffset = gateStart + c * hopSize;
    if (frameOffset + frameSize > n) break;

    for (let r = 0; r < rows; r++) {
      const targetFreq = fStart + r * freqStep;
      const k = Math.round((targetFreq * frameSize) / SAMPLE_RATE);
      const omega = (2 * Math.PI * k) / frameSize;
      const coeff = 2 * Math.cos(omega);

      let s1 = 0;
      let s2 = 0;

      for (let i = 0; i < frameSize; i++) {
        const rawSample = pcm[frameOffset + i] / 32768.0;
        const sample = sanitize(rawSample);
        const s0 = sample + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }

      const power = Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
      const logMag = Math.log1p(Math.sqrt(power));

      const safeMag = isNaN(logMag) || !isFinite(logMag) ? 0 : logMag;
      spec[r * cols + c] = safeMag;
      if (safeMag > globalMax) {
        globalMax = safeMag;
      }
    }
  }

  // Normalize spectrogram to [0, 1]
  const specNormFactor = globalMax > 1e-9 ? globalMax : 1.0;
  for (let i = 0; i < totalElements; i++) {
    spec[i] = sanitize(spec[i] / specNormFactor);
  }

  return spec;
}
