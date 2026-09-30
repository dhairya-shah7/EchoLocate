jest.mock('react-native', () => ({
  NativeModules: {
    RNSensors: {
      isAvailable: jest.fn().mockResolvedValue(true),
      start: jest.fn(),
      stop: jest.fn(),
    },
  },
  Platform: { OS: 'android', select: (obj: any) => obj.android },
}));

jest.mock('react-native-sensors', () => ({
  SensorTypes: {
    gyroscope: 'gyroscope',
    accelerometer: 'accelerometer',
    magnetometer: 'magnetometer',
  },
  setUpdateIntervalForType: jest.fn(),
  gyroscope: {
    subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  },
  accelerometer: {
    subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  },
  magnetometer: {
    subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
  },
}));

import { computeDeltaSeconds } from '../src/hooks/use_sensor_fusion';
import { appStore } from '../src/store/app_store';

describe('Sensor Fusion & Calibration Logic', () => {
  describe('computeDeltaSeconds (Timestamp Normalization)', () => {
    it('should return fallback dt when lastTimestamp is null or 0', () => {
      expect(computeDeltaSeconds(1000000000, null, 20)).toBe(0.02);
      expect(computeDeltaSeconds(1000000000, 0, 20)).toBe(0.02);
      expect(computeDeltaSeconds(1000000000, -1, 20)).toBe(0.02);
    });

    it('should handle Android nanosecond timestamps correctly', () => {
      const t1 = 50_000_000_000; // 50s in ns
      const t2 = 50_020_000_000; // +20ms in ns (diff = 20,000,000 ns)
      const dt = computeDeltaSeconds(t2, t1, 20);
      expect(dt).toBeCloseTo(0.02, 3);
    });

    it('should handle microsecond timestamps correctly', () => {
      const t1 = 50_000_000; // 50s in us
      const t2 = 50_025_000; // +25ms in us (diff = 25,000 us)
      const dt = computeDeltaSeconds(t2, t1, 20);
      expect(dt).toBeCloseTo(0.025, 3);
    });

    it('should handle millisecond timestamps correctly', () => {
      const t1 = 1772643600000; // epoch ms
      const t2 = 1772643600020; // +20ms
      const dt = computeDeltaSeconds(t2, t1, 20);
      expect(dt).toBeCloseTo(0.02, 3);
    });

    it('should clamp abnormal/outlier dt values to default fallback', () => {
      // Extremely large gap (e.g. initial timestamp epoch mismatch)
      const dtHuge = computeDeltaSeconds(1772643600000, 50000, 20);
      expect(dtHuge).toBe(0.02);

      // Negative delta
      const dtNegative = computeDeltaSeconds(100, 200, 20);
      expect(dtNegative).toBe(0.02);

      // Nan / invalid
      const dtNaN = computeDeltaSeconds(NaN, 100, 20);
      expect(dtNaN).toBe(0.02);
    });
  });

  describe('App Store calibration sync', () => {
    it('should update sensorCalibrated state in app store', () => {
      appStore.setSensorCalibrated(false);
      expect(appStore.getState().sensorCalibrated).toBe(false);

      appStore.setSensorCalibrated(true);
      expect(appStore.getState().sensorCalibrated).toBe(true);
    });

    it('should update currentYaw in app store', () => {
      appStore.setCurrentYaw(1.25);
      expect(appStore.getState().currentYaw).toBe(1.25);
    });
  });
});
