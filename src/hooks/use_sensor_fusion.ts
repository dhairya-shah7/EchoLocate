import { useState, useEffect, useRef, useCallback } from 'react';
import { gyroscope, accelerometer, magnetometer, setUpdateIntervalForType, SensorTypes } from 'react-native-sensors';
import { getSensorConfig } from '../config/app_config';
import { appStore } from '../store/app_store';
import { handleError, ErrorCategory } from '../utils/error_handler';

export interface SensorData {
  yaw: number;          // Heading angle in radians (-π to π)
  pitch: number;        // Pitch angle in radians
  roll: number;         // Roll angle in radians
  accuracy: number;     // Sensor accuracy (0-1)
  isCalibrated: boolean;
  stepCount?: number;   // Pedestrian Dead Reckoning step counter
}

export interface CalibrationData {
  gyroBias: { x: number; y: number; z: number };
  accelBias: { x: number; y: number; z: number };
  magBias: { x: number; y: number; z: number };
  isCalibrated: boolean;
}

/**
 * Computes safe dt in seconds between sensor ticks.
 * Handles Android nanoseconds (SystemClock.elapsedRealtimeNanos), milliseconds, or epoch timestamps.
 */
export function computeDeltaSeconds(
  rawTimestamp: number,
  lastTimestamp: number | null,
  defaultIntervalMs: number = 20
): number {
  const fallbackDt = Math.max(0.005, defaultIntervalMs / 1000);
  if (lastTimestamp === null || lastTimestamp === undefined || lastTimestamp <= 0) {
    return fallbackDt;
  }

  const rawDiff = rawTimestamp - lastTimestamp;
  if (rawDiff <= 0) {
    return fallbackDt;
  }

  let dtSeconds: number;
  if (rawDiff > 1_000_000) {
    dtSeconds = rawDiff / 1e9;
  } else if (rawDiff > 10_000) {
    dtSeconds = rawDiff / 1e6;
  } else {
    dtSeconds = rawDiff / 1e3;
  }

  if (isNaN(dtSeconds) || !isFinite(dtSeconds) || dtSeconds < 0.001 || dtSeconds > 0.25) {
    return fallbackDt;
  }

  return dtSeconds;
}

/**
 * Advanced sensor fusion with drift correction, resilient calibration,
 * and Pedestrian Dead Reckoning (PDR) accelerometer step detection.
 */
export function useSensorFusion(onStepDetected?: (stepLengthMeters: number, headingYaw: number) => void) {
  const [sensorData, setSensorData] = useState<SensorData>({
    yaw: 0,
    pitch: 0,
    roll: 0,
    accuracy: 0,
    isCalibrated: false,
    stepCount: 0,
  });

  const [calibrationData, setCalibrationData] = useState<CalibrationData>({
    gyroBias: { x: 0, y: 0, z: 0 },
    accelBias: { x: 0, y: 0, z: 0 },
    magBias: { x: 0, y: 0, z: 0 },
    isCalibrated: false,
  });

  const [isCalibrating, setIsCalibrating] = useState<boolean>(false);
  const [calibrationProgress, setCalibrationProgress] = useState<number>(0);

  const calibrationDataRef = useRef<CalibrationData>({
    gyroBias: { x: 0, y: 0, z: 0 },
    accelBias: { x: 0, y: 0, z: 0 },
    magBias: { x: 0, y: 0, z: 0 },
    isCalibrated: false,
  });

  const orientationRef = useRef({ yaw: 0, pitch: 0, roll: 0 });
  const gyroSamplesRef = useRef<{ x: number; y: number; z: number }[]>([]);
  const accelSamplesRef = useRef<{ x: number; y: number; z: number }[]>([]);
  const lastGyroTimeRef = useRef<number | null>(null);
  const isCalibratingRef = useRef<boolean>(false);
  const calibrationTimerRef = useRef<NodeJS.Timeout | null>(null);
  const onCalibrationCompleteCallbackRef = useRef<((success: boolean) => void) | null>(null);

  // Step detection state (Pedestrian Dead Reckoning)
  const lastStepTimeRef = useRef<number>(0);
  const gravityMagBaselineRef = useRef<number>(9.81);
  const stepCountRef = useRef<number>(0);
  const onStepCallbackRef = useRef(onStepDetected);
  useEffect(() => {
    onStepCallbackRef.current = onStepDetected;
  }, [onStepDetected]);

  const sensorConfig = getSensorConfig();
  const ALPHA = sensorConfig.gyroTrustFactor;
  const BETA = sensorConfig.accelTrustFactor;
  const targetSamples = sensorConfig.calibrationSamples || 40;
  const timeoutMs = sensorConfig.calibrationTimeoutMs || 1500;

  const completeCalibration = useCallback(() => {
    if (calibrationTimerRef.current) {
      clearTimeout(calibrationTimerRef.current);
      calibrationTimerRef.current = null;
    }

    const gyroSamples = gyroSamplesRef.current;
    const accelSamples = accelSamplesRef.current;
    isCalibratingRef.current = false;
    setIsCalibrating(false);
    setCalibrationProgress(1);

    let gyroBias = { x: 0, y: 0, z: 0 };
    if (gyroSamples.length >= 5) {
      gyroBias = {
        x: gyroSamples.reduce((sum, s) => sum + s.x, 0) / gyroSamples.length,
        y: gyroSamples.reduce((sum, s) => sum + s.y, 0) / gyroSamples.length,
        z: gyroSamples.reduce((sum, s) => sum + s.z, 0) / gyroSamples.length,
      };
    }

    if (accelSamples.length >= 5) {
      const avgAx = accelSamples.reduce((sum, s) => sum + s.x, 0) / accelSamples.length;
      const avgAy = accelSamples.reduce((sum, s) => sum + s.y, 0) / accelSamples.length;
      const avgAz = accelSamples.reduce((sum, s) => sum + s.z, 0) / accelSamples.length;
      orientationRef.current.pitch = Math.atan2(-avgAx, Math.sqrt(avgAy * avgAy + avgAz * avgAz));
      orientationRef.current.roll = Math.atan2(avgAy, avgAz || 1);
      gravityMagBaselineRef.current = Math.sqrt(avgAx * avgAx + avgAy * avgAy + avgAz * avgAz) || 9.81;
    }

    orientationRef.current.yaw = 0;
    appStore.setCurrentYaw(0);

    const newCalibration: CalibrationData = {
      gyroBias,
      accelBias: { x: 0, y: 0, z: 0 },
      magBias: { x: 0, y: 0, z: 0 },
      isCalibrated: true,
    };

    calibrationDataRef.current = newCalibration;
    setCalibrationData(newCalibration);
    appStore.setSensorCalibrated(true);

    setSensorData(prev => ({
      ...prev,
      isCalibrated: true,
      accuracy: 0.9,
    }));

    gyroSamplesRef.current = [];
    accelSamplesRef.current = [];

    if (onCalibrationCompleteCallbackRef.current) {
      const cb = onCalibrationCompleteCallbackRef.current;
      onCalibrationCompleteCallbackRef.current = null;
      cb(true);
    }
  }, []);

  const startCalibration = useCallback((onComplete?: (success: boolean) => void) => {
    if (calibrationTimerRef.current) {
      clearTimeout(calibrationTimerRef.current);
    }

    isCalibratingRef.current = true;
    setIsCalibrating(true);
    setCalibrationProgress(0);
    gyroSamplesRef.current = [];
    accelSamplesRef.current = [];
    lastGyroTimeRef.current = null;
    onCalibrationCompleteCallbackRef.current = onComplete || null;

    const uncalibrated: CalibrationData = {
      gyroBias: { x: 0, y: 0, z: 0 },
      accelBias: { x: 0, y: 0, z: 0 },
      magBias: { x: 0, y: 0, z: 0 },
      isCalibrated: false,
    };
    calibrationDataRef.current = uncalibrated;
    setCalibrationData(uncalibrated);
    appStore.setSensorCalibrated(false);

    calibrationTimerRef.current = setTimeout(() => {
      if (isCalibratingRef.current) {
        completeCalibration();
      }
    }, timeoutMs);
  }, [completeCalibration, timeoutMs]);

  useEffect(() => {
    try {
      setUpdateIntervalForType(SensorTypes.gyroscope, sensorConfig.gyroUpdateInterval);
      setUpdateIntervalForType(SensorTypes.accelerometer, sensorConfig.accelUpdateInterval);
      setUpdateIntervalForType(SensorTypes.magnetometer, sensorConfig.magUpdateInterval);
    } catch (err) {
      handleError(err, ErrorCategory.SENSOR);
    }

    let gyroSub: any = null;
    let accelSub: any = null;
    let magSub: any = null;

    try {
      gyroSub = gyroscope.subscribe(
        ({ x, y, z, timestamp }) => {
          const dt = computeDeltaSeconds(timestamp, lastGyroTimeRef.current, sensorConfig.gyroUpdateInterval);
          lastGyroTimeRef.current = timestamp;

          if (isCalibratingRef.current) {
            gyroSamplesRef.current.push({ x, y, z });
            const progress = Math.min(0.99, gyroSamplesRef.current.length / targetSamples);
            setCalibrationProgress(progress);

            if (gyroSamplesRef.current.length >= targetSamples) {
              completeCalibration();
            }
            return;
          }

          const cal = calibrationDataRef.current;
          const biasX = cal.isCalibrated ? cal.gyroBias.x : 0;
          const biasY = cal.isCalibrated ? cal.gyroBias.y : 0;
          const biasZ = cal.isCalibrated ? cal.gyroBias.z : 0;

          orientationRef.current.yaw += (z - biasZ) * dt;
          orientationRef.current.pitch += (x - biasX) * dt;
          orientationRef.current.roll += (y - biasY) * dt;

          orientationRef.current.yaw = Math.atan2(
            Math.sin(orientationRef.current.yaw),
            Math.cos(orientationRef.current.yaw)
          );

          appStore.setCurrentYaw(orientationRef.current.yaw);

          setSensorData(prev => ({
            ...prev,
            yaw: orientationRef.current.yaw,
            pitch: orientationRef.current.pitch,
            roll: orientationRef.current.roll,
            isCalibrated: cal.isCalibrated,
          }));
        },
        (error) => {
          handleError(error, ErrorCategory.SENSOR);
        }
      );
    } catch (err) {
      handleError(err, ErrorCategory.SENSOR);
    }

    try {
      accelSub = accelerometer.subscribe(
        ({ x, y, z }) => {
          if (isCalibratingRef.current) {
            accelSamplesRef.current.push({ x, y, z });
            return;
          }

          const norm = Math.sqrt(y * y + z * z) || 1e-5;
          const accelPitch = Math.atan2(-x, norm);
          const accelRoll = Math.atan2(y, z || 1e-5);

          orientationRef.current.pitch = ALPHA * orientationRef.current.pitch + BETA * accelPitch;
          orientationRef.current.roll = ALPHA * orientationRef.current.roll + BETA * accelRoll;

          // Pedestrian Dead Reckoning (PDR) Step Detection
          const mag = Math.sqrt(x * x + y * y + z * z);
          gravityMagBaselineRef.current = 0.97 * gravityMagBaselineRef.current + 0.03 * mag;
          const dynamicLinearAccel = mag - gravityMagBaselineRef.current;
          const now = Date.now();

          if (dynamicLinearAccel > 2.1 && now - lastStepTimeRef.current > 460) {
            lastStepTimeRef.current = now;
            stepCountRef.current += 1;
            if (onStepCallbackRef.current) {
              onStepCallbackRef.current(0.62, orientationRef.current.yaw);
            }
          }

          setSensorData(prev => ({
            ...prev,
            pitch: orientationRef.current.pitch,
            roll: orientationRef.current.roll,
            stepCount: stepCountRef.current,
          }));
        },
        (error) => {
          handleError(error, ErrorCategory.SENSOR);
        }
      );
    } catch (err) {
      handleError(err, ErrorCategory.SENSOR);
    }

    try {
      magSub = magnetometer.subscribe(
        ({ x, y, z }) => {
          if (isCalibratingRef.current) return;

          const pitch = orientationRef.current.pitch;
          const roll = orientationRef.current.roll;

          const cosP = Math.cos(pitch);
          const sinP = Math.sin(pitch);
          const cosR = Math.cos(roll);
          const sinR = Math.sin(roll);

          const Bx = x * cosP + y * sinR * sinP + (z || 0) * cosR * sinP;
          const By = y * cosR - (z || 0) * sinR;

          const magYaw = Math.atan2(-By, Bx);

          const diff = Math.atan2(
            Math.sin(magYaw - orientationRef.current.yaw),
            Math.cos(magYaw - orientationRef.current.yaw)
          );
          orientationRef.current.yaw += (sensorConfig.magTrustFactor || 0.02) * diff;
          orientationRef.current.yaw = Math.atan2(
            Math.sin(orientationRef.current.yaw),
            Math.cos(orientationRef.current.yaw)
          );

          appStore.setCurrentYaw(orientationRef.current.yaw);

          setSensorData(prev => ({
            ...prev,
            yaw: orientationRef.current.yaw,
            accuracy: 0.9,
          }));
        },
        () => {}
      );
    } catch {}

    return () => {
      if (calibrationTimerRef.current) {
        clearTimeout(calibrationTimerRef.current);
      }
      if (gyroSub) gyroSub.unsubscribe();
      if (accelSub) accelSub.unsubscribe();
      if (magSub) magSub.unsubscribe();
    };
  }, [ALPHA, BETA, completeCalibration, sensorConfig.accelUpdateInterval, sensorConfig.gyroUpdateInterval, sensorConfig.magTrustFactor, sensorConfig.magUpdateInterval, targetSamples]);

  return {
    sensorData,
    calibrationData,
    isCalibrating,
    calibrationProgress,
    startCalibration,
    completeCalibration,
  };
}
