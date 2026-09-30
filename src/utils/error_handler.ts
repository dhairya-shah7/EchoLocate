/**
 * Centralized Error Handling and Recovery System
 * Provides error classification, recovery strategies, and logging
 */

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum ErrorCategory {
  AUDIO = 'audio',
  MODEL = 'model',
  SENSOR = 'sensor',
  TTS = 'tts',
  PERMISSION = 'permission',
  ASSET = 'asset',
  UNKNOWN = 'unknown',
}

export interface AppError {
  id: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  message: string;
  timestamp: number;
  recoverable: boolean;
  recoveryAction?: () => Promise<void> | void;
}

class ErrorHandler {
  private errorHistory: AppError[] = [];
  private maxHistorySize = 50;
  private errorCallbacks: Map<ErrorCategory, (error: AppError) => void> = new Map();

  /**
   * Classify and log an error
   */
  handleError(error: unknown, category: ErrorCategory = ErrorCategory.UNKNOWN): AppError {
    const appError = this.createError(error, category);
    this.errorHistory.push(appError);
    
    // Trim history if needed
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }

    // Log error
    console.error(`[${category.toUpperCase()}] ${appError.message}`, appError);

    // Trigger category-specific callback
    const callback = this.errorCallbacks.get(category);
    if (callback) {
      callback(appError);
    }

    return appError;
  }

  /**
   * Create a structured error object
   */
  private createError(error: unknown, category: ErrorCategory): AppError {
    const message = this.extractMessage(error);
    const severity = this.determineSeverity(category, message);
    const recoverable = this.isRecoverable(category, message);

    return {
      id: `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      category,
      severity,
      message,
      timestamp: Date.now(),
      recoverable,
      recoveryAction: this.getRecoveryAction(category, message),
    };
  }

  /**
   * Extract error message from various error types
   */
  private extractMessage(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object' && 'message' in error) {
      return String(error.message);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown error occurred';
    }
  }

  /**
   * Determine error severity based on category and message
   */
  private determineSeverity(category: ErrorCategory, message: string): ErrorSeverity {
    // Critical errors that prevent app functionality
    if (message.includes('permission denied') || message.includes('access denied')) {
      return ErrorSeverity.CRITICAL;
    }
    if (category === ErrorCategory.MODEL && message.includes('load')) {
      return ErrorSeverity.HIGH;
    }
    if (category === ErrorCategory.AUDIO && message.includes('init')) {
      return ErrorSeverity.HIGH;
    }

    // Medium severity errors
    if (category === ErrorCategory.SENSOR || category === ErrorCategory.TTS) {
      return ErrorSeverity.MEDIUM;
    }

    // Low severity by default
    return ErrorSeverity.LOW;
  }

  /**
   * Determine if error is recoverable
   */
  private isRecoverable(category: ErrorCategory, message: string): boolean {
    if (category === ErrorCategory.PERMISSION) return false;
    if (message.includes('permission denied')) return false;
    if (message.includes('not found') && category === ErrorCategory.ASSET) return false;
    return true;
  }

  /**
   * Get recovery action for specific errors
   */
  private getRecoveryAction(category: ErrorCategory, message: string): (() => Promise<void> | void) | undefined {
    switch (category) {
      case ErrorCategory.AUDIO:
        return () => {
          console.log('Attempting audio recovery: reinitializing audio subsystem');
          // Audio recovery would be handled by the audio hook
        };
      case ErrorCategory.MODEL:
        return () => {
          console.log('Attempting model recovery: reloading model');
          // Model recovery would be handled by the inference hook
        };
      case ErrorCategory.SENSOR:
        return () => {
          console.log('Attempting sensor recovery: recalibrating sensors');
          // Sensor recovery would be handled by the sensor fusion hook
        };
      case ErrorCategory.TTS:
        return () => {
          console.log('Attempting TTS recovery: reinitializing TTS engine');
          // TTS recovery would be handled by the dashboard
        };
      default:
        return undefined;
    }
  }

  /**
   * Register callback for specific error category
   */
  onError(category: ErrorCategory, callback: (error: AppError) => void): void {
    this.errorCallbacks.set(category, callback);
  }

  /**
   * Get error history
   */
  getErrorHistory(): AppError[] {
    return [...this.errorHistory];
  }

  /**
   * Get recent errors by category
   */
  getErrorsByCategory(category: ErrorCategory): AppError[] {
    return this.errorHistory.filter(e => e.category === category);
  }

  /**
   * Clear error history
   */
  clearHistory(): void {
    this.errorHistory = [];
  }

  /**
   * Get error statistics
   */
  getErrorStats(): { [key: string]: number } {
    const stats: { [key: string]: number } = {};
    this.errorHistory.forEach(error => {
      stats[error.category] = (stats[error.category] || 0) + 1;
    });
    return stats;
  }
}

// Singleton instance
export const errorHandler = new ErrorHandler();

/**
 * Convenience function to handle errors
 */
export function handleError(error: unknown, category: ErrorCategory = ErrorCategory.UNKNOWN): AppError {
  return errorHandler.handleError(error, category);
}

/**
 * Recovery strategies for different error types
 */
export const RecoveryStrategies = {
  audio: async (): Promise<boolean> => {
    try {
      // Audio recovery logic would go here
      console.log('Audio recovery initiated');
      return true;
    } catch {
      return false;
    }
  },
  
  model: async (): Promise<boolean> => {
    try {
      // Model recovery logic would go here
      console.log('Model recovery initiated');
      return true;
    } catch {
      return false;
    }
  },
  
  sensor: async (): Promise<boolean> => {
    try {
      // Sensor recovery logic would go here
      console.log('Sensor recovery initiated');
      return true;
    } catch {
      return false;
    }
  },
  
  tts: async (): Promise<boolean> => {
    try {
      // TTS recovery logic would go here
      console.log('TTS recovery initiated');
      return true;
    } catch {
      return false;
    }
  },
};
