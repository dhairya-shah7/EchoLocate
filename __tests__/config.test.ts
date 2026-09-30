/**
 * Configuration Management Tests
 * Tests for configuration system and validation
 */

import {
  defaultConfig,
  configManager,
  configPresets,
  getConfig,
  getAudioConfig,
  getDSPConfig,
  getSensorConfig,
  getUIConfig,
} from '../src/config/app_config';

describe('Configuration Management', () => {
  describe('defaultConfig', () => {
    it('should have all required sections', () => {
      expect(defaultConfig.audio).toBeDefined();
      expect(defaultConfig.dsp).toBeDefined();
      expect(defaultConfig.sensor).toBeDefined();
      expect(defaultConfig.ui).toBeDefined();
    });

    it('should have valid audio config', () => {
      expect(defaultConfig.audio.sampleRate).toBe(48000);
      expect(defaultConfig.audio.channels).toBe(1);
      expect(defaultConfig.audio.bitsPerSample).toBe(16);
    });

    it('should have valid DSP config', () => {
      expect(defaultConfig.dsp.minRange).toBeLessThan(defaultConfig.dsp.maxRange);
      expect(defaultConfig.dsp.chirpStartFreq).toBeLessThan(defaultConfig.dsp.chirpEndFreq);
    });

    it('should have valid sensor config', () => {
      expect(defaultConfig.sensor.gyroTrustFactor).toBeGreaterThan(0);
      expect(defaultConfig.sensor.gyroTrustFactor).toBeLessThanOrEqual(1);
    });

    it('should have valid UI config', () => {
      expect(defaultConfig.ui.ttsRate).toBeGreaterThan(0);
      expect(defaultConfig.ui.ttsRate).toBeLessThanOrEqual(1);
    });
  });

  describe('configPresets', () => {
    it('should have indoor preset', () => {
      expect(configPresets.indoor).toBeDefined();
      expect(configPresets.indoor.dsp?.maxRange).toBeLessThan(defaultConfig.dsp.maxRange);
    });

    it('should have outdoor preset', () => {
      expect(configPresets.outdoor).toBeDefined();
      expect(configPresets.outdoor.dsp?.maxRange).toBeGreaterThan(defaultConfig.dsp.maxRange);
    });

    it('should have performance preset', () => {
      expect(configPresets.performance).toBeDefined();
      expect(configPresets.performance.dsp?.spectrogramRows).toBeLessThan(defaultConfig.dsp.spectrogramRows);
    });

    it('should have accuracy preset', () => {
      expect(configPresets.accuracy).toBeDefined();
      expect(configPresets.accuracy.dsp?.spectrogramRows).toBeGreaterThan(defaultConfig.dsp.spectrogramRows);
    });
  });

  describe('configManager', () => {
    beforeEach(() => {
      configManager.resetToDefault();
    });

    it('should get current config', () => {
      const config = configManager.getConfig();
      expect(config).toEqual(defaultConfig);
    });

    it('should get audio config', () => {
      const audioConfig = configManager.getAudioConfig();
      expect(audioConfig).toEqual(defaultConfig.audio);
    });

    it('should update audio config', () => {
      configManager.updateAudioConfig({ sampleRate: 44100 });
      const audioConfig = configManager.getAudioConfig();
      expect(audioConfig.sampleRate).toBe(44100);
    });

    it('should load preset', () => {
      configManager.loadPreset('indoor');
      const config = configManager.getConfig();
      expect(config.dsp.maxRange).toBe(3.0);
    });

    it('should handle unknown preset', () => {
      const consoleWarn = jest.spyOn(console, 'warn');
      configManager.loadPreset('unknown');
      expect(consoleWarn).toHaveBeenCalledWith('Unknown preset: unknown');
      consoleWarn.mockRestore();
    });

    it('should validate valid config', () => {
      const validation = configManager.validateConfig();
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should validate invalid audio sample rate', () => {
      configManager.updateAudioConfig({ sampleRate: 100 });
      const validation = configManager.validateConfig();
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it('should validate invalid DSP range', () => {
      configManager.updateDSPConfig({ minRange: 5.0, maxRange: 3.0 });
      const validation = configManager.validateConfig();
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it('should reset to default', () => {
      configManager.updateAudioConfig({ sampleRate: 44100 });
      configManager.resetToDefault();
      const config = configManager.getConfig();
      expect(config).toEqual(defaultConfig);
    });
  });

  describe('convenience functions', () => {
    beforeEach(() => {
      configManager.resetToDefault();
    });

    it('getConfig should return current config', () => {
      const config = getConfig();
      expect(config).toEqual(defaultConfig);
    });

    it('getAudioConfig should return audio config', () => {
      const audioConfig = getAudioConfig();
      expect(audioConfig).toEqual(defaultConfig.audio);
    });

    it('getDSPConfig should return DSP config', () => {
      const dspConfig = getDSPConfig();
      expect(dspConfig).toEqual(defaultConfig.dsp);
    });

    it('getSensorConfig should return sensor config', () => {
      const sensorConfig = getSensorConfig();
      expect(sensorConfig).toEqual(defaultConfig.sensor);
    });

    it('getUIConfig should return UI config', () => {
      const uiConfig = getUIConfig();
      expect(uiConfig).toEqual(defaultConfig.ui);
    });
  });
});
