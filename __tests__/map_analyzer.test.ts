/**
 * Map Analyzer, 2D Room SLAM Floorplan, Voice Command & Outdoor Road Navigator Tests
 */

import {
  generateMapSpeechNarrative,
  parseVoiceCommandIntent,
  MapObject,
} from '../src/utils/map_analyzer';
import {
  createInitialRoomSectors,
  updateRoomSectorsWithScan,
  applyUserStepToRoomMap,
  buildRoomFloorplanSummary,
} from '../src/utils/room_navigator';
import {
  checkSidewalkDrift,
  mapIndoorLabelToOutdoorRoadHazard,
} from '../src/utils/outdoor_road_navigator';
import {
  createInitialGroundSlamState,
  projectSlantToGroundPlane,
  updateGroundSlamGrid,
  recordGroundSlamStep,
  computeReturnToStartGuidance,
} from '../src/utils/ground_slam';

describe('Map Analyzer', () => {
  describe('generateMapSpeechNarrative', () => {
    it('should handle empty map', () => {
      const narrative = generateMapSpeechNarrative([]);
      expect(narrative).toContain('empty');
      expect(narrative).toContain('scan');
    });

    it('should handle null input', () => {
      const narrative = generateMapSpeechNarrative(null as any);
      expect(narrative).toContain('empty');
    });

    it('should generate immediate hazard warning', () => {
      const mapObjects: MapObject[] = [
        {
          id: '1',
          x: 0,
          y: 0.5,
          range: 0.4,
          bearingDeg: 0,
          width: 1.0,
          height: 1.0,
          type: 'obstacle',
          label: 'OBSTACLE',
          confidence: 0.9,
        },
      ];
      const narrative = generateMapSpeechNarrative(mapObjects);
      expect(narrative).toContain('Warning');
      expect(narrative).toContain('immediately');
      expect(narrative).toContain('ahead');
    });

    it('should generate spatial sector summary', () => {
      const mapObjects: MapObject[] = [
        {
          id: '1',
          x: 0,
          y: 1.5,
          range: 1.5,
          bearingDeg: 0,
          width: 1.0,
          height: 1.0,
          type: 'wall',
          label: 'WALL',
          confidence: 0.9,
        },
        {
          id: '2',
          x: -1.0,
          y: 1.0,
          range: 1.0,
          bearingDeg: -60,
          width: 0.8,
          height: 0.8,
          type: 'obstacle',
          label: 'DESK',
          confidence: 0.8,
        },
        {
          id: '3',
          x: 1.0,
          y: 1.0,
          range: 1.0,
          bearingDeg: 60,
          width: 0.8,
          height: 0.8,
          type: 'obstacle',
          label: 'DESK',
          confidence: 0.8,
        },
      ];
      const narrative = generateMapSpeechNarrative(mapObjects);
      expect(narrative).toContain('ahead');
      expect(narrative).toContain('left');
      expect(narrative).toContain('right');
    });

    it('should identify doorway', () => {
      const mapObjects: MapObject[] = [
        {
          id: '1',
          x: 0,
          y: 2.0,
          range: 2.0,
          bearingDeg: 0,
          width: 1.0,
          height: 2.0,
          type: 'doorway',
          label: 'DOORWAY',
          confidence: 0.9,
        },
      ];
      const narrative = generateMapSpeechNarrative(mapObjects);
      expect(narrative).toContain('doorway');
    });

    it('should handle single object', () => {
      const mapObjects: MapObject[] = [
        {
          id: '1',
          x: 0,
          y: 1.5,
          range: 1.5,
          bearingDeg: 0,
          width: 1.0,
          height: 1.0,
          type: 'obstacle',
          label: 'OBSTACLE',
          confidence: 0.9,
        },
      ];
      const narrative = generateMapSpeechNarrative(mapObjects);
      expect(narrative).toContain('updated');
      expect(narrative).toContain('detected');
    });
  });

  describe('parseVoiceCommandIntent', () => {
    it('should parse Room Mode and Road Mode commands', () => {
      expect(parseVoiceCommandIntent('Click Room Mode').type).toBe('SWITCH_ROOM_MODE');
      expect(parseVoiceCommandIntent('Road Mode').type).toBe('SWITCH_ROAD_MODE');
    });

    it('should parse Google Maps Co-Pilot and Navigation commands', () => {
      const gmaps = parseVoiceCommandIntent('Open Google Maps to pharmacy');
      expect(gmaps.type).toBe('OPEN_GOOGLE_MAPS');
      const nav = parseVoiceCommandIntent('Navigate to train station');
      expect(nav.type).toBe('NAVIGATE_DESTINATION');
    });

    it('should parse doorway, return to start, and map description commands', () => {
      expect(parseVoiceCommandIntent('Where is the door').type).toBe('FIND_DOORWAY');
      expect(parseVoiceCommandIntent('Return to start').type).toBe('RETURN_TO_START');
      expect(parseVoiceCommandIntent('Describe Map').type).toBe('DESCRIBE_MAP');
    });
  });

  describe('2D Room SLAM & Safe Walking Path Navigator', () => {
    it('should detect doorway gaps between adjacent walls and compute safe walking path', () => {
      let sectors = createInitialRoomSectors();
      // Left wall at -15 deg (1.4m), Right wall at +15 deg (1.4m), Deep gap ahead at 0 deg (3.2m)
      sectors = updateRoomSectorsWithScan(sectors, -15, 1.4, 'WALL', 'wall', 0.9);
      sectors = updateRoomSectorsWithScan(sectors, 15, 1.4, 'WALL', 'wall', 0.9);
      sectors = updateRoomSectorsWithScan(sectors, 0, 3.2, 'CLEAR', 'clear', 0.9);

      const summary = buildRoomFloorplanSummary(sectors, [], 0);
      expect(summary.polygonPoints.length).toBe(24);
      expect(summary.safePath.waypoints.length).toBeGreaterThanOrEqual(2);
      expect(summary.fullRoomSpokenDescription).toContain('2D Room Map');
    });

    it('should shift mapped objects when user takes a step (PDR)', () => {
      const sectors = createInitialRoomSectors();
      const objs: MapObject[] = [
        {
          id: 'desk_1',
          x: 0,
          y: 2.0,
          range: 2.0,
          bearingDeg: 0,
          width: 0.8,
          height: 0.8,
          type: 'obstacle',
          label: 'DESK',
          confidence: 0.9,
        },
      ];
      const { updatedObjects } = applyUserStepToRoomMap(sectors, objs, 0.6, 0);
      expect(updatedObjects[0].y).toBeCloseTo(1.4, 1);
      expect(updatedObjects[0].range).toBeCloseTo(1.4, 1);
    });
  });

  describe('Outdoor Road & Sidewalk Navigator', () => {
    it('should warn when pedestrian drifts more than 28 degrees off sidewalk bearing', () => {
      const drift = checkSidewalkDrift(45, 0);
      expect(drift.isDriftingIntoRoad).toBe(true);
      expect(drift.warningSpeech).toContain('Sidewalk drift alert');
    });

    it('should map indoor reflections into outdoor roadside hazards', () => {
      expect(mapIndoorLabelToOutdoorRoadHazard('WALL', 1.8, 0.8).label).toBe('PARKED VEHICLE');
      expect(mapIndoorLabelToOutdoorRoadHazard('CHAIR', 1.5, 0.25).label).toBe('SIGNPOST / POLE');
    });
  });

  describe('Acoustic Ground-SLAM Engine', () => {
    it('should cancel false floor bounce when phone is tilted down at flat floor', () => {
      // Phone held at 1.2m, tilted down by -30 degrees (-0.5236 rad) -> expected floor hit at 1.2 / sin(30°) = 2.4m
      const proj = projectSlantToGroundPlane(2.38, -0.5236, 'wall', 'WALL', 1.2);
      expect(proj.isFloorBounceCancelled).toBe(true);
      expect(proj.anomaly).toBe('FLAT_GROUND_BOUNCE');
      expect(proj.overrideType).toBe('clear');
    });

    it('should detect ground drop-off / downward stairs when expected floor reflection is missing', () => {
      // Phone tilted down by -35 degrees (-0.61 rad) -> expected floor at ~2.09m, but measured range is 3.1m
      const proj = projectSlantToGroundPlane(3.1, -0.61, 'obstacle', 'OBSTACLE', 1.2);
      expect(proj.anomaly).toBe('GROUND_DROP_OFF');
      expect(proj.overrideLabel).toBe('DROP-OFF / STAIRS');
      expect(proj.hazardSpeech).toContain('drop-off');
    });

    it('should update 2D log-odds occupancy grid and compute return-to-start guidance', () => {
      let slam = createInitialGroundSlamState();
      const proj = projectSlantToGroundPlane(2.5, 0, 'wall', 'WALL', 1.2);
      slam = updateGroundSlamGrid(slam, 0, proj);
      expect(slam.walkableAreaSqM).toBeGreaterThan(0.25);

      slam = recordGroundSlamStep(slam, 0.65, 0);
      slam = recordGroundSlamStep(slam, 0.65, 0);
      expect(slam.breadcrumbs.length).toBe(3);

      const guidance = computeReturnToStartGuidance(slam, 0);
      expect(guidance).toContain('Return to start');
    });
  });
});
