/**
 * 2D ROOM MAP SPATIAL ANALYZER & VOICE NARRATIVE SYNTHESIZER
 * Evaluates the 2D Top-Down SLAM room map and generates context-aware speech guidance based on mapped geometry.
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
  label: string;      // e.g. "DESK", "BED", "WALL", "OBSTACLE", "DOORWAY"
  confidence: number; // 0.0 to 1.0
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
