/**
 * 2D ROOM MAP SPATIAL ANALYZER, VOICE NARRATIVE SYNTHESIZER & VOICE COMMAND PARSER
 * Evaluates the 2D Top-Down SLAM room map, generates context-aware speech guidance based on mapped geometry,
 * and parses spoken voice commands from blind users.
 */

export interface MapObject {
  id: string;
  x: number;          // Cartesian X offset (metres from user)
  y: number;          // Cartesian Y offset (metres from user)
  range: number;      // Euclidean distance from user (metres)
  bearingDeg: number; // Relative bearing in degrees (-180 to +180, 0 = ahead)
  width: number;      // Object width (metres)
  height: number;     // Object height (metres)
  type: 'obstacle' | 'wall' | 'doorway' | 'clear';
  label: string;      // e.g. "DESK", "BED", "CHAIR", "WALL", "OBSTACLE", "DOORWAY"
  confidence: number; // 0.0 to 1.0
}

export type VoiceCommandAction =
  | { type: 'SWITCH_ROOM_MODE' }
  | { type: 'SWITCH_ROAD_MODE' }
  | { type: 'START_SCAN' }
  | { type: 'STOP_SCAN' }
  | { type: 'DESCRIBE_MAP' }
  | { type: 'FIND_DOORWAY' }
  | { type: 'CLEAR_MAP' }
  | { type: 'OPEN_GOOGLE_MAPS'; destination?: string }
  | { type: 'NAVIGATE_DESTINATION'; destination: string }
  | { type: 'UNKNOWN'; rawText: string };

/**
 * Parses natural spoken phrases from a blind user into deterministic app actions.
 * Supports commands like "Click Room Mode", "Road Mode", "Start Scan", "Stop Scan",
 * "Describe Map", "Where is the door", "Open Google Maps to pharmacy", etc.
 */
export function parseVoiceCommandIntent(spokenText: string): VoiceCommandAction {
  const raw = (spokenText || '').trim();
  const text = raw.toLowerCase();

  if (!text) {
    return { type: 'UNKNOWN', rawText: '' };
  }

  if (text.includes('room mode') || text.includes('indoor') || text.includes('inside')) {
    return { type: 'SWITCH_ROOM_MODE' };
  }

  if (
    text.includes('road mode') ||
    text.includes('outdoor') ||
    text.includes('street mode') ||
    text.includes('sidewalk')
  ) {
    return { type: 'SWITCH_ROAD_MODE' };
  }

  if (text.includes('google map') || text.includes('co-pilot') || text.includes('copilot')) {
    const match = text.match(/(?:to|for)\s+([a-z0-9\s]+)$/i);
    return {
      type: 'OPEN_GOOGLE_MAPS',
      destination: match?.[1]?.trim(),
    };
  }

  if (text.includes('navigate to') || text.includes('walk to') || text.includes('take me to')) {
    const dest = text
      .replace(/.*(?:navigate to|walk to|take me to)\s+/i, '')
      .trim();
    if (dest.length > 0) {
      return { type: 'NAVIGATE_DESTINATION', destination: dest };
    }
  }

  if (text.includes('door') || text.includes('exit') || text.includes('way out')) {
    return { type: 'FIND_DOORWAY' };
  }

  if (
    text.includes('describe') ||
    text.includes('what is around') ||
    text.includes('read map') ||
    text.includes('summary')
  ) {
    return { type: 'DESCRIBE_MAP' };
  }

  if (text.includes('stop scan') || text.includes('pause scan') || text === 'stop') {
    return { type: 'STOP_SCAN' };
  }

  if (
    text.includes('start scan') ||
    text.includes('begin scan') ||
    text.includes('scan room') ||
    text === 'scan'
  ) {
    return { type: 'START_SCAN' };
  }

  if (text.includes('clear map') || text.includes('reset map')) {
    return { type: 'CLEAR_MAP' };
  }

  return { type: 'UNKNOWN', rawText: raw };
}

/**
 * Analyzes the generated 2D room map points and synthesizes a natural spatial spoken summary.
 */
export function generateMapSpeechNarrative(mapObjects: MapObject[]): string {
  if (!mapObjects || mapObjects.length === 0) {
    return 'Room map empty. Tap scan to map your surroundings.';
  }

  // Filter out clear space markers to isolate real physical obstacles
  const obstacles = mapObjects.filter(obj => obj.type !== 'clear');

  if (obstacles.length === 0) {
    return 'Path clear ahead.';
  }

  // 1. Immediate Proximity Warning (< 0.6m)
  const immediateHazard = obstacles.find(obj => obj.range < 0.6);
  if (immediateHazard) {
    const dirStr = getDirectionString(immediateHazard.bearingDeg);
    return `Warning! ${immediateHazard.label} immediately ${dirStr}, ${immediateHazard.range.toFixed(1)} metres.`;
  }

  // 2. Identify nearest mapped features in Spatial Sectors (Ahead, Left, Right)
  const ahead = obstacles
    .filter(obj => Math.abs(obj.bearingDeg) <= 45)
    .sort((a, b) => a.range - b.range)[0];

  const left = obstacles
    .filter(obj => obj.bearingDeg > -135 && obj.bearingDeg < -45)
    .sort((a, b) => a.range - b.range)[0];

  const right = obstacles
    .filter(obj => obj.bearingDeg > 45 && obj.bearingDeg < 135)
    .sort((a, b) => a.range - b.range)[0];

  const doorway = obstacles.find(obj => obj.type === 'doorway');

  // Build natural room map summary
  const parts: string[] = [];

  if (ahead) {
    parts.push(`${ahead.label} ${ahead.range.toFixed(1)} metres ahead`);
  }
  if (left) {
    parts.push(`${left.label} ${left.range.toFixed(1)} metres to your left`);
  }
  if (right) {
    parts.push(`${right.label} ${right.range.toFixed(1)} metres to your right`);
  }
  if (doorway) {
    parts.push(`open doorway ${doorway.range.toFixed(1)} metres away`);
  }

  if (parts.length === 1 && obstacles.length === 1) {
    const obj = obstacles[0];
    return `Room map updated. ${obj.label} detected ${obj.range.toFixed(1)} metres ${getDirectionString(obj.bearingDeg)}.`;
  }

  if (parts.length === 0) {
    const nearest = [...obstacles].sort((a, b) => a.range - b.range)[0];
    return `Room map updated. ${nearest.label} detected ${nearest.range.toFixed(1)} metres away.`;
  }

  return `Room map updated. ${parts.join(', ')}.`;
}

export function getDirectionString(bearingDeg: number): string {
  if (Math.abs(bearingDeg) <= 30) return 'ahead';
  if (bearingDeg < -30 && bearingDeg >= -90) return 'on your left';
  if (bearingDeg > 30 && bearingDeg <= 90) return 'on your right';
  if (bearingDeg < -90) return 'behind to your left';
  return 'behind to your right';
}
