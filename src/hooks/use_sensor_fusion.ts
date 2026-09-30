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
    // Nanoseconds to seconds (Android native sensor timestamp)
    dtSeconds = rawDiff / 1e9;
  } else if (rawDiff > 10_000) {
    // Microseconds to seconds
    dtSeconds = rawDiff / 1e6;
  } else {
    // Milliseconds to seconds
    dtSeconds = rawDiff / 1e3;
  }

  // Guard against outlier or delayed ticks
  if (isNaN(dtSeconds) || !isFinite(dtSeconds) || dtSeconds < 0.001 || dtSeconds > 0.25) {
    return fallbackDt;
  }

  return dtSeconds;
}

/**
 * Advanced sensor fusion with drift correction, resilient calibration,
 * and graceful fallback for devices missing hardware sensors.
 */
export function useSensorFusion() {
  const [sensorData, setSensorData] = useState<SensorData>({
    yaw: 0,
    pitch: 0,
    roll: 0,
    accuracy: 0,
    isCalibrated: false,
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

  const sensorConfig = getSensorConfig();
  const ALPHA = sensorConfig.gyroTrustFactor;
  const BETA = sensorConfig.accelTrustFactor;
  const targetSamples = sensorConfig.calibrationSamples || 40;
  const timeoutMs = sensorConfig.calibrationTimeoutMs || 1500;

  // Complete calibration calculation
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

    // Compute gyro bias (average static drift)
    let gyroBias = { x: 0, y: 0, z: 0 };
    if (gyroSamples.length >= 5) {
      gyroBias = {
        x: gyroSamples.reduce((sum, s) => sum + s.x, 0) / gyroSamples.length,
        y: gyroSamples.reduce((sum, s) => sum + s.y, 0) / gyroSamples.length,
        z: gyroSamples.reduce((sum, s) => sum + s.z, 0) / gyroSamples.length,
      };
    }

    // Compute initial orientation level from accelerometer gravity baseline
    if (accelSamples.length >= 5) {
      const avgAx = accelSamples.reduce((sum, s) => sum + s.x, 0) / accelSamples.length;
      const avgAy = accelSamples.reduce((sum, s) => sum + s.y, 0) / accelSamples.length;
      const avgAz = accelSamples.reduce((sum, s) => sum + s.z, 0) / accelSamples.length;
      orientationRef.current.pitch = Math.atan2(-avgAx, Math.sqrt(avgAy * avgAy + avgAz * avgAz));
      orientationRef.current.roll = Math.atan2(avgAy, avgAz || 1);
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

  // Start calibration process
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

    // Safety timeout ensures calibration ALWAYS finishes promptly even on sluggish or missing sensor devices
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

    // Gyroscope integration with drift correction
    try {
      gyroSub = gyroscope.subscribe(
        ({ x, y, z, timestamp }) => {
          const dt = computeDeltaSeconds(timestamp, lastGyroTimeRef.current, sensorConfig.gyroUpdateInterval);
          lastGyroTimeRef.current = timestamp;

          // Collect samples during calibration
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

          // Integrate angular velocity with safe clamped dt
          orientationRef.current.yaw += (z - biasZ) * dt;
          orientationRef.current.pitch += (x - biasX) * dt;
          orientationRef.current.roll += (y - biasY) * dt;

          // Normalize yaw to [-π, π]
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

    // Accelerometer for tilt correction and initial level
    try {
      accelSub = accelerometer.subscribe(
        ({ x, y, z }) => {
          if (isCalibratingRef.current) {
            accelSamplesRef.current.push({ x, y, z });
            return;
          }

          // Calculate pitch and roll from gravity vector
          const norm = Math.sqrt(y * y + z * z) || 1e-5;
          const accelPitch = Math.atan2(-x, norm);
          const accelRoll = Math.atan2(y, z || 1e-5);

          // Complementary filter
          orientationRef.current.pitch = ALPHA * orientationRef.current.pitch + BETA * accelPitch;
          orientationRef.current.roll = ALPHA * orientationRef.current.roll + BETA * accelRoll;

          setSensorData(prev => ({
            ...prev,
            pitch: orientationRef.current.pitch,
            roll: orientationRef.current.roll,
          }));
        },
        (error) => {
          handleError(error, ErrorCategory.SENSOR);
        }
      );
    } catch (err) {
      handleError(err, ErrorCategory.SENSOR);
    }

    // Magnetometer with 3D tilt-compensation (pitch & roll) for precise compass heading
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

          // 3D Tilt-compensated magnetic vector
          const Bx = x * cosP + y * sinR * sinP + (z || 0) * cosR * sinP;
          const By = y * cosR - (z || 0) * sinR;

          // Stable tilt-compensated heading
          const magYaw = Math.atan2(-By, Bx);

          // Smooth complementary fusion avoiding ±π wrap-around jump
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
        () => {
          // Gracefully ignore missing magnetometer without breaking orientation
        }
      );
    } catch {
      // Missing hardware magnetometer fallback
    }

    return () => {
      if (calibrationTimerRef.current) {
        clearTimeout(calibrationTimerRef.current);
      }
      if (gyroSub) gyroSub.unsubscribe();
      if (accelSub) accelSub.unsubscribe();
      if (magSub) magSub.unsubscribe();
    };
  }, [ALPHA, BETA, completeCalibration, sensorConfig.accelUpdateInterval, sensorConfig.gyroUpdateInterval, sensorConfig.magUpdateInterval, targetSamples]);

  return {
    sensorData,
    calibrationData,
    isCalibrating,
    calibrationProgress,
    startCalibration,
    completeCalibration,
  };
}
