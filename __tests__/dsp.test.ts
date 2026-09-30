/**
 * DSP Algorithm Tests
 * Tests for optimized DSP functions including FFT-based cross-correlation
 */

import { computeEnvelope, computeSpectrogram, generateReferenceChirp } from '../src/utils/dsp_optimized';

describe('DSP Functions', () => {
  describe('generateReferenceChirp', () => {
    it('should generate chirp with correct length', () => {
      const chirp = generateReferenceChirp(48000, 0.02, 18000, 22000);
      expect(chirp.length).toBe(960); // 48000 * 0.02
    });

    it('should generate chirp with values in valid range', () => {
      const chirp = generateReferenceChirp();
      for (let i = 0; i < chirp.length; i++) {
        expect(chirp[i]).toBeGreaterThanOrEqual(-1);
        expect(chirp[i]).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('computeEnvelope', () => {
    it('should handle empty input', () => {
      const envelope = computeEnvelope(new Int16Array(0));
      expect(envelope.length).toBe(2000);
      expect(envelope.every(v => v === 0)).toBe(true);
    });

    it('should handle null input', () => {
      const envelope = computeEnvelope(null as any);
      expect(envelope.length).toBe(2000);
      expect(envelope.every(v => v === 0)).toBe(true);
    });

    it('should return envelope of correct length', () => {
      const pcm = new Int16Array(4800); // 0.1 seconds at 48kHz
      const envelope = computeEnvelope(pcm, 1000);
      expect(envelope.length).toBe(1000);
    });

    it('should normalize output to [0, 1]', () => {
      const pcm = new Int16Array(4800);
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = Math.floor(Math.random() * 32768);
      }
      const envelope = computeEnvelope(pcm);
      for (let i = 0; i < envelope.length; i++) {
        expect(envelope[i]).toBeGreaterThanOrEqual(0);
        expect(envelope[i]).toBeLessThanOrEqual(1);
      }
    });

    it('should handle NaN and Infinity values', () => {
      const pcm = new Int16Array(4800);
      pcm[100] = NaN as any;
      pcm[200] = Infinity as any;
      const envelope = computeEnvelope(pcm);
      expect(envelope.every(v => !isNaN(v) && isFinite(v))).toBe(true);
    });
  });

  describe('computeSpectrogram', () => {
    it('should handle empty input', () => {
      const spec = computeSpectrogram(new Int16Array(0));
      expect(spec.length).toBe(4096); // 64 * 64
      expect(spec.every(v => v === 0)).toBe(true);
    });

    it('should handle null input', () => {
      const spec = computeSpectrogram(null as any);
      expect(spec.length).toBe(4096);
      expect(spec.every(v => v === 0)).toBe(true);
    });

    it('should return spectrogram of correct dimensions', () => {
      const pcm = new Int16Array(4800);
      const spec = computeSpectrogram(pcm, 32, 32);
      expect(spec.length).toBe(1024); // 32 * 32
    });

    it('should normalize output to [0, 1]', () => {
      const pcm = new Int16Array(4800);
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = Math.floor(Math.random() * 32768);
      }
      const spec = computeSpectrogram(pcm);
      for (let i = 0; i < spec.length; i++) {
        expect(spec[i]).toBeGreaterThanOrEqual(0);
        expect(spec[i]).toBeLessThanOrEqual(1);
      }
    });

    it('should handle NaN and Infinity values', () => {
      const pcm = new Int16Array(4800);
      pcm[100] = NaN as any;
      pcm[200] = Infinity as any;
      const spec = computeSpectrogram(pcm);
      expect(spec.every(v => !isNaN(v) && isFinite(v))).toBe(true);
    });
  });
});
