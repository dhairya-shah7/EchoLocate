/**
 * Centralized State Management
 * Provides a simple state store for managing application-wide state
 */

import React from 'react';

export interface AppState {
  isScanning: boolean;
  mapObjects: MapObject[];
  sensorCalibrated: boolean;
  ttsReady: boolean;
  lastError: string | null;
  currentYaw: number;
}

export interface MapObject {
  id: string;
  x: number;
  y: number;
  range: number;
  bearingDeg: number;
  width: number;
  height: number;
  type: 'obstacle' | 'wall' | 'doorway' | 'clear';
  label: string;
  confidence: number;
}

type StateListener = (state: AppState) => void;

class AppStore {
  private state: AppState;
  private listeners: Set<StateListener> = new Set();

  constructor() {
    this.state = {
      isScanning: false,
      mapObjects: [],
      sensorCalibrated: false,
      ttsReady: false,
      lastError: null,
      currentYaw: 0,
    };
  }

  /**
   * Get current state
   */
  getState(): AppState {
    return { ...this.state };
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of state change
   */
  private notify(): void {
    this.listeners.forEach(listener => listener(this.getState()));
  }

  /**
   * Update scanning state
   */
  setScanning(isScanning: boolean): void {
    this.state.isScanning = isScanning;
    this.notify();
  }

  /**
   * Add map object
   */
  addMapObject(obj: MapObject): void {
    this.state.mapObjects = [...this.state.mapObjects, obj];
    this.notify();
  }

  /**
   * Clear all map objects
   */
  clearMapObjects(): void {
    this.state.mapObjects = [];
    this.notify();
  }

  /**
   * Update sensor calibration status
   */
  setSensorCalibrated(calibrated: boolean): void {
    this.state.sensorCalibrated = calibrated;
    this.notify();
  }

  /**
   * Update TTS ready status
   */
  setTTSReady(ready: boolean): void {
    this.state.ttsReady = ready;
    this.notify();
  }

  /**
   * Set last error
   */
  setError(error: string | null): void {
    this.state.lastError = error;
    this.notify();
  }

  /**
   * Update current yaw
   */
  setCurrentYaw(yaw: number): void {
    this.state.currentYaw = yaw;
    this.notify();
  }

  /**
   * Reset state to initial values
   */
  reset(): void {
    this.state = {
      isScanning: false,
      mapObjects: [],
      sensorCalibrated: false,
      ttsReady: false,
      lastError: null,
      currentYaw: 0,
    };
    this.notify();
  }
}

// Singleton instance
export const appStore = new AppStore();

/**
 * React hook for using the app store
 */
export function useAppStore(): AppState {
  const [state, setState] = React.useState(appStore.getState());

  React.useEffect(() => {
    const unsubscribe = appStore.subscribe(setState);
    return unsubscribe;
  }, []);

  return state;
}
