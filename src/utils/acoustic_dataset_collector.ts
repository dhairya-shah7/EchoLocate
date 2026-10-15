/**
 * ACOUSTIC DATASET COLLECTOR (On-Device Real Chirp Logger)
 *
 * Allows developers and testers to record real-world ultrasonic reflections
 * in actual rooms directly from the smartphone microphone for model fine-tuning.
 */

export interface AcousticSample {
  id: string;
  timestamp: number;
  label: 'SPECULAR_HARD' | 'DIFFUSE_SCATTER' | 'ABSORPTIVE_SOFT' | 'APERTURE_OPENING' | 'CLEAR';
  groundTruthDistanceM: number;
  phoneHeightM: number;
  pitchDeg: number;
  rollDeg: number;
  envelope1D: number[];      // 2000-point normalized cross-correlation envelope
  spectrogram2D: number[];   // 64x64 flattened float array (4096 values)
}

class AcousticDatasetCollector {
  private samples: AcousticSample[] = [];
  private isCollecting: boolean = false;
  private currentTargetLabel: AcousticSample['label'] = 'SPECULAR_HARD';
  private currentTargetDistanceM: number = 1.0;

  public setTargetGroundTruth(label: AcousticSample['label'], distanceM: number) {
    this.currentTargetLabel = label;
    this.currentTargetDistanceM = distanceM;
  }

  public startCollection() {
    this.isCollecting = true;
  }

  public stopCollection() {
    this.isCollecting = false;
  }

  public getIsCollecting(): boolean {
    return this.isCollecting;
  }

  public recordFrame(
    envelope: Float32Array,
    spectrogram: Float32Array,
    pitchRad: number,
    rollRad: number
  ) {
    if (!this.isCollecting) return;

    const sample: AcousticSample = {
      id: `sample_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      label: this.currentTargetLabel,
      groundTruthDistanceM: this.currentTargetDistanceM,
      phoneHeightM: 1.2,
      pitchDeg: Math.round((pitchRad * 180) / Math.PI),
      rollDeg: Math.round((rollRad * 180) / Math.PI),
      envelope1D: Array.from(envelope),
      spectrogram2D: Array.from(spectrogram),
    };

    this.samples.push(sample);
  }

  public getSampleCount(): number {
    return this.samples.length;
  }

  public exportDatasetJson(): string {
    return JSON.stringify(this.samples, null, 2);
  }

  public clearSamples() {
    this.samples = [];
  }
}

export const acousticCollector = new AcousticDatasetCollector();
