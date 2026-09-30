import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native', () => {
  const React = require('react');
  return {
    StyleSheet: {
      create: (styles: any) => styles,
    },
    StatusBar: () => null,
    View: ({ children }: any) => React.createElement('View', null, children),
    Text: ({ children }: any) => React.createElement('Text', null, children),
    TouchableOpacity: ({ children, onPress }: any) => React.createElement('TouchableOpacity', { onPress }, children),
    Dimensions: {
      get: () => ({ width: 375, height: 812 }),
    },
    AccessibilityInfo: {
      isScreenReaderEnabled: jest.fn().mockResolvedValue(false),
      addEventListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    },
    Platform: { OS: 'android', select: (obj: any) => obj.android },
    NativeModules: {},
    PermissionsAndroid: {
      request: jest.fn().mockResolvedValue('granted'),
      PERMISSIONS: { RECORD_AUDIO: 'RECORD_AUDIO' },
      RESULTS: { GRANTED: 'granted' },
    },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: any) => children,
  SafeAreaView: ({ children }: any) => children,
}));

jest.mock('../src/components/SonarDashboard', () => {
  const React = require('react');
  return function MockSonarDashboard() {
    return React.createElement('Text', null, 'SonarDashboard');
  };
});

import App from '../App';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
