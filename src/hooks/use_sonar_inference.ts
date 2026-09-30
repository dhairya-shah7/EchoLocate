import { useState, useEffect, useRef } from 'react';
import { NativeModules, Platform } from 'react-native';
import * as ort from 'onnxruntime-react-native';
import { handleError, ErrorCategory, RecoveryStrategies } from '../utils/error_handler';
import { extractAcousticDistance } from '../utils/dsp_optimized';

export interface SonarPrediction {
  range: number;      // Distance (metres)
  angle: number;      // Azimuth angle (radians)
  width: number;      // Object width (metres)
  height: number;     // Object height (metres)
  type: 'obstacle' | 'wall' | 'doorway' | 'clear'; // Classification
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

  // Initialize the ONNX Runtime Session
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
        // Do not block app: DSP acoustic engine provides real-time ToF measurements
      }
    }
    loadModel();
  }, [modelPath]);

  const runDspAcousticInference = (envelope1D: Float32Array) => {
    const acoustic = extractAcousticDistance(envelope1D);
    let type: 'obstacle' | 'wall' | 'doorway' | 'clear' = 'obstacle';
    if (acoustic.isClear || acoustic.range >= 3.8) {
      type = 'clear';
    } else if (acoustic.peakAmplitude > 0.65) {
      type = 'wall';
    } else {
      type = 'obstacle';
    }

    setPrediction({
      range: acoustic.range,
      angle: 0.0,
      width: type === 'wall' ? 1.5 : 0.6,
      height: 1.2,
      type,
      confidence: acoustic.confidence,
    });
    setError(null);
  };

  // Execute inference on the dual-branch DSP outputs
  const runInference = async (spectrogram2D: Float32Array, envelope1D: Float32Array) => {
    if (!sessionRef.current) {
      // Seamlessly execute acoustic DSP Time-of-Flight engine
      runDspAcousticInference(envelope1D);
      return;
    }
    
    try {
      // Ensure Float32Array input size matches expected tensor dimensions exactly
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

      // 1. Sanitize Float32Array elements to strictly finite numbers bounded between 0.0 and 1.0
      // Use a small epsilon to avoid exactly 0 or 1 which can cause numerical issues
      const epsilon = 1e-6;
      for (let i = 0; i < 4096; i++) {
        const v = spec[i];
        if (typeof v !== 'number' || isNaN(v) || !isFinite(v)) {
          spec[i] = epsilon;
        } else {
          spec[i] = Math.max(epsilon, Math.min(1.0 - epsilon, v));
        }
      }
      for (let i = 0; i < 2000; i++) {
        const v = env[i];
        if (typeof v !== 'number' || isNaN(v) || !isFinite(v)) {
          env[i] = epsilon;
        } else {
          env[i] = Math.max(epsilon, Math.min(1.0 - epsilon, v));
        }
      }

      // 2. Prepare Input Tensors with fresh 0-offset Float32Arrays: envelope shape [1, 1, 2000], spectrogram shape [1, 1, 64, 64]
      const cleanSpec = Float32Array.from(spec);
      const cleanEnv = Float32Array.from(env);

      // Verify tensor data before creating tensors
      if (cleanSpec.some(v => isNaN(v) || !isFinite(v))) {
        throw new Error("Spectrogram contains NaN or Inf values after sanitization");
      }
      if (cleanEnv.some(v => isNaN(v) || !isFinite(v))) {
        throw new Error("Envelope contains NaN or Inf values after sanitization");
      }

      const tensorSpectrogram = new ort.Tensor('float32', cleanSpec, [1, 1, 64, 64]);
      const tensorEnvelope = new ort.Tensor('float32', cleanEnv, [1, 1, 2000]);

      // 3. Run multi-modal attention transformer model with dynamic input feed mapping
      let outputs: ort.InferenceSession.ReturnType | null = null;
      const inputNames = sessionRef.current.inputNames || [];
      const feeds: Record<string, ort.Tensor> = {};

      if (inputNames.length === 1) {
        // Single concatenated tensor input model
        const combined = new Float32Array(4096 + 2000);
        combined.set(cleanEnv, 0);
        combined.set(cleanSpec, 2000);
        feeds[inputNames[0]] = new ort.Tensor('float32', combined, [1, 1, 6096]);
      } else if (inputNames.length >= 2) {
        // Multi-input tensor model: map based on name or position
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
        // Fallback default keys
        feeds['envelope'] = tensorEnvelope;
        feeds['spectogram'] = tensorSpectrogram;
      }

      try {
        outputs = await sessionRef.current.run(feeds);
      } catch (feedError) {
        // Second attempt with inverted/standard keys
        console.warn('Primary ONNX run failed, attempting key fallback...', feedError);
        try {
          outputs = await sessionRef.current.run({
            envelope: tensorEnvelope,
            spectrogram: tensorSpectrogram,
          });
        } catch (e2) {
          outputs = await sessionRef.current.run({
            input_1: tensorEnvelope,
            input_2: tensorSpectrogram,
          });
        }
      }

      // Extract 6-Channel Regression Output Head [1, 6]
      const outputTensor = outputs ? (outputs.predictions || Object.values(outputs)[0]) : null; 
      if (!outputTensor || !outputTensor.data) {
        throw new Error("No output tensor data returned from ONNX session.");
      }
      const data = outputTensor.data as Float32Array;

      // Extract raw outputs
      const rawRange = Math.abs(data[0] || 0);
      const rawAngle = data[1] || 0;
      const rawWidth = Math.abs(data[2] || 0);
      const rawHeight = Math.abs(data[3] || 0);
      const typeVal = Math.abs(data[4] || 0);
      const rawConf = Math.min(1.0, Math.max(0.0, Math.abs(data[5] || 0.85)));

      // Classify type based on neural regression prediction head
      let objType: 'obstacle' | 'wall' | 'doorway' | 'clear' = 'obstacle';
      if (typeVal > 2.5) {
        objType = 'doorway';
      } else if (rawWidth > 0.8 || typeVal > 1.5) {
        objType = 'wall';
      } else if (rawRange > 3.5) {
        objType = 'clear';
      }

      setPrediction({
        range: parseFloat(rawRange.toFixed(2)),
        angle: parseFloat(rawAngle.toFixed(2)),
        width: parseFloat(rawWidth.toFixed(2)),
        height: parseFloat(rawHeight.toFixed(2)),
        type: objType,
        confidence: parseFloat(rawConf.toFixed(2)),
      });
      setError(null);
      
    } catch (err: any) {
      console.warn('ONNX inference notice, running DSP acoustic fallback:', getErrorMessage(err));
      runDspAcousticInference(envelope1D);
    }
  };

  return { isModelLoading, prediction, error, runInference };
}