import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  TouchableOpacity,
  Text,
  StyleSheet,
  Dimensions,
  AccessibilityInfo,
  NativeModules,
} from 'react-native';
import Svg, {
  Circle,
  Rect,
  Line,
  Polygon,
  Polyline,
  Text as SvgText,
  G,
} from 'react-native-svg';
import { useSensorFusion } from '../hooks/use_sensor_fusion';
import Tts from 'react-native-tts';
import { handleError, ErrorCategory, RecoveryStrategies } from '../utils/error_handler';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { useSonarAudio } from '../hooks/use_sonar_audio';
import { useSonarInference, SonarPrediction } from '../hooks/use_sonar_inference';
import { computeSpectrogram, computeEnvelope } from '../utils/dsp_optimized';
import {
  MapObject,
  generateMapSpeechNarrative,
  parseVoiceCommandIntent,
  getDirectionString,
} from '../utils/map_analyzer';
import {
  PolarSector,
  createInitialRoomSectors,
  updateRoomSectorsWithScan,
  applyUserStepToRoomMap,
  buildRoomFloorplanSummary,
  normalizeAngleDeg,
} from '../utils/room_navigator';
import {
  RoadContext,
  getDeviceGpsFix,
  fetchStreetContextFromGps,
  fetchWalkingRouteToDestination,
  mapIndoorLabelToOutdoorRoadHazard,
  generateOutdoorRoadGuidance,
  launchGoogleMapsCoPilot,
} from '../utils/outdoor_road_navigator';
import {
  GroundSlamState,
  createInitialGroundSlamState,
  projectSlantToGroundPlane,
  updateGroundSlamGrid,
  recordGroundSlamStep,
  getRelativeWalkableCells,
  computeReturnToStartGuidance,
  CELL_SIZE_M,
} from '../utils/ground_slam';
import { getUIConfig, getAudioConfig } from '../config/app_config';

function getLocationAndVoiceModule(): any {
  try {
    return NativeModules?.LocationAndVoice ?? null;
  } catch {
    return null;
  }
}
const { width, height } = Dimensions.get('window');
const uiConfig = getUIConfig();
const SVG_HEIGHT = Math.round(height * 0.38);
const MAP_CENTER = { x: width / 2, y: SVG_HEIGHT * 0.52 };
const SCALE_FACTOR = uiConfig.mapScaleFactor;

export type NavigationMode = 'ROOM' | 'ROAD';

export default function SonarDashboard() {
  const [navMode, setNavMode] = useState<NavigationMode>('ROOM');
  const [mapObjects, setMapObjects] = useState<MapObject[]>([]);
  const [roomSectors, setRoomSectors] = useState<PolarSector[]>(() =>
    createInitialRoomSectors()
  );
  const [groundSlam, setGroundSlam] = useState<GroundSlamState>(() =>
    createInitialGroundSlamState()
  );
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isCalibratingState, setIsCalibratingState] = useState<boolean>(false);
  const [isListeningVoice, setIsListeningVoice] = useState<boolean>(false);
  const [ttsReady, setTtsReady] = useState<boolean>(false);
  const [lastSpeech, setLastSpeech] = useState<string>(
    'Ready. Say or tap "Start Scan", "Room Mode", or "Road Mode".'
  );
  const [isScreenReaderEnabled, setIsScreenReaderEnabled] = useState<boolean>(false);

  const [roadContext, setRoadContext] = useState<RoadContext>({
    streetName: 'Acquiring GPS Sidewalk...',
    neighbourhood: '',
    city: '',
    displayAddress: 'Outdoor Sidewalk Mode',
    lockedSidewalkBearingDeg: null,
    isGoogleMapsCoPilotActive: false,
    activeDestinationName: null,
    nextTurnInstruction: null,
    distanceToNextTurnM: null,
  });

  const isSpeakingRef = useRef<boolean>(false);
  const speechWatchdogRef = useRef<NodeJS.Timeout | null>(null);
  const lastNarrativeTimeRef = useRef<number>(0);
  const lastSpokenTextRef = useRef<string>('');
  const lastUiTapTimeRef = useRef<number>(0);

  interface HazardDebounceState {
    label: string;
    distBin: number;
    isCritical: boolean;
    timestamp: number;
  }
  const lastHazardStateRef = useRef<HazardDebounceState | null>(null);

  // Pedestrian Dead Reckoning step callback shifts the 2D room map & updates Ground-SLAM pose + breadcrumbs
  const handleUserStepDetected = useCallback(
    (stepLengthMeters: number, headingYawRad: number) => {
      const headingDeg = normalizeAngleDeg((headingYawRad * 180) / Math.PI);
      setGroundSlam(prev =>
        recordGroundSlamStep(prev, stepLengthMeters, headingDeg)
      );
      setRoomSectors(prevSectors => {
        const { updatedSectors } = applyUserStepToRoomMap(
          prevSectors,
          [],
          stepLengthMeters,
          headingDeg
        );
        return updatedSectors;
      });
      setMapObjects(prevObjs => {
        const { updatedObjects } = applyUserStepToRoomMap(
          [],
          prevObjs,
          stepLengthMeters,
          headingDeg
        );
        return updatedObjects;
      });
    },
    []
  );

  const { sensorData, isCalibrating, startCalibration } =
    useSensorFusion(handleUserStepDetected);

  // Load ONNX acoustic neural model (fused with physical ToF & multi-echo DSP)
  const {
    isModelLoading,
    prediction,
    error: inferenceError,
    runInference,
  } = useSonarInference('sonar_model_fusion.onnx');

  const audioConfig = getAudioConfig();
  const {
    error: audioError,
    triggerPing,
    pauseForVoiceCommand,
    resumeAfterVoiceCommand,
    stopSonarStream,
  } = useSonarAudio(audioConfig, async pcmBuffer => {
    try {
      const spectrogram = computeSpectrogram(pcmBuffer, 64, 64);
      const envelope = computeEnvelope(pcmBuffer, 2000);
      await runInference(spectrogram, envelope);
    } catch (err: any) {
      handleError(err, ErrorCategory.UNKNOWN);
    }
  });

  // Continuous SLAM Scan Loop when isScanning is active
  useEffect(() => {
    if (!isScanning || isModelLoading || isListeningVoice) return;

    triggerPing();
    const interval = setInterval(() => {
      triggerPing();
    }, uiConfig.scanIntervalMs);

    return () => clearInterval(interval);
  }, [isScanning, isModelLoading, isListeningVoice, triggerPing]);

  // Initialize TTS Engine & Shared Audio Focus Ducking
  useEffect(() => {
    let mounted = true;

    const clearSpeakingFlag = () => {
      isSpeakingRef.current = false;
      if (speechWatchdogRef.current) {
        clearTimeout(speechWatchdogRef.current);
        speechWatchdogRef.current = null;
      }
    };

    const startSub = Tts.addEventListener('tts-start', () => {
      isSpeakingRef.current = true;
    });
    const finishSub = Tts.addEventListener('tts-finish', clearSpeakingFlag);
    const cancelSub = Tts.addEventListener('tts-cancel', clearSpeakingFlag);
    const errorSub = Tts.addEventListener('tts-error', clearSpeakingFlag);

    async function initTts() {
      try {
        const locVoice = getLocationAndVoiceModule();
        if (locVoice?.enableCoPilotAudioMode) {
          locVoice.enableCoPilotAudioMode().catch(() => {});
        }
        await Tts.getInitStatus();
        await Tts.setDefaultLanguage(uiConfig.ttsLanguage || 'en-US');
        await Tts.setDefaultRate(uiConfig.ttsRate || 0.52);
        if (mounted) {
          setTtsReady(true);
        }
      } catch (err: any) {
        if (mounted) {
          handleError(err, ErrorCategory.TTS);
          setTtsReady(false);
          RecoveryStrategies.tts();
        }
      }
    }
    initTts();

    return () => {
      mounted = false;
      clearSpeakingFlag();
      startSub?.remove();
      finishSub?.remove();
      cancelSub?.remove();
      errorSub?.remove();
      Tts.stop();
    };
  }, []);

  // Check Accessibility Screen Reader (TalkBack) Status
  useEffect(() => {
    const checkScreenReader = async () => {
      const enabled = await AccessibilityInfo.isScreenReaderEnabled();
      setIsScreenReaderEnabled(enabled);
    };
    checkScreenReader();

    const subscription = AccessibilityInfo.addEventListener(
      'screenReaderChanged',
      checkScreenReader
    );
    return () => subscription?.remove();
  }, []);

  /**
   * TalkBack-Safe Speech Arbiter with Watchdog Timer:
   * - Never collides with Android TalkBack when a user taps a button (450ms grace window).
   * - Includes a 3.5-second watchdog timer so `isSpeakingRef` can never stay stuck `true`.
   */
  const speakText = useCallback(
    (text: string, isPriority: boolean = false, fromButtonTap: boolean = false) => {
      if (!text) return;
      setLastSpeech(text);

      const now = Date.now();
      if (fromButtonTap) {
        lastUiTapTimeRef.current = now;
      }

      const armWatchdog = () => {
        if (speechWatchdogRef.current) {
          clearTimeout(speechWatchdogRef.current);
        }
        speechWatchdogRef.current = setTimeout(() => {
          isSpeakingRef.current = false;
        }, 3500);
      };

      // If TalkBack is active and the user just tapped a button, delay 450ms so TalkBack's
      // native button announcement finishes without two voices colliding.
      const timeSinceTap = now - lastUiTapTimeRef.current;
      if (isScreenReaderEnabled && (fromButtonTap || timeSinceTap < 450) && !isPriority) {
        setTimeout(() => {
          AccessibilityInfo.announceForAccessibility(text);
        }, 420);
        return;
      }

      if (isPriority) {
        isSpeakingRef.current = true;
        lastSpokenTextRef.current = text;
        lastNarrativeTimeRef.current = now;
        armWatchdog();
        try {
          Tts.stop();
          Tts.speak(text);
        } catch {
          AccessibilityInfo.announceForAccessibility(text);
        }
        return;
      }

      if (isSpeakingRef.current) return;
      if (
        text === lastSpokenTextRef.current &&
        now - lastNarrativeTimeRef.current < 3200
      ) {
        return;
      }

      isSpeakingRef.current = true;
      lastNarrativeTimeRef.current = now;
      lastSpokenTextRef.current = text;
      armWatchdog();
      try {
        Tts.speak(text);
      } catch {
        AccessibilityInfo.announceForAccessibility(text);
      }
    },
    [isScreenReaderEnabled]
  );

  /**
   * Conversational Hazard Dispatcher with Cooldown Hysteresis:
   * 1. Guarantees sentence completion - never cuts off TTS mid-word.
   * 2. Enforces a 2.8-second repeat cooldown for stationary obstacles.
   * 3. Reserves immediate interruption strictly for life-safety emergencies (< 0.35m or drop-off).
   */
  const dispatchHazardAlert = useCallback(
    (
      instructionText: string,
      obstacleLabel: string,
      rangeM: number,
      isLifeThreatening: boolean = false
    ) => {
      const now = Date.now();
      const distBin = Math.round(rangeM * 4) / 4; // Quantize to 0.25m bins
      const prev = lastHazardStateRef.current;
      const isCriticalProximity = rangeM < 0.35 || isLifeThreatening;

      // 1. If TTS is actively speaking:
      if (isSpeakingRef.current) {
        // Only interrupt ongoing sentence if it's a critical new crash risk (< 0.35m or drop-off)
        // that wasn't already announced in critical mode
        if (isCriticalProximity && (!prev || !prev.isCritical)) {
          lastHazardStateRef.current = {
            label: obstacleLabel,
            distBin,
            isCritical: true,
            timestamp: now,
          };
          speakText(instructionText, true, false);
        }
        // Otherwise, allow the active sentence to finish completely without mid-word cutoffs!
        return;
      }

      // 2. If TTS is idle, enforce a 2.8-second repeat cooldown for the same obstacle & distance bin
      if (
        prev &&
        prev.label === obstacleLabel &&
        Math.abs(prev.distBin - distBin) <= 0.25 &&
        now - prev.timestamp < 2800 &&
        !isCriticalProximity
      ) {
        return; // Suppress repeat within cooldown
      }

      lastHazardStateRef.current = {
        label: obstacleLabel,
        distBin,
        isCritical: isCriticalProximity,
        timestamp: now,
      };

      // Speak smoothly without aggressive cancellation
      speakText(instructionText, isCriticalProximity, false);
    },
    [speakText]
  );

  // Refresh outdoor GPS & street name when switching to ROAD mode
  const refreshOutdoorGpsContext = useCallback(
    async (lockHeadingDeg: number) => {
      const gps = await getDeviceGpsFix();
      if (gps) {
        const streetInfo = await fetchStreetContextFromGps(
          gps.latitude,
          gps.longitude
        );
        setRoadContext(prev => ({
          ...prev,
          streetName: streetInfo.streetName,
          neighbourhood: streetInfo.neighbourhood,
          city: streetInfo.city,
          displayAddress: [streetInfo.streetName, streetInfo.neighbourhood]
            .filter(Boolean)
            .join(', '),
          lockedSidewalkBearingDeg: lockHeadingDeg,
        }));
        speakText(streetInfo.summarySpeech, true, false);
      } else {
        setRoadContext(prev => ({
          ...prev,
          streetName: 'Sidewalk Alignment Locked',
          lockedSidewalkBearingDeg: lockHeadingDeg,
        }));
        speakText(
          'Road Mode active. Sidewalk heading locked. Ultrasonic hazard shield protecting ahead.',
          true,
          false
        );
      }
    },
    [speakText]
  );

  // Switch to Indoor Room Mode
  const handleSelectRoomMode = useCallback(() => {
    ReactNativeHapticFeedback.trigger('impactMedium', {
      enableVibrateFallback: true,
    });
    setNavMode('ROOM');
    speakText(
      'Room Mode active. 2D indoor floorplan, furniture, doorway, and safe walking path enabled.',
      true,
      true
    );
  }, [speakText]);

  // Switch to Outdoor Road Mode
  const handleSelectRoadMode = useCallback(() => {
    ReactNativeHapticFeedback.trigger('impactMedium', {
      enableVibrateFallback: true,
    });
    setNavMode('ROAD');
    const headingDeg = normalizeAngleDeg((sensorData.yaw * 180) / Math.PI);
    refreshOutdoorGpsContext(headingDeg);
  }, [sensorData.yaw, refreshOutdoorGpsContext]);

  // Toggle Scan + Calibration
  const handleToggleScan = useCallback(() => {
    ReactNativeHapticFeedback.trigger('impactHeavy', {
      enableVibrateFallback: true,
    });

    if (isScanning || isCalibratingState) {
      setIsScanning(false);
      setIsCalibratingState(false);
      lastHazardStateRef.current = null;
      stopSonarStream();
      speakText('Scanning stopped.', true, true);
    } else {
      setIsCalibratingState(true);
      speakText('Calibrating sensors. Hold phone steady.', true, true);

      startCalibration(() => {
        setIsCalibratingState(false);
        setIsScanning(true);
        const modeMsg =
          navMode === 'ROOM'
            ? 'Calibration complete. Mapping 2D room floorplan and safe walking path.'
            : 'Calibration complete. Scanning sidewalk and road obstacles.';
        speakText(modeMsg, true, false);
      });
    }
  }, [
    isScanning,
    isCalibratingState,
    navMode,
    startCalibration,
    stopSonarStream,
    speakText,
  ]);

  // Speak full 2D Floorplan + Ground-SLAM Walkable Area or Road Summary on demand
  const handleDescribeMap = useCallback(() => {
    ReactNativeHapticFeedback.trigger('impactLight', {
      enableVibrateFallback: true,
    });
    const headingDeg = normalizeAngleDeg((sensorData.yaw * 180) / Math.PI);

    if (navMode === 'ROOM') {
      const floorplan = buildRoomFloorplanSummary(
        roomSectors,
        mapObjects,
        headingDeg
      );
      speakText(
        `Ground SLAM verified ${groundSlam.walkableAreaSqM} square metres of walkable floor. ${floorplan.fullRoomSpokenDescription}`,
        true,
        true
      );
    } else {
      const roadSpeech = generateOutdoorRoadGuidance(
        mapObjects,
        headingDeg,
        roadContext
      );
      speakText(
        `Ground SLAM verified ${groundSlam.walkableAreaSqM} square metres of safe sidewalk. ${roadSpeech}`,
        true,
        true
      );
    }
  }, [
    navMode,
    roomSectors,
    mapObjects,
    sensorData.yaw,
    roadContext,
    groundSlam.walkableAreaSqM,
    speakText,
  ]);

  // Launch Google Maps Walking Co-Pilot
  const handleLaunchGoogleMaps = useCallback(
    async (customDestination?: string) => {
      ReactNativeHapticFeedback.trigger('impactMedium', {
        enableVibrateFallback: true,
      });
      setNavMode('ROAD');
      setRoadContext(prev => ({
        ...prev,
        isGoogleMapsCoPilotActive: true,
        activeDestinationName: customDestination || prev.activeDestinationName,
      }));

      const destLabel =
        customDestination || roadContext.activeDestinationName || 'walking route';
      speakText(
        `Launching Google Maps Co-Pilot for ${destLabel}. EchoLocate ultrasonic obstacle shield remains active.`,
        true,
        true
      );
      await launchGoogleMapsCoPilot(
        customDestination || roadContext.activeDestinationName || undefined
      );
    },
    [roadContext.activeDestinationName, speakText]
  );

  // Handle Native Voice Commands ("Room Mode", "Road Mode", "Start Scan", "Where is the door", "Return to start", etc.)
  const handleVoiceCommandPress = useCallback(async () => {
    if (isListeningVoice) return;
    ReactNativeHapticFeedback.trigger('impactMedium', {
      enableVibrateFallback: true,
    });

    pauseForVoiceCommand();
    setIsListeningVoice(true);
    Tts.stop();

    try {
      const locVoice = getLocationAndVoiceModule();
      if (!locVoice?.listenVoiceCommand) {
        setIsListeningVoice(false);
        resumeAfterVoiceCommand();
        speakText(
          'Voice recognizer ready. Use buttons or Voice Access to trigger Room Mode, Road Mode, or Describe Map.',
          true,
          true
        );
        return;
      }

      const spokenText: string = await locVoice.listenVoiceCommand();
      setIsListeningVoice(false);
      resumeAfterVoiceCommand();

      const action = parseVoiceCommandIntent(spokenText);
      const headingDeg = normalizeAngleDeg((sensorData.yaw * 180) / Math.PI);

      switch (action.type) {
        case 'SWITCH_ROOM_MODE':
          handleSelectRoomMode();
          break;
        case 'SWITCH_ROAD_MODE':
          handleSelectRoadMode();
          break;
        case 'START_SCAN':
          if (!isScanning) handleToggleScan();
          else speakText('Already scanning.', true, false);
          break;
        case 'STOP_SCAN':
          if (isScanning) handleToggleScan();
          else speakText('Scanning is already stopped.', true, false);
          break;
        case 'DESCRIBE_MAP':
          handleDescribeMap();
          break;
        case 'RETURN_TO_START': {
          const returnSpeech = computeReturnToStartGuidance(
            groundSlam,
            headingDeg
          );
          speakText(returnSpeech, true, false);
          break;
        }
        case 'FIND_DOORWAY': {
          const floorplan = buildRoomFloorplanSummary(
            roomSectors,
            mapObjects,
            headingDeg
          );
          if (floorplan.doorways.length > 0) {
            const d = floorplan.doorways[0];
            const rel = normalizeAngleDeg(d.bearingDeg - headingDeg);
            speakText(
              `Doorway detected ${d.range.toFixed(1)} metres ${getDirectionString(
                rel
              )}. ${floorplan.safePath.spokenInstruction}`,
              true,
              false
            );
          } else {
            speakText(
              `No doorway mapped yet. Rotate phone slowly left and right to scan walls for doorway openings.`,
              true,
              false
            );
          }
          break;
        }
        case 'CLEAR_MAP':
          setMapObjects([]);
          setRoomSectors(createInitialRoomSectors());
          setGroundSlam(createInitialGroundSlamState());
          lastHazardStateRef.current = null;
          speakText('2D Ground SLAM map cleared.', true, false);
          break;
        case 'OPEN_GOOGLE_MAPS':
          await handleLaunchGoogleMaps(action.destination);
          break;
        case 'NAVIGATE_DESTINATION': {
          setNavMode('ROAD');
          speakText(
            `Calculating sidewalk walking route to ${action.destination}.`,
            true,
            false
          );
          const gps = await getDeviceGpsFix();
          if (gps) {
            const route = await fetchWalkingRouteToDestination(
              gps.latitude,
              gps.longitude,
              action.destination
            );
            if (route) {
              setRoadContext(prev => ({
                ...prev,
                activeDestinationName: route.destinationName,
                nextTurnInstruction: route.firstInstruction,
                distanceToNextTurnM: route.totalDistanceM,
                lockedSidewalkBearingDeg: route.initialBearingDeg,
              }));
              speakText(route.firstInstruction, true, false);
            } else {
              await handleLaunchGoogleMaps(action.destination);
            }
          } else {
            await handleLaunchGoogleMaps(action.destination);
          }
          break;
        }
        default:
          speakText(
            `Heard "${action.rawText}". Say Room Mode, Road Mode, Start Scan, Stop Scan, Describe Map, Return to Start, or Google Maps.`,
            true,
            false
          );
          break;
      }
    } catch {
      setIsListeningVoice(false);
      resumeAfterVoiceCommand();
      speakText(
        'Did not catch that voice command. Tap Voice Command and speak again.',
        true,
        false
      );
    }
  }, [
    isListeningVoice,
    isScanning,
    sensorData.yaw,
    roomSectors,
    mapObjects,
    groundSlam,
    pauseForVoiceCommand,
    resumeAfterVoiceCommand,
    handleSelectRoomMode,
    handleSelectRoadMode,
    handleToggleScan,
    handleDescribeMap,
    handleLaunchGoogleMaps,
    speakText,
  ]);

  // Process incoming hybrid ONNX + Physical ToF Sonar Predictions with Ground-SLAM Projection
  useEffect(() => {
    if (!prediction) return;

    const theta = sensorData.yaw; // IMU Yaw angle in radians
    const pitch = sensorData.pitch; // IMU Pitch angle in radians
    const totalAngle = theta + prediction.angle;
    const rawSlantRange = Math.max(0.25, Math.min(4.0, prediction.range));
    const bearingDeg = Math.round(
      normalizeAngleDeg((totalAngle * 180) / Math.PI)
    );
    const userHeadingDeg = normalizeAngleDeg((theta * 180) / Math.PI);

    // Determine initial indoor vs outdoor semantic classification
    let label: string = prediction.semanticLabel || 'OBSTACLE';
    let objType: 'obstacle' | 'wall' | 'doorway' | 'clear' = prediction.type;

    if (navMode === 'ROAD') {
      const roadMapped = mapIndoorLabelToOutdoorRoadHazard(
        label,
        rawSlantRange,
        prediction.pulseWidthMeters || prediction.width
      );
      label = roadMapped.label;
      objType = roadMapped.type;
    } else {
      if (prediction.type === 'wall') label = 'WALL';
      else if (prediction.type === 'doorway') label = 'DOORWAY';
      else if (prediction.semanticLabel) label = prediction.semanticLabel;
      else if (prediction.width > 1.2) label = 'BED';
      else if (prediction.width > 0.65) label = 'DESK';
      else label = 'CHAIR';
    }

    // 1. Ground-SLAM Tilt Projection, Floor Bounce Cancellation & Curb/Drop-Off Detection
    const groundProj = projectSlantToGroundPlane(
      rawSlantRange,
      pitch,
      objType,
      label
    );

    const range = Math.max(0.25, Math.min(4.0, groundProj.horizontalRangeM));
    if (groundProj.overrideLabel) label = groundProj.overrideLabel;
    if (groundProj.overrideType) objType = groundProj.overrideType;

    // 2. Update 2D Log-Odds Occupancy Grid via Bresenham Raycasting
    const updatedGroundSlam = updateGroundSlamGrid(
      groundSlam,
      bearingDeg,
      groundProj
    );
    setGroundSlam(updatedGroundSlam);

    // Cartesian Coordinates for 2D SLAM Top-Down Map (relative to user on horizontal ground plane)
    const xRel = Number((range * Math.sin(totalAngle)).toFixed(2));
    const yRel = Number((range * Math.cos(totalAngle)).toFixed(2));

    // Update 360° 2D Room Boundary Sectors
    const updatedSectors = updateRoomSectorsWithScan(
      roomSectors,
      bearingDeg,
      range,
      label,
      objType,
      prediction.confidence
    );
    setRoomSectors(updatedSectors);

    // Deduplicate nearby objects in the same angular sector so the 2D map stays crisp
    const filteredPrev = mapObjects
      .filter(o => o.type !== 'clear')
      .filter(o => Math.abs(normalizeAngleDeg(o.bearingDeg - bearingDeg)) > 12);

    const newObj: MapObject = {
      id: `obj_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      x: xRel,
      y: yRel,
      range,
      bearingDeg,
      width: Math.max(0.35, prediction.width),
      height: Math.max(0.35, prediction.height),
      type: objType,
      label,
      confidence: prediction.confidence,
    };

    const updatedMap =
      objType === 'clear'
        ? [...filteredPrev.slice(-uiConfig.maxMapObjects + 1)]
        : [...filteredPrev.slice(-uiConfig.maxMapObjects + 1), newObj];

    setMapObjects(updatedMap);

    // Immediate haptic warning for close obstacles, curbs, or ground drop-offs
    const isGroundHazard =
      groundProj.anomaly === 'CURB_STEP_UP' ||
      groundProj.anomaly === 'GROUND_DROP_OFF';
    const isImmediateHazard =
      isGroundHazard ||
      (objType !== 'clear' && range < uiConfig.proximityThreshold);

    if (isImmediateHazard) {
      ReactNativeHapticFeedback.trigger('notificationError', {
        enableVibrateFallback: true,
      });
    }

    if (isGroundHazard && groundProj.hazardSpeech) {
      dispatchHazardAlert(
        groundProj.hazardSpeech,
        groundProj.overrideLabel || 'GROUND_HAZARD',
        range,
        groundProj.anomaly === 'GROUND_DROP_OFF'
      );
      return;
    }

    if (navMode === 'ROOM') {
      const floorplan = buildRoomFloorplanSummary(
        updatedSectors,
        updatedMap,
        userHeadingDeg
      );
      if (isImmediateHazard) {
        dispatchHazardAlert(
          floorplan.safePath.spokenInstruction,
          label,
          range,
          range < 0.35
        );
      } else {
        const baseNarrative = generateMapSpeechNarrative(updatedMap);
        speakText(
          `${baseNarrative} ${floorplan.safePath.spokenInstruction}`,
          false,
          false
        );
      }
    } else {
      const roadGuidance = generateOutdoorRoadGuidance(
        updatedMap,
        userHeadingDeg,
        roadContext
      );
      if (isImmediateHazard) {
        dispatchHazardAlert(
          roadGuidance,
          label,
          range,
          range < 0.35
        );
      } else {
        speakText(roadGuidance, false, false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prediction]);

  const userHeadingDeg = normalizeAngleDeg((sensorData.yaw * 180) / Math.PI);
  const floorplanSummary = buildRoomFloorplanSummary(
    roomSectors,
    mapObjects,
    userHeadingDeg
  );
  const walkableCells = getRelativeWalkableCells(groundSlam, 80);

  // Convert Ground-SLAM walked breadcrumb trajectory into SVG polyline points
  const breadcrumbSvgPoints = groundSlam.breadcrumbs
    .map(b => {
      const relX = b.x - groundSlam.userWorldX;
      const relY = b.y - groundSlam.userWorldY;
      return `${(MAP_CENTER.x + relX * SCALE_FACTOR).toFixed(1)},${(
        MAP_CENTER.y -
        relY * SCALE_FACTOR
      ).toFixed(1)}`;
    })
    .join(' ');

  // Convert 2D room boundary polygon vertices into SVG coordinate string
  const roomPolygonSvgPoints = floorplanSummary.polygonPoints
    .map(
      pt =>
        `${(MAP_CENTER.x + pt.x * SCALE_FACTOR).toFixed(1)},${(
          MAP_CENTER.y -
          pt.y * SCALE_FACTOR
        ).toFixed(1)}`
    )
    .join(' ');

  // Convert Safe Walking Path waypoints into SVG polyline string
  const safePathSvgPoints = floorplanSummary.safePath.waypoints
    .map(
      pt =>
        `${(MAP_CENTER.x + pt.x * SCALE_FACTOR).toFixed(1)},${(
          MAP_CENTER.y -
          pt.y * SCALE_FACTOR
        ).toFixed(1)}`
    )
    .join(' ');

  const currentError = inferenceError || audioError;

  return (
    <View style={styles.container}>
      {/* TOP MODE SELECTOR BAR: Flat top-level buttons for TalkBack & Android Voice Access */}
      <View style={styles.topModeBar}>
        <TouchableOpacity
          style={[
            styles.modeTabButton,
            navMode === 'ROOM' && styles.modeTabButtonActive,
          ]}
          onPress={handleSelectRoomMode}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Room Mode"
          accessibilityState={{ selected: navMode === 'ROOM' }}
          accessibilityHint="Switches to indoor 2D room floorplan mapping, doorway detection, and safe walking path"
        >
          <Text
            style={[
              styles.modeTabText,
              navMode === 'ROOM' && styles.modeTabTextActive,
            ]}
          >
            🏠 ROOM MODE
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.modeTabButton,
            navMode === 'ROAD' && styles.modeTabButtonActive,
          ]}
          onPress={handleSelectRoadMode}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Road Mode"
          accessibilityState={{ selected: navMode === 'ROAD' }}
          accessibilityHint="Switches to outdoor GPS sidewalk tracking, roadside hazard avoidance, and Google Maps Co-Pilot"
        >
          <Text
            style={[
              styles.modeTabText,
              navMode === 'ROAD' && styles.modeTabTextActive,
            ]}
          >
            🛣️ ROAD MODE
          </Text>
        </TouchableOpacity>
      </View>

      {/* LIVE TELEMETRY & GROUND-SLAM METADATA SUB-BAR */}
      <View style={styles.telemetryBar} importantForAccessibility="no-hide-descendants">
        <Text style={styles.telemetryTitle} numberOfLines={1}>
          {navMode === 'ROOM'
            ? `📐 Ground-SLAM: ${floorplanSummary.roomWidthM}m×${floorplanSummary.roomDepthM}m (${groundSlam.walkableAreaSqM}m² Free)`
            : `📍 ${roadContext.streetName} (${groundSlam.walkableAreaSqM}m² Clear)`}
        </Text>
        <Text style={styles.telemetryPill}>
          {`👣 ${sensorData.stepCount || 0} steps • ${Math.round(userHeadingDeg)}°`}
        </Text>
      </View>

      {/* 2D GROUND-SLAM OCCUPANCY GRID & SAFE WALKING PATH VISUALIZER */}
      <View
        style={styles.mapArea}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <Svg height={SVG_HEIGHT} width={width}>
          {/* Metric Distance Rings (1m, 2m, 3m, 4m) */}
          {[1, 2, 3, 4].map(r => (
            <React.Fragment key={`grid_${r}`}>
              <Circle
                cx={MAP_CENTER.x}
                cy={MAP_CENTER.y}
                r={r * SCALE_FACTOR}
                stroke={isScanning ? '#0284C7' : '#CBD5E1'}
                strokeWidth={1.2}
                strokeDasharray="4 4"
                fill="none"
                opacity={0.55}
              />
              <SvgText
                x={MAP_CENTER.x + 5}
                y={MAP_CENTER.y - r * SCALE_FACTOR + 11}
                fill="#475569"
                fontSize={10}
                fontWeight="bold"
              >
                {`${r}m`}
              </SvgText>
            </React.Fragment>
          ))}

          {/* Mode-Specific 2D Geometry Layer */}
          {navMode === 'ROOM' ? (
            <Polygon
              points={roomPolygonSvgPoints}
              fill="rgba(2, 132, 199, 0.08)"
              stroke="#0284C7"
              strokeWidth={2.5}
            />
          ) : (
            /* Outdoor Sidewalk Corridor Boundary Lines */
            <G>
              <Rect
                x={MAP_CENTER.x - 1.3 * SCALE_FACTOR}
                y={12}
                width={2.6 * SCALE_FACTOR}
                height={SVG_HEIGHT - 24}
                fill="rgba(16, 185, 129, 0.08)"
                stroke="#059669"
                strokeWidth={2}
                strokeDasharray="6 4"
                rx={8}
              />
              <SvgText
                x={MAP_CENTER.x}
                y={28}
                fill="#047857"
                fontSize={11}
                fontWeight="900"
                textAnchor="middle"
              >
                SIDEWALK SAFE CORRIDOR
              </SvgText>
            </G>
          )}

          {/* Ground-SLAM Verified Walkable Ground Occupancy Cells */}
          {walkableCells.map(cell => {
            const cellPx = Math.max(8, CELL_SIZE_M * SCALE_FACTOR);
            const cx = MAP_CENTER.x + cell.relX * SCALE_FACTOR - cellPx / 2;
            const cy = MAP_CENTER.y - cell.relY * SCALE_FACTOR - cellPx / 2;
            return (
              <Rect
                key={cell.id}
                x={cx}
                y={cy}
                width={cellPx}
                height={cellPx}
                fill="rgba(16, 185, 129, 0.18)"
                rx={2}
              />
            );
          })}

          {/* Crosshair Axes */}
          <Line
            x1={MAP_CENTER.x}
            y1={14}
            x2={MAP_CENTER.x}
            y2={SVG_HEIGHT - 14}
            stroke="#CBD5E1"
            strokeWidth={1.2}
          />
          <Line
            x1={20}
            y1={MAP_CENTER.y}
            x2={width - 20}
            y2={MAP_CENTER.y}
            stroke="#CBD5E1"
            strokeWidth={1.2}
          />

          {/* Ground-SLAM Walked Breadcrumb Trail */}
          {groundSlam.breadcrumbs.length >= 2 && (
            <Polyline
              points={breadcrumbSvgPoints}
              fill="none"
              stroke="#0284C7"
              strokeWidth={2.5}
              strokeDasharray="3 3"
            />
          )}

          {/* Green Safe Walking Path Polyline + Target Beacon */}
          {floorplanSummary.safePath.waypoints.length >= 2 && (
            <G>
              <Polyline
                points={safePathSvgPoints}
                fill="none"
                stroke={
                  floorplanSummary.safePath.isSafeToWalk ? '#059669' : '#D97706'
                }
                strokeWidth={4.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {(() => {
                const lastWp =
                  floorplanSummary.safePath.waypoints[
                    floorplanSummary.safePath.waypoints.length - 1
                  ];
                const targetX = MAP_CENTER.x + lastWp.x * SCALE_FACTOR;
                const targetY = MAP_CENTER.y - lastWp.y * SCALE_FACTOR;
                return (
                  <Circle
                    cx={targetX}
                    cy={targetY}
                    r={7}
                    fill="#10B981"
                    stroke="#064E3B"
                    strokeWidth={2}
                  />
                );
              })()}
            </G>
          )}

          {/* Mapped Room Furniture, Walls, Doorways & Outdoor Roadside Objects */}
          {mapObjects.map(obj => {
            const svgX = MAP_CENTER.x + obj.x * SCALE_FACTOR;
            const svgY = MAP_CENTER.y - obj.y * SCALE_FACTOR;
            const pxWidth = Math.max(26, obj.width * SCALE_FACTOR);
            const pxHeight = Math.max(22, obj.height * SCALE_FACTOR);

            let strokeColor = '#DC2626';
            let fillColor = 'rgba(220, 38, 38, 0.22)';

            if (obj.type === 'wall') {
              strokeColor = '#334155';
              fillColor = 'rgba(51, 65, 85, 0.24)';
            } else if (obj.type === 'doorway') {
              strokeColor = '#059669';
              fillColor = 'rgba(5, 150, 105, 0.28)';
            } else if (
              obj.label === 'DESK' ||
              obj.label === 'BED' ||
              obj.label === 'CHAIR'
            ) {
              strokeColor = '#0284C7';
              fillColor = 'rgba(2, 132, 199, 0.24)';
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
                  fontSize={10}
                  fontWeight="900"
                  textAnchor="middle"
                >
                  {`${obj.label} (${obj.range.toFixed(1)}m)`}
                </SvgText>
              </G>
            );
          })}

          {/* Blind User Position & Heading Indicator at Map Center */}
          <G>
            <Circle
              cx={MAP_CENTER.x}
              cy={MAP_CENTER.y}
              r={10}
              fill="#0284C7"
              stroke="#0F172A"
              strokeWidth={2.5}
            />
            <Line
              x1={MAP_CENTER.x}
              y1={MAP_CENTER.y}
              x2={MAP_CENTER.x + 24 * Math.sin(sensorData.yaw)}
              y2={MAP_CENTER.y - 24 * Math.cos(sensorData.yaw)}
              stroke="#0F172A"
              strokeWidth={3.5}
            />
          </G>
        </Svg>
      </View>

      {/* SPOKEN SAFE WALKING GUIDANCE CARD */}
      <View style={styles.speechCard}>
        <Text style={styles.speechIcon}>🔊</Text>
        <View style={styles.speechTextWrap}>
          <Text style={styles.speechModeBadge}>
            {navMode === 'ROOM'
              ? `SAFE WALKING PATH (${floorplanSummary.safePath.targetType.replace(
                  '_',
                  ' '
                )})`
              : roadContext.isGoogleMapsCoPilotActive
              ? 'GOOGLE MAPS CO-PILOT + ULTRASONIC SHIELD'
              : 'SIDEWALK & ROADSIDE NAVIGATION'}
          </Text>
          <Text style={styles.speechText} numberOfLines={3}>
            {lastSpeech}
          </Text>
        </View>
      </View>

      {/* VOICE-COMMANDABLE QUICK ACTION ROW ("Voice Command", "Describe Map", "Google Maps") */}
      <View style={styles.quickActionRow}>
        <TouchableOpacity
          style={[
            styles.quickActionButton,
            isListeningVoice && styles.quickActionButtonActive,
          ]}
          onPress={handleVoiceCommandPress}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Voice Command"
          accessibilityHint="Listens for spoken commands like Room Mode, Road Mode, Start Scan, Where is the door, or Navigate to destination"
        >
          <Text style={styles.quickActionTitle}>
            {isListeningVoice ? '🎙️ LISTENING...' : '🎙️ VOICE COMMAND'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.quickActionButton}
          onPress={handleDescribeMap}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Describe Map"
          accessibilityHint="Speaks the full 2D room floorplan, detected objects, doorways, and safe walking path"
        >
          <Text style={styles.quickActionTitle}>🗺️ DESCRIBE MAP</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.quickActionButton,
            roadContext.isGoogleMapsCoPilotActive &&
              styles.quickActionButtonMapsActive,
          ]}
          onPress={() => handleLaunchGoogleMaps()}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Google Maps"
          accessibilityHint="Launches Google Maps turn-by-turn walking navigation while keeping EchoLocate obstacle detection running in Co-Pilot mode"
        >
          <Text style={styles.quickActionTitle}>🧭 GOOGLE MAPS</Text>
        </TouchableOpacity>
      </View>

      {/* PRIMARY GIANT START / STOP SCAN BUTTON */}
      <TouchableOpacity
        style={[
          styles.primaryScanButton,
          isScanning
            ? styles.primaryScanButtonActive
            : isCalibrating || isCalibratingState
            ? styles.primaryScanButtonCalibrating
            : styles.primaryScanButtonIdle,
        ]}
        onPress={handleToggleScan}
        activeOpacity={0.85}
        accessible={true}
        accessibilityRole="button"
        accessibilityLabel={isScanning ? 'Stop Scan' : 'Start Scan'}
        accessibilityHint="Toggles real-time ultrasonic sonar scanning and sensor calibration"
      >
        <Text style={styles.primaryScanButtonText}>
          {isScanning
            ? '⏹ STOP SCAN'
            : isCalibrating || isCalibratingState
            ? '🎯 CALIBRATING...'
            : '▶ START SCAN'}
        </Text>
        <Text style={styles.primaryScanSubtext}>
          {isScanning
            ? navMode === 'ROOM'
              ? 'Mapping 360° 2D Floorplan & Safe Walking Path'
              : 'Scanning Sidewalk & Roadside Obstacles'
            : 'Tap or say "Start Scan"'}
        </Text>
      </TouchableOpacity>

      {currentError ? (
        <Text style={styles.errorText} numberOfLines={1}>
          ⚠️ {currentError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
    justifyContent: 'space-between',
  },
  topModeBar: {
    flexDirection: 'row',
    width: '100%',
    gap: 10,
  },
  modeTabButton: {
    flex: 1,
    backgroundColor: '#E2E8F0',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#CBD5E1',
  },
  modeTabButtonActive: {
    backgroundColor: '#0284C7',
    borderColor: '#0369A1',
  },
  modeTabText: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  modeTabTextActive: {
    color: '#FFFFFF',
  },
  telemetryBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BAE6FD',
  },
  telemetryTitle: {
    flex: 1,
    color: '#0F172A',
    fontSize: 12,
    fontWeight: '800',
    marginRight: 8,
  },
  telemetryPill: {
    color: '#0369A1',
    fontSize: 12,
    fontWeight: '800',
  },
  mapArea: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#CBD5E1',
    overflow: 'hidden',
  },
  speechCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    width: '100%',
    borderWidth: 1.5,
    borderColor: '#0284C7',
    gap: 10,
    elevation: 2,
  },
  speechIcon: {
    fontSize: 22,
  },
  speechTextWrap: {
    flex: 1,
  },
  speechModeBadge: {
    color: '#0284C7',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  speechText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
  },
  quickActionRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 8,
  },
  quickActionButton: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#0284C7',
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickActionButtonActive: {
    backgroundColor: '#FEF08A',
    borderColor: '#CA8A04',
  },
  quickActionButtonMapsActive: {
    backgroundColor: '#D1FAE5',
    borderColor: '#059669',
  },
  quickActionTitle: {
    color: '#0F172A',
    fontSize: 12,
    fontWeight: '900',
    textAlign: 'center',
  },
  primaryScanButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  primaryScanButtonIdle: {
    backgroundColor: '#0284C7',
    borderColor: '#0369A1',
  },
  primaryScanButtonActive: {
    backgroundColor: '#DC2626',
    borderColor: '#991B1B',
  },
  primaryScanButtonCalibrating: {
    backgroundColor: '#EAB308',
    borderColor: '#A16207',
  },
  primaryScanButtonText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  primaryScanSubtext: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  errorText: {
    color: '#DC2626',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
});