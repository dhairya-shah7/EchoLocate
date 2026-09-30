/**
 * Error Handler Tests
 * Tests for centralized error handling and recovery system
 */

import {
  errorHandler,
  handleError,
  ErrorCategory,
  ErrorSeverity,
  RecoveryStrategies,
} from '../src/utils/error_handler';

describe('Error Handler', () => {
  beforeEach(() => {
    errorHandler.clearHistory();
  });

  describe('handleError', () => {
    it('should handle string error', () => {
      const error = handleError('Test error', ErrorCategory.AUDIO);
      expect(error.category).toBe(ErrorCategory.AUDIO);
      expect(error.message).toBe('Test error');
      expect(error.severity).toBeDefined();
      expect(error.recoverable).toBeDefined();
    });

    it('should handle Error object', () => {
      const error = handleError(new Error('Test error'), ErrorCategory.MODEL);
      expect(error.category).toBe(ErrorCategory.MODEL);
      expect(error.message).toBe('Test error');
    });

    it('should handle object with message property', () => {
      const error = handleError({ message: 'Test error' }, ErrorCategory.SENSOR);
      expect(error.message).toBe('Test error');
    });

    it('should handle unknown error type', () => {
      const error = handleError(12345, ErrorCategory.UNKNOWN);
      expect(error.message).toBeDefined();
    });

    it('should classify permission errors as critical', () => {
      const error = handleError('permission denied', ErrorCategory.PERMISSION);
      expect(error.severity).toBe(ErrorSeverity.CRITICAL);
      expect(error.recoverable).toBe(false);
    });

    it('should classify model load errors as high severity', () => {
      const error = handleError('Failed to load model', ErrorCategory.MODEL);
      expect(error.severity).toBe(ErrorSeverity.HIGH);
    });

    it('should maintain error history', () => {
      handleError('Error 1', ErrorCategory.AUDIO);
      handleError('Error 2', ErrorCategory.MODEL);
      const history = errorHandler.getErrorHistory();
      expect(history.length).toBe(2);
    });

    it('should trim error history when exceeding max size', () => {
      for (let i = 0; i < 60; i++) {
        handleError(`Error ${i}`, ErrorCategory.AUDIO);
      }
      const history = errorHandler.getErrorHistory();
      expect(history.length).toBeLessThanOrEqual(50);
    });
  });

  describe('errorHandler methods', () => {
    it('should register error callback', () => {
      const callback = jest.fn();
      errorHandler.onError(ErrorCategory.AUDIO, callback);
      handleError('Test error', ErrorCategory.AUDIO);
      expect(callback).toHaveBeenCalled();
    });

    it('should get errors by category', () => {
      handleError('Audio error', ErrorCategory.AUDIO);
      handleError('Model error', ErrorCategory.MODEL);
      handleError('Another audio error', ErrorCategory.AUDIO);
      
      const audioErrors = errorHandler.getErrorsByCategory(ErrorCategory.AUDIO);
      expect(audioErrors.length).toBe(2);
      
      const modelErrors = errorHandler.getErrorsByCategory(ErrorCategory.MODEL);
      expect(modelErrors.length).toBe(1);
    });

    it('should get error statistics', () => {
      handleError('Audio error', ErrorCategory.AUDIO);
      handleError('Model error', ErrorCategory.MODEL);
      handleError('Another audio error', ErrorCategory.AUDIO);
      
      const stats = errorHandler.getErrorStats();
      expect(stats[ErrorCategory.AUDIO]).toBe(2);
      expect(stats[ErrorCategory.MODEL]).toBe(1);
    });

    it('should clear error history', () => {
      handleError('Error 1', ErrorCategory.AUDIO);
      handleError('Error 2', ErrorCategory.MODEL);
      errorHandler.clearHistory();
      const history = errorHandler.getErrorHistory();
      expect(history.length).toBe(0);
    });
  });

  describe('RecoveryStrategies', () => {
    it('should have audio recovery strategy', () => {
      expect(RecoveryStrategies.audio).toBeDefined();
      expect(typeof RecoveryStrategies.audio).toBe('function');
    });

    it('should have model recovery strategy', () => {
      expect(RecoveryStrategies.model).toBeDefined();
      expect(typeof RecoveryStrategies.model).toBe('function');
    });

    it('should have sensor recovery strategy', () => {
      expect(RecoveryStrategies.sensor).toBeDefined();
      expect(typeof RecoveryStrategies.sensor).toBe('function');
    });

    it('should have TTS recovery strategy', () => {
      expect(RecoveryStrategies.tts).toBeDefined();
      expect(typeof RecoveryStrategies.tts).toBe('function');
    });

    it('audio recovery should return boolean', async () => {
      const result = await RecoveryStrategies.audio();
      expect(typeof result).toBe('boolean');
    });

    it('model recovery should return boolean', async () => {
      const result = await RecoveryStrategies.model();
      expect(typeof result).toBe('boolean');
    });

    it('sensor recovery should return boolean', async () => {
      const result = await RecoveryStrategies.sensor();
      expect(typeof result).toBe('boolean');
    });

    it('TTS recovery should return boolean', async () => {
      const result = await RecoveryStrategies.tts();
      expect(typeof result).toBe('boolean');
    });
  });
});
