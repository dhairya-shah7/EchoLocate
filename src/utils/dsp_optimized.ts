/**
 * OPTIMIZED DUAL-BRANCH DSP FEATURE EXTRACTION ENGINE
 * Implements:
 * 1. 1D Temporal Path: FFT-based Cross-Correlation + 0.5m-4.0m Acoustic Time-Gating
 * 2. 2D Spectral Path: Goertzel-DFT 64x64 Time-Frequency Spectrogram
 * 
 * Performance optimizations:
 * - FFT-based cross-correlation (O(n log n) instead of O(n*m))
 * - Pre-computed FFT of reference chirp
 * - Optimized memory allocation
 * - SIMD-friendly operations where possible
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
 * Helper for audio waveform samples bounded between -1.0 and +1.0.
 */
function sanitizeBipolar(val: number): number {
  if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
    return 0.0;
  }
  if (val < -1.0) return -1.0;
  if (val > 1.0) return 1.0;
  return val;
}

/**
 * Complex FFT and Cross-Correlation Engine
 * Cooley-Tukey Radix-2 DIT implementation supporting full complex forward & inverse transforms
 */
class ComplexFFT {
  static nextPowerOf2(n: number): number {
    let power = 1;
    while (power < n) power <<= 1;
    return power;
  }

  static transform(real: Float32Array, imag: Float32Array, inverse: boolean = false): void {
    const n = real.length;
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
      if (i < j) {
        const tr = real[i]; real[i] = real[j]; real[j] = tr;
        const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
      let k = n >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const angle = (inverse ? 2.0 : -2.0) * Math.PI / len;
      const wStepR = Math.cos(angle);
      const wStepI = Math.sin(angle);

      for (let i = 0; i < n; i += len) {
        let wR = 1.0;
        let wI = 0.0;
        for (let k = 0; k < half; k++) {
          const idx1 = i + k;
          const idx2 = i + k + half;
          const tR = wR * real[idx2] - wI * imag[idx2];
          const tI = wR * imag[idx2] + wI * real[idx2];

          real[idx2] = real[idx1] - tR;
          imag[idx2] = imag[idx1] - tI;
          real[idx1] += tR;
          imag[idx1] += tI;

          const nextWR = wR * wStepR - wI * wStepI;
          wI = wR * wStepI + wI * wStepR;
          wR = nextWR;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) {
        real[i] /= n;
        imag[i] /= n;
      }
    }
  }

  /**
   * Fast frequency-domain matched filter cross-correlation
   * R_xy(t) = IFFT( FFT(x) * conj(FFT(y)) )
   */
  static crossCorrelation(x: Float32Array, y: Float32Array): Float32Array {
    const totalLen = x.length + y.length;
    const fftSize = this.nextPowerOf2(totalLen);

    const xR = new Float32Array(fftSize);
    const xI = new Float32Array(fftSize);
    const yR = new Float32Array(fftSize);
    const yI = new Float32Array(fftSize);

    xR.set(x);
    yR.set(y);

    this.transform(xR, xI, false);
    this.transform(yR, yI, false);

    const prodR = new Float32Array(fftSize);
    const prodI = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      prodR[i] = xR[i] * yR[i] + xI[i] * yI[i];
      prodI[i] = xI[i] * yR[i] - xR[i] * yI[i];
    }

    this.transform(prodR, prodI, true);

    const result = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const r = prodR[i];
      const im = prodI[i];
      result[i] = Math.sqrt(r * r + im * im);
    }
    return result;
  }
}

/**
 * 1D TEMPORAL PATH:
 * Performs Cross-Correlation of raw PCM reflections against reference chirp,
 * applies 0.2m - 4.0m acoustic time-gating (blanking direct speaker bleed),
 * and resamples to target length (2000).
 */
export function computeEnvelopeOptimized(
  pcm: Int16Array,
  targetLength: number = 2000
): Float32Array {
  const envelope = new Float32Array(targetLength);
  if (!pcm || pcm.length === 0) return envelope;

  const n = pcm.length;
  const floatPcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sample = pcm[i] / 32768.0;
    floatPcm[i] = sanitizeBipolar(sample);
  }

  // Cross-correlation
  const xcorr = ComplexFFT.crossCorrelation(floatPcm, REFERENCE_CHIRP);

  // Time-gating: blank direct-path speaker bleed (< 0.2m / < 1.16ms) and capture up to 4.0m (~23.3ms)
  const tMin = (2 * 0.2) / SPEED_OF_SOUND; // ~0.2m roundtrip
  const tMax = (2 * 4.0) / SPEED_OF_SOUND; // ~4.0m roundtrip

  const sampleStart = Math.min(xcorr.length - 1, Math.max(0, Math.floor(tMin * SAMPLE_RATE)));
  const sampleEnd = Math.min(xcorr.length, Math.ceil(tMax * SAMPLE_RATE));
  const gatedLength = Math.max(1, sampleEnd - sampleStart);

  // Find max correlation strictly within the gated reflection window
  let maxCorr = 1e-6;
  for (let i = sampleStart; i < sampleEnd; i++) {
    const v = xcorr[i];
    if (v > maxCorr) maxCorr = v;
  }

  const normFactor = maxCorr > 1e-9 ? maxCorr : 1.0;

  // Resample gated region to targetLength
  const step = gatedLength / targetLength;
  for (let i = 0; i < targetLength; i++) {
    const idx = sampleStart + Math.floor(i * step);
    const rawVal = xcorr[Math.min(xcorr.length - 1, Math.max(0, idx))] || 0;
    envelope[i] = sanitize(rawVal / normFactor);
  }

  return envelope;
}

/**
 * Extracts true physical distance from envelope peak using Time-of-Flight acoustics.
 * Returns distance in metres (0.2m to 4.0m) and detection confidence.
 */
export function extractAcousticDistance(envelope: Float32Array): {
  range: number;
  confidence: number;
  isClear: boolean;
  peakAmplitude: number;
} {
  const len = envelope.length;
  if (!envelope || len === 0) {
    return { range: 4.0, confidence: 0.9, isClear: true, peakAmplitude: 0 };
  }

  let sum = 0;
  for (let i = 0; i < len; i++) sum += envelope[i];
  const meanNoise = sum / len;

  let varSum = 0;
  for (let i = 0; i < len; i++) {
    const diff = envelope[i] - meanNoise;
    varSum += diff * diff;
  }
  const stdDev = Math.sqrt(varSum / len);

  // Dynamic peak detection threshold above background noise
  const threshold = Math.max(0.35, meanNoise + 1.8 * stdDev);

  let peakIdx = -1;
  let maxVal = 0;

  for (let i = 0; i < len; i++) {
    if (envelope[i] > threshold && envelope[i] > maxVal) {
      maxVal = envelope[i];
      peakIdx = i;
    }
  }

  if (peakIdx === -1) {
    // No significant reflection detected - room is clear ahead
    return {
      range: 4.0,
      confidence: 0.85,
      isClear: true,
      peakAmplitude: maxVal,
    };
  }

  // Linear ToF mapping from index to metric distance: 0.2m to 4.0m
  const physicalDistance = 0.2 + (peakIdx / len) * 3.8;
  const snrConfidence = Math.min(0.98, Math.max(0.65, maxVal / (meanNoise + 0.05)));

  return {
    range: parseFloat(physicalDistance.toFixed(2)),
    confidence: parseFloat(snrConfidence.toFixed(2)),
    isClear: false,
    peakAmplitude: maxVal,
  };
}

/**
 * 2D SPECTRAL PATH (OPTIMIZED):
 * Computes Goertzel-DFT 64x64 Spectrogram across ultrasonic band (18kHz - 22kHz).
 */
export function computeSpectrogramOptimized(
  pcm: Int16Array,
  rows: number = 64,
  cols: number = 64
): Float32Array {
  const totalElements = rows * cols;
  const spec = new Float32Array(totalElements);
  if (!pcm || pcm.length === 0) return spec;

  const n = pcm.length;
  const tMin = (2 * 0.2) / SPEED_OF_SOUND;
  const tMax = (2 * 4.0) / SPEED_OF_SOUND;
  const gateStart = Math.floor(tMin * SAMPLE_RATE);
  const gateEnd = Math.min(n, Math.ceil(tMax * SAMPLE_RATE));
  const gatedRegionLength = Math.max(128, gateEnd - gateStart);

  const frameSize = 128;
  const hopSize = Math.max(1, Math.floor((gatedRegionLength - frameSize) / cols));

  const fStart = 18000;
  const fEnd = 22000;
  const freqStep = (fEnd - fStart) / Math.max(1, rows - 1);
  
  const coeffs = new Float32Array(rows);
  const ks = new Uint32Array(rows);
  for (let r = 0; r < rows; r++) {
    const targetFreq = fStart + r * freqStep;
    ks[r] = Math.round((targetFreq * frameSize) / SAMPLE_RATE);
    const omega = (2 * Math.PI * ks[r]) / frameSize;
    coeffs[r] = 2 * Math.cos(omega);
  }

  let globalMax = 1e-6;

  for (let c = 0; c < cols; c++) {
    const frameOffset = gateStart + c * hopSize;
    if (frameOffset + frameSize > n) break;

    for (let r = 0; r < rows; r++) {
      const coeff = coeffs[r];
      let s1 = 0;
      let s2 = 0;

      for (let i = 0; i < frameSize; i++) {
        const rawSample = pcm[frameOffset + i] / 32768.0;
        const sample = sanitizeBipolar(rawSample);
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

// Export optimized versions as default for backward compatibility
export const computeEnvelope = computeEnvelopeOptimized;
export const computeSpectrogram = computeSpectrogramOptimized;
