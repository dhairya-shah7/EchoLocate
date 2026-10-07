import { useState, useEffect, useRef } from 'react';
import { NativeModules, Platform } from 'react-native';
import * as ort from 'onnxruntime-react-native';
import { handleError, ErrorCategory } from '../utils/error_handler';
import { extractAcousticDistance } from '../utils/dsp_optimized';

export interface SonarPrediction {
  range: number;      // Distance (metres)
  angle: number;      // Azimuth angle (radians)
  width: number;      // Object width (metres)
  height: number;     // Object height (metres)
  type: 'obstacle' | 'wall' | 'doorway' | 'clear'; // Classification
  semanticLabel?: 'WALL' | 'DOORWAY' | 'DESK' | 'BED' | 'CHAIR' | 'OBSTACLE' | 'CLEAR';
  pulseWidthMeters?: number;
  secondaryEchoRange?: number | null;
  confidence: number; // Detection confidence (0.0 to 1.0)
}

function getErrorMessage(err: any): string {
  if (!err) return 'Unknown error occurred';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.description) return err.description;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function useSonarInference(modelPath: string) {
  const [isModelLoading, setIsModelLoading] = useState<boolean>(true);
  const [prediction, setPrediction] = useState<SonarPrediction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<ort.InferenceSession | null>(null);

  useEffect(() => {
    async function loadModel() {
      try {
        let resolvedPath = modelPath;
        if (Platform.OS === 'android' && NativeModules.AssetCopy?.copyAssetToCache) {
          resolvedPath = await NativeModules.AssetCopy.copyAssetToCache(modelPath);
        }

        const session = await ort.InferenceSession.create(resolvedPath);
        sessionRef.current = session;
        setIsModelLoading(false);
        setError(null);
      } catch (err: any) {
        const msg = getErrorMessage(err);
        handleError(err, ErrorCategory.MODEL);
        console.warn('ONNX model session init notice, running native acoustic DSP engine:', msg);
        setIsModelLoading(false);
      }
    }
    loadModel();
  }, [modelPath]);

  const runDspAcousticInference = (envelope1D: Float32Array) => {
    const acoustic = extractAcousticDistance(envelope1D);

    setPrediction({
      range: acoustic.range,
      angle: 0.0,
      width: acoustic.estimatedWidth,
      height: acoustic.estimatedHeight,
      type: acoustic.classifiedType,
      semanticLabel: acoustic.semanticLabel,
      pulseWidthMeters: acoustic.pulseWidthMeters,
      secondaryEchoRange: acoustic.secondaryEchoRange,
      confidence: acoustic.confidence,
    });
    setError(null);
  };

  const runInference = async (spectrogram2D: Float32Array, envelope1D: Float32Array) => {
    // Always compute physical Time-of-Flight and multi-echo features from the calibrated DSP envelope
    const acoustic = extractAcousticDistance(envelope1D);

    if (!sessionRef.current) {
      runDspAcousticInference(envelope1D);
      return;
    }

    try {
      let spec = spectrogram2D;
      if (!spec || spec.length !== 4096) {
        const padded = new Float32Array(4096);
        if (spec) padded.set(spec.subarray(0, Math.min(spec.length, 4096)));
        spec = padded;
      }

      let env = envelope1D;
      if (!env || env.length !== 2000) {
        const padded = new Float32Array(2000);
        if (env) padded.set(env.subarray(0, Math.min(env.length, 2000)));
        env = padded;
      }

      const epsilon = 1e-6;
      for (let i = 0; i < 4096; i++) {
        const v = spec[i];
        spec[i] = typeof v !== 'number' || isNaN(v) || !isFinite(v)
          ? epsilon
          : Math.max(epsilon, Math.min(1.0 - epsilon, v));
      }
      for (let i = 0; i < 2000; i++) {
        const v = env[i];
        env[i] = typeof v !== 'number' || isNaN(v) || !isFinite(v)
          ? epsilon
          : Math.max(epsilon, Math.min(1.0 - epsilon, v));
      }

      const cleanSpec = Float32Array.from(spec);
      const cleanEnv = Float32Array.from(env);

      const tensorSpectrogram = new ort.Tensor('float32', cleanSpec, [1, 1, 64, 64]);
      const tensorEnvelope = new ort.Tensor('float32', cleanEnv, [1, 1, 2000]);

      let outputs: ort.InferenceSession.ReturnType | null = null;
      const inputNames = sessionRef.current.inputNames || [];
      const feeds: Record<string, ort.Tensor> = {};

      if (inputNames.length === 1) {
        const combined = new Float32Array(4096 + 2000);
        combined.set(cleanEnv, 0);
        combined.set(cleanSpec, 2000);
        feeds[inputNames[0]] = new ort.Tensor('float32', combined, [1, 1, 6096]);
      } else if (inputNames.length >= 2) {
        for (let i = 0; i < inputNames.length; i++) {
          const name = inputNames[i];
          const lower = name.toLowerCase();
          if (lower.includes('spec') || lower.includes('gram')) {
            feeds[name] = tensorSpectrogram;
          } else if (lower.includes('env') || lower.includes('impulse')) {
            feeds[name] = tensorEnvelope;
          } else {
            feeds[name] = i === 0 ? tensorEnvelope : tensorSpectrogram;
          }
        }
      } else {
        feeds['envelope'] = tensorEnvelope;
        feeds['spectogram'] = tensorSpectrogram;
      }

      try {
        outputs = await sessionRef.current.run(feeds);
      } catch {
        try {
          outputs = await sessionRef.current.run({
            envelope: tensorEnvelope,
            spectrogram: tensorSpectrogram,
          });
        } catch {
          outputs = await sessionRef.current.run({
            input_1: tensorEnvelope,
            input_2: tensorSpectrogram,
          });
        }
      }

      const outputTensor = outputs ? (outputs.predictions || Object.values(outputs)[0]) : null;
      if (!outputTensor || !outputTensor.data) {
        throw new Error('No output tensor data returned from ONNX session.');
      }
      const data = outputTensor.data as Float32Array;

      const onnxRange = Math.abs(data[0] || 0);
      const onnxAngle = Math.max(-0.45, Math.min(0.45, data[1] || 0));
      const onnxWidth = Math.abs(data[2] || 0);
      const onnxHeight = Math.abs(data[3] || 0);
      const typeVal = Math.abs(data[4] || 0);
      const onnxConf = Math.min(1.0, Math.max(0.0, Math.abs(data[5] || 0.85)));

      // Hybrid Neuro-Physical Fusion:
      // Anchor distance to physical Time-of-Flight (acoustic.range) when ONNX range is out of physical bounds,
      // or blend 75% physical ToF + 25% ONNX refinement when both agree.
      const fusedRange = (onnxRange >= 0.25 && onnxRange <= 3.9 && !acoustic.isClear)
        ? parseFloat((0.75 * acoustic.range + 0.25 * onnxRange).toFixed(2))
        : acoustic.range;

      // Determine final object classification & semantic label using both ONNX & multi-echo acoustics
      let finalType: 'obstacle' | 'wall' | 'doorway' | 'clear' = acoustic.classifiedType;
      let finalLabel: 'WALL' | 'DOORWAY' | 'DESK' | 'BED' | 'CHAIR' | 'OBSTACLE' | 'CLEAR' = acoustic.semanticLabel;

      if (acoustic.isClear || fusedRange >= 3.75) {
        finalType = 'clear';
        finalLabel = 'CLEAR';
      } else if (acoustic.classifiedType === 'doorway' || typeVal > 2.4) {
        finalType = 'doorway';
        finalLabel = 'DOORWAY';
      } else if (acoustic.classifiedType === 'wall' || typeVal > 1.65) {
        finalType = 'wall';
        finalLabel = 'WALL';
      } else {
        finalType = 'obstacle';
        if (onnxWidth > 1.25 || acoustic.semanticLabel === 'BED') {
          finalLabel = 'BED';
        } else if (onnxWidth > 0.7 || acoustic.semanticLabel === 'DESK') {
          finalLabel = 'DESK';
        } else if (acoustic.semanticLabel === 'CHAIR') {
          finalLabel = 'CHAIR';
        } else {
          finalLabel = 'OBSTACLE';
        }
      }

      const fusedWidth = onnxWidth >= 0.35 && onnxWidth <= 2.5
        ? parseFloat((0.6 * acoustic.estimatedWidth + 0.4 * onnxWidth).toFixed(2))
        : acoustic.estimatedWidth;

      const fusedHeight = onnxHeight >= 0.4 && onnxHeight <= 2.8
        ? parseFloat((0.6 * acoustic.estimatedHeight + 0.4 * onnxHeight).toFixed(2))
        : acoustic.estimatedHeight;

      setPrediction({
        range: fusedRange,
        angle: parseFloat(onnxAngle.toFixed(2)),
        width: fusedWidth,
        height: fusedHeight,
        type: finalType,
        semanticLabel: finalLabel,
        pulseWidthMeters: acoustic.pulseWidthMeters,
        secondaryEchoRange: acoustic.secondaryEchoRange,
        confidence: parseFloat(Math.max(acoustic.confidence, onnxConf).toFixed(2)),
      });
      setError(null);
    } catch (err: any) {
      console.warn('ONNX inference notice, running DSP acoustic fallback:', getErrorMessage(err));
      runDspAcousticInference(envelope1D);
    }
  };

  return { isModelLoading, prediction, error, runInference };
}