/**
 * Map Analyzer Tests
 * Tests for spatial analysis and speech narrative generation
 */

import { generateMapSpeechNarrative, MapObject } from '../src/utils/map_analyzer';

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
});
