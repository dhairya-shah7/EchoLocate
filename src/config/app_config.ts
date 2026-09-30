/**
 * Centralized Configuration Management System
 * Provides configurable parameters for all app subsystems
 */

export interface AudioConfig {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  chirpFileName: string;
  pingIntervalMs: number;
  audioSource: number;
}

export interface DSPConfig {
  sampleRate: number;
  speedOfSound: number;
  minRange: number;      // Minimum detection range (metres)
  maxRange: number;      // Maximum detection range (metres)
  chirpStartFreq: number; // Chirp start frequency (Hz)
  chirpEndFreq: number;   // Chirp end frequency (Hz)
  chirpDuration: number;  // Chirp duration (seconds)
  spectrogramRows: number;
  spectrogramCols: number;
  envelopeLength: number;
}

export interface SensorConfig {
  gyroUpdateInterval: number;   // milliseconds
  accelUpdateInterval: number;  // milliseconds
  magUpdateInterval: number;    // milliseconds
  gyroTrustFactor: number;      // Complementary filter alpha
  accelTrustFactor: number;     // Complementary filter beta
  magTrustFactor: number;      // Complementary filter beta for magnetometer
  calibrationSamples: number;   // Number of samples for calibration
  calibrationTimeoutMs: number; // Max wait time for calibration in milliseconds
}

export interface UIConfig {
  mapScaleFactor: number;       // Pixels per metre
  maxMapObjects: number;        // Maximum objects to display on map
  scanIntervalMs: number;       // Time between scans
  ttsRate: number;              // Text-to-speech rate (0.1-1.0)
  ttsLanguage: string;          // TTS language code
  proximityThreshold: number;   // Distance for immediate hazard warning (metres)
}

export interface AppConfig {
  audio: AudioConfig;
  dsp: DSPConfig;
  sensor: SensorConfig;
  ui: UIConfig;
}

/**
 * Default configuration
 */
export const defaultConfig: AppConfig = {
  audio: {
    sampleRate: 48000,
    channels: 1,
    bitsPerSample: 16,
    chirpFileName: 'chirp_sequence',
    pingIntervalMs: 500,
    audioSource: 1, // Standard MIC (universal Android compatibility)
  },
  dsp: {
    sampleRate: 48000,
    speedOfSound: 343,
    minRange: 0.2,
    maxRange: 4.0,
    chirpStartFreq: 18000,
    chirpEndFreq: 22000,
    chirpDuration: 0.03,
    spectrogramRows: 64,
    spectrogramCols: 64,
    envelopeLength: 2000,
  },
  sensor: {
    gyroUpdateInterval: 20,
    accelUpdateInterval: 20,
    magUpdateInterval: 50,
    gyroTrustFactor: 0.98,
    accelTrustFactor: 0.02,
    magTrustFactor: 0.02,
    calibrationSamples: 40,
    calibrationTimeoutMs: 1500,
  },
  ui: {
    mapScaleFactor: 45,
    maxMapObjects: 15,
    scanIntervalMs: 700,
    ttsRate: 0.5,
    ttsLanguage: 'en-US',
    proximityThreshold: 0.6,
  },
};

/**
 * Configuration presets for different environments
 */
export const configPresets: { [key: string]: Partial<AppConfig> } = {
  indoor: {
    dsp: {
      ...defaultConfig.dsp,
      maxRange: 3.0,
      minRange: 0.3,
    },
    ui: {
      ...defaultConfig.ui,
      scanIntervalMs: 500,
    },
  },
  outdoor: {
    dsp: {
      ...defaultConfig.dsp,
      maxRange: 5.0,
      minRange: 0.5,
    },
    ui: {
      ...defaultConfig.ui,
      scanIntervalMs: 1000,
    },
  },
  performance: {
    dsp: {
      ...defaultConfig.dsp,
      spectrogramRows: 32,
      spectrogramCols: 32,
      envelopeLength: 1000,
    },
    ui: {
      ...defaultConfig.ui,
      scanIntervalMs: 400,
      maxMapObjects: 10,
    },
  },
  accuracy: {
    dsp: {
      ...defaultConfig.dsp,
      spectrogramRows: 128,
      spectrogramCols: 128,
      envelopeLength: 4000,
    },
    ui: {
      ...defaultConfig.ui,
      scanIntervalMs: 1000,
    },
  },
};

/**
 * Configuration manager class
 */
class ConfigManager {
  private config: AppConfig;

  constructor(initialConfig: AppConfig = defaultConfig) {
    this.config = { ...initialConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * Get specific section of configuration
   */
  getAudioConfig(): AudioConfig {
    return { ...this.config.audio };
  }

  getDSPConfig(): DSPConfig {
    return { ...this.config.dsp };
  }

  getSensorConfig(): SensorConfig {
    return { ...this.config.sensor };
  }

  getUIConfig(): UIConfig {
    return { ...this.config.ui };
  }

  /**
   * Update specific configuration section
   */
  updateAudioConfig(config: Partial<AudioConfig>): void {
    this.config.audio = { ...this.config.audio, ...config };
  }

  updateDSPConfig(config: Partial<DSPConfig>): void {
    this.config.dsp = { ...this.config.dsp, ...config };
  }

  updateSensorConfig(config: Partial<SensorConfig>): void {
    this.config.sensor = { ...this.config.sensor, ...config };
  }

  updateUIConfig(config: Partial<UIConfig>): void {
    this.config.ui = { ...this.config.ui, ...config };
  }

  /**
   * Load a preset configuration
   */
  loadPreset(presetName: string): void {
    const preset = configPresets[presetName];
    if (preset) {
      this.config = this.mergeConfig(this.config, preset);
    } else {
      console.warn(`Unknown preset: ${presetName}`);
    }
  }

  /**
   * Deep merge configurations
   */
  private mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
    return {
      audio: { ...base.audio, ...override.audio },
      dsp: { ...base.dsp, ...override.dsp },
      sensor: { ...base.sensor, ...override.sensor },
      ui: { ...base.ui, ...override.ui },
    };
  }

  /**
   * Reset to default configuration
   */
  resetToDefault(): void {
    this.config = { ...defaultConfig };
  }

  /**
   * Validate configuration values
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate audio config
    if (this.config.audio.sampleRate < 8000 || this.config.audio.sampleRate > 192000) {
      errors.push('Audio sample rate must be between 8000 and 192000 Hz');
    }
    if (this.config.audio.channels < 1 || this.config.audio.channels > 2) {
      errors.push('Audio channels must be 1 or 2');
    }

    // Validate DSP config
    if (this.config.dsp.minRange >= this.config.dsp.maxRange) {
      errors.push('DSP minRange must be less than maxRange');
    }
    if (this.config.dsp.chirpStartFreq >= this.config.dsp.chirpEndFreq) {
      errors.push('Chirp start frequency must be less than end frequency');
    }

    // Validate sensor config
    if (this.config.sensor.gyroTrustFactor < 0 || this.config.sensor.gyroTrustFactor > 1) {
      errors.push('Gyro trust factor must be between 0 and 1');
    }

    // Validate UI config
    if (this.config.ui.ttsRate < 0.1 || this.config.ui.ttsRate > 1.0) {
      errors.push('TTS rate must be between 0.1 and 1.0');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Singleton instance
export const configManager = new ConfigManager();

/**
 * Convenience function to get current config
 */
export function getConfig(): AppConfig {
  return configManager.getConfig();
}

/**
 * Convenience function to get specific config section
 */
export function getAudioConfig(): AudioConfig {
  return configManager.getAudioConfig();
}

export function getDSPConfig(): DSPConfig {
  return configManager.getDSPConfig();
}

export function getSensorConfig(): SensorConfig {
  return configManager.getSensorConfig();
}

export function getUIConfig(): UIConfig {
  return configManager.getUIConfig();
}
