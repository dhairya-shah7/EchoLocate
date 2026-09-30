import React, { useState, useEffect, useRef } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Dimensions, AccessibilityInfo } from 'react-native';
import Svg, { Circle, Rect, Line, Text as SvgText, G } from 'react-native-svg';
import { useSensorFusion } from '../hooks/use_sensor_fusion';
import Tts from 'react-native-tts';
import { handleError, ErrorCategory, RecoveryStrategies } from '../utils/error_handler';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { useSonarAudio } from '../hooks/use_sonar_audio';
import { useSonarInference, SonarPrediction } from '../hooks/use_sonar_inference';
import { computeSpectrogram, computeEnvelope } from '../utils/dsp_optimized';
import { MapObject, generateMapSpeechNarrative } from '../utils/map_analyzer';
import { getUIConfig, getAudioConfig } from '../config/app_config';

const { width, height } = Dimensions.get('window');
const uiConfig = getUIConfig();
const MAP_CENTER = { x: width / 2, y: height * 0.35 };
const SCALE_FACTOR = uiConfig.mapScaleFactor;

export default function SonarDashboard() {
  const [mapObjects, setMapObjects] = useState<MapObject[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isCalibratingState, setIsCalibratingState] = useState<boolean>(false);
  const [ttsReady, setTtsReady] = useState<boolean>(false);
  const [lastSpeech, setLastSpeech] = useState<string>('Tap anywhere to calibrate and start room scanning.');
  const [isScreenReaderEnabled, setIsScreenReaderEnabled] = useState<boolean>(false);
  
  const isSpeakingRef = useRef<boolean>(false);
  const lastNarrativeTimeRef = useRef<number>(0);
  const lastSpokenTextRef = useRef<string>('');

  const { sensorData, calibrationData, isCalibrating, calibrationProgress, startCalibration } = useSensorFusion();

  // Load ONNX acoustic neural model (with DSP heuristic fallback)
  const { isModelLoading, prediction, error: inferenceError, runInference } = useSonarInference('sonar_model_fusion.onnx');

  const audioConfig = getAudioConfig();
  const { isRecording, isPlaying, error: audioError, triggerPing } = useSonarAudio(audioConfig, async (pcmBuffer) => {
    try {
      // 1. Dual-branch DSP: 1D Cross-Correlation Gated Envelope + 2D Goertzel-DFT Spectrogram
      const spectrogram = computeSpectrogram(pcmBuffer, 64, 64);
      const envelope = computeEnvelope(pcmBuffer, 2000);

      // 2. Multi-Modal Attention Transformer Inference
      await runInference(spectrogram, envelope);
    } catch (err: any) {
      handleError(err, ErrorCategory.UNKNOWN);
    }
  });

  // Continuous SLAM Scan Loop when isScanning is active
  useEffect(() => {
    if (!isScanning || isModelLoading) return;

    triggerPing();
    const interval = setInterval(() => {
      triggerPing();
    }, uiConfig.scanIntervalMs);

    return () => clearInterval(interval);
  }, [isScanning, isModelLoading, triggerPing]);

  // Initialize TTS Engine & Event Listeners
  useEffect(() => {
    let mounted = true;

    const finishSub = Tts.addEventListener('tts-finish', () => {
      isSpeakingRef.current = false;
    });
    const cancelSub = Tts.addEventListener('tts-cancel', () => {
      isSpeakingRef.current = false;
    });

    async function initTts() {
      try {
        await Tts.getInitStatus();
        await Tts.setDefaultLanguage(uiConfig.ttsLanguage || 'en-US');
        await Tts.setDefaultRate(uiConfig.ttsRate || 0.5);
        if (mounted) {
          setTtsReady(true);
        }
      } catch (err: any) {
        if (mounted) {
          handleError(err, ErrorCategory.TTS);
          setTtsReady(false);
          setLastSpeech(`TTS Status: ${err?.message || 'Ready'}`);
          RecoveryStrategies.tts();
        }
      }
    }
    initTts();

    return () => {
      mounted = false;
      finishSub?.remove();
      cancelSub?.remove();
      Tts.stop();
    };
  }, []);

  // Check Accessibility Screen Reader Status
  useEffect(() => {
    const checkScreenReader = async () => {
      const enabled = await AccessibilityInfo.isScreenReaderEnabled();
      setIsScreenReaderEnabled(enabled);
    };
    checkScreenReader();

    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', checkScreenReader);
    return () => subscription?.remove();
  }, []);

  useEffect(() => {
    if (prediction) {
      handleNewPrediction(prediction);
    }
  }, [prediction]);

  /**
   * Non-blocking Queued Speech Engine
   * Prevents audio stutter and truncation when pings run every 500ms
   */
  const speakText = (text: string, isPriority: boolean = false) => {
    if (!text) return;
    setLastSpeech(text);

    // If it's a hazard or immediate user action feedback, interrupt and speak immediately
    if (isPriority) {
      isSpeakingRef.current = true;
      lastSpokenTextRef.current = text;
      Tts.stop();
      Tts.speak(text);
      return;
    }

    // Don't interrupt ongoing speech or repeat exact identical text within 3 seconds
    const now = Date.now();
    if (isSpeakingRef.current) return;
    if (text === lastSpokenTextRef.current && now - lastNarrativeTimeRef.current < 3000) return;

    isSpeakingRef.current = true;
    lastNarrativeTimeRef.current = now;
    lastSpokenTextRef.current = text;
    Tts.speak(text);
  };

  /**
   * Single Unified Button Action (Calibrate + Scan)
   */
  const handleSingleButtonPress = () => {
    ReactNativeHapticFeedback.trigger("impactHeavy", { enableVibrateFallback: true });

    if (isScanning || isCalibratingState) {
      setIsScanning(false);
      setIsCalibratingState(false);
      speakText('Scanning stopped.', true);
    } else {
      setIsCalibratingState(true);
      speakText('Calibrating sensors. Hold device steady.', true);
      
      startCalibration(() => {
        setIsCalibratingState(false);
        setIsScanning(true);
        speakText('Calibration complete. Scanning room in real time.', true);
      });
    }
  };

  const handleNewPrediction = (pred: SonarPrediction) => {
    const theta = sensorData.yaw; // IMU Yaw angle in radians
    const totalAngle = theta + pred.angle; // Fused global orientation angle
    const range = Math.max(0.2, Math.min(4.0, pred.range));

    // Cartesian Coordinates for 2D SLAM Top-Down Map
    const xRel = range * Math.sin(totalAngle);
    const yRel = range * Math.cos(totalAngle);

    // Relative bearing in degrees relative to the user's forward baseline (-180 to +180)
    const bearingDeg = ((totalAngle * 180 / Math.PI + 180) % 360) - 180;

    if (pred.type === 'clear') {
      const clearObj: MapObject = {
        id: `clear_${Date.now()}`,
        x: xRel,
        y: yRel,
        range,
        bearingDeg,
        width: 0.5,
        height: 1.0,
        type: 'clear',
        label: 'CLEAR',
        confidence: pred.confidence,
      };
      const updatedMap = [...mapObjects.filter(o => o.type !== 'clear').slice(-uiConfig.maxMapObjects + 1), clearObj];
      setMapObjects(updatedMap);
      const mapNarrative = generateMapSpeechNarrative(updatedMap);
      speakText(mapNarrative, false);
      return;
    }

    let label = 'OBSTACLE';
    if (pred.type === 'wall') label = 'WALL';
    else if (pred.type === 'doorway') label = 'DOORWAY';
    else if (pred.width > 1.2) label = 'BED';
    else if (pred.width > 0.6) label = 'DESK';

    const newObj: MapObject = {
      id: `obj_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      x: xRel,
      y: yRel,
      range,
      bearingDeg,
      width: Math.max(0.4, pred.width),
      height: Math.max(0.4, pred.height),
      type: pred.type,
      label,
      confidence: pred.confidence,
    };

    const updatedMap = [...mapObjects.filter(o => o.type !== 'clear').slice(-uiConfig.maxMapObjects + 1), newObj];
    setMapObjects(updatedMap);

    // Haptic feedback & immediate priority warning for close proximity hazards
    const isImmediateHazard = range < uiConfig.proximityThreshold;
    if (isImmediateHazard) {
      ReactNativeHapticFeedback.trigger("notificationError", { enableVibrateFallback: true });
    }

    const mapNarrative = generateMapSpeechNarrative(updatedMap);
    speakText(mapNarrative, isImmediateHazard);
  };

  const currentError = inferenceError || audioError;

  return (
    <View style={styles.container}>
      {/* 
        ULTRA-ACCESSIBLE 1-BUTTON INTERFACE FOR BLIND USERS
        The entire screen is a single giant touch button
      */}
      <TouchableOpacity
        style={[
          styles.fullScreenButton,
          isScanning
            ? styles.bgScanning
            : isCalibratingState
            ? styles.bgCalibrating
            : styles.bgIdle,
        ]}
        onPress={handleSingleButtonPress}
        activeOpacity={0.85}
        accessible={true}
        accessibilityRole="button"
        accessibilityLabel={
          isScanning
            ? "Stop scanning"
            : isCalibratingState
            ? "Calibrating sensors, please wait"
            : "Start scanning and calibrate sensors"
        }
        accessibilityHint="Tap anywhere on the screen to toggle active sonar room scanning and sensor calibration"
      >
        {/* Top Accessible Status Info */}
        <View style={styles.headerArea}>
          <Text style={styles.appTitleText}>ECHOLOCATE SONAR</Text>
          <Text style={styles.statusBadgeText}>
            {isScanning ? "🟢 SCANNING & MAPPING" : isCalibratingState ? "🎯 CALIBRATING" : "⚪ IDLE"}
          </Text>
        </View>

        {/* 2D Top-Down Spatial Radar Display */}
        <View style={styles.mapArea}>
          <Svg height={height * 0.45} width={width}>
            {/* Metric Distance Rings */}
            {[1, 2, 3, 4].map(r => (
              <React.Fragment key={`grid_${r}`}>
                <Circle
                  cx={MAP_CENTER.x}
                  cy={MAP_CENTER.y}
                  r={r * SCALE_FACTOR}
                  stroke={isScanning ? "#0284C7" : "#94A3B8"}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  fill="none"
                  opacity={0.6}
                />
                <SvgText
                  x={MAP_CENTER.x + 6}
                  y={MAP_CENTER.y - r * SCALE_FACTOR + 12}
                  fill="#475569"
                  fontSize={10}
                  fontWeight="bold"
                >
                  {`${r}m`}
                </SvgText>
              </React.Fragment>
            ))}

            {/* Crosshair Axes */}
            <Line x1={MAP_CENTER.x} y1={20} x2={MAP_CENTER.x} y2={height * 0.45} stroke="#CBD5E1" strokeWidth={1.5} />
            <Line x1={20} y1={MAP_CENTER.y} x2={width - 20} y2={MAP_CENTER.y} stroke="#CBD5E1" strokeWidth={1.5} />

            {/* Mapped Room Objects */}
            {mapObjects.map((obj) => {
              const svgX = MAP_CENTER.x + obj.x * SCALE_FACTOR;
              const svgY = MAP_CENTER.y - obj.y * SCALE_FACTOR;
              const pxWidth = Math.max(24, obj.width * SCALE_FACTOR);
              const pxHeight = Math.max(24, obj.height * SCALE_FACTOR);

              let strokeColor = '#DC2626';
              let fillColor = 'rgba(220, 38, 38, 0.2)';

              if (obj.type === 'wall') {
                strokeColor = '#334155';
                fillColor = 'rgba(51, 65, 85, 0.2)';
              } else if (obj.type === 'doorway') {
                strokeColor = '#059669';
                fillColor = 'rgba(5, 150, 105, 0.22)';
              } else if (obj.label === 'DESK' || obj.label === 'BED') {
                strokeColor = '#0284C7';
                fillColor = 'rgba(2, 132, 199, 0.22)';
              }

              return (
                <G key={obj.id}>
                  <Rect
                    x={svgX - pxWidth / 2}
                    y={svgY - pxHeight / 2}
                    width={pxWidth}
                    height={pxHeight}
                    stroke={strokeColor}
                    strokeWidth={2}
                    fill={fillColor}
                    rx={6}
                  />
                  <SvgText
                    x={svgX}
                    y={svgY + 4}
                    fill="#0F172A"
                    fontSize={11}
                    fontWeight="900"
                    textAnchor="middle"
                  >
                    {obj.label}
                  </SvgText>
                </G>
              );
            })}

            {/* Device User Center Arrow */}
            <G>
              <Circle cx={MAP_CENTER.x} cy={MAP_CENTER.y} r={10} fill="#0284C7" stroke="#0F172A" strokeWidth={2.5} />
              <Line
                x1={MAP_CENTER.x}
                y1={MAP_CENTER.y}
                x2={MAP_CENTER.x + 22 * Math.sin(sensorData.yaw)}
                y2={MAP_CENTER.y - 22 * Math.cos(sensorData.yaw)}
                stroke="#0284C7"
                strokeWidth={4}
              />
            </G>
          </Svg>
        </View>

        {/* Central Giant Accessible Action Text & Speech Box */}
        <View style={styles.actionContainer}>
          <Text style={styles.giantActionText}>
            {isScanning
              ? "⏹ TAP ANYWHERE TO STOP"
              : isCalibratingState
              ? "🎯 CALIBRATING..."
              : "▶ TAP ANYWHERE TO SCAN"}
          </Text>
          <Text style={styles.actionSubtext}>
            {isScanning
              ? "Mapping room & speaking objects aloud"
              : isCalibratingState
              ? "Hold device steady"
              : "Auto-calibrates & begins sonar voice navigation"}
          </Text>

          {/* Current Speech Output Display */}
          <View style={styles.speechCard}>
            <Text style={styles.speechIcon}>🔊</Text>
            <Text style={styles.speechText} numberOfLines={3}>
              {lastSpeech}
            </Text>
          </View>

          {currentError ? (
            <Text style={styles.errorText} numberOfLines={2}>
              ⚠️ {currentError}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  fullScreenButton: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
    justify: 'space-between',
    alignItems: 'center',
  },
  bgIdle: {
    backgroundColor: '#F8FAFC',
  },
  bgScanning: {
    backgroundColor: '#EFF6FF',
  },
  bgCalibrating: {
    backgroundColor: '#FEFCE8',
  },
  headerArea: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingHorizontal: 8,
  },
  appTitleText: {
    color: '#0284C7',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  statusBadgeText: {
    color: '#0F172A',
    fontSize: 13,
    fontWeight: '700',
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    overflow: 'hidden',
  },
  mapArea: {
    flex: 0.55,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  actionContainer: {
    flex: 0.45,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 8,
  },
  giantActionText: {
    color: '#0F172A',
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 0.5,
    textShadowColor: 'rgba(2, 132, 199, 0.18)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  actionSubtext: {
    color: '#475569',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  speechCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    width: '100%',
    borderWidth: 1.5,
    borderColor: '#0284C7',
    gap: 12,
    elevation: 3,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
  },
  speechIcon: {
    fontSize: 22,
  },
  speechText: {
    flex: 1,
    color: '#1E293B',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
  },
  errorText: {
    color: '#DC2626',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
    textAlign: 'center',
  },
});