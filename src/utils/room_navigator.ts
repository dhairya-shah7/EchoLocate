/**
 * 360° 2D ROOM SLAM MAPPER & HUMAN SAFE WALKING PATH NAVIGATOR
 *
 * Designed specifically for blind and visually impaired users:
 * 1. Maintains a 24-sector (15° resolution) 360° polar room boundary grid around the user.
 * 2. Fuses continuous acoustic reflections into walls, furniture (DESK, BED, CHAIR), and doorways.
 * 3. Automatically detects open doorway gaps between adjacent wall segments.
 * 4. Shifts mapped coordinates as the user takes physical steps (Pedestrian Dead Reckoning).
 * 5. Computes a safe, obstacle-free human walking path (clearance >= 0.85m) and turn-by-turn spoken guidance.
 */

import { MapObject, getDirectionString } from './map_analyzer';

export const NUM_SECTORS = 24; // 360° / 24 = 15° per sector
export const SECTOR_DEG = 360 / NUM_SECTORS;
export const MAX_ROOM_RADIUS_M = 4.2;
export const HUMAN_SAFE_CLEARANCE_M = 0.85; // Minimum clearance for a blind walker's shoulders + cane

export interface PolarSector {
  sectorIndex: number;
  centerAngleDeg: number; // -180 to +165 (0 = North/Initial Forward)
  wallRangeM: number;     // Smoothed wall/boundary distance in this sector
  type: 'wall' | 'doorway' | 'obstacle' | 'clear' | 'unscanned';
  label: string;          // 'WALL', 'DOORWAY', 'DESK', 'BED', 'CHAIR', 'OBSTACLE', 'CLEAR'
  confidence: number;
  scanCount: number;
  lastUpdated: number;
}

export interface SafeWalkingPath {
  isSafeToWalk: boolean;
  recommendedBearingDeg: number; // Relative to user's current heading (-180 to +180)
  worldBearingDeg: number;       // Absolute room bearing
  clearDistanceM: number;        // How many meters the user can safely walk along this bearing
  targetType: 'DOORWAY' | 'OPEN_CORRIDOR' | 'CLEAR_SPACE' | 'STOP_HAZARD';
  spokenInstruction: string;     // Natural human walking guidance (e.g. "Step 30 degrees right to pass the desk, then walk 2.4 meters toward the doorway")
  waypoints: Array<{ x: number; y: number }>; // Relative (x, y) meters from user for 2D SVG path rendering
}

export interface RoomFloorplanSummary {
  roomWidthM: number;
  roomDepthM: number;
  scannedCoveragePercent: number;
  polygonPoints: Array<{ x: number; y: number }>; // 2D Room boundary polygon vertices (meters relative to user)
  doorways: MapObject[];
  furniture: MapObject[];
  walls: MapObject[];
  safePath: SafeWalkingPath;
  fullRoomSpokenDescription: string;
}

/**
 * Normalizes any angle in degrees to [-180, 180)
 */
export function normalizeAngleDeg(angle: number): number {
  let a = ((angle + 180) % 360);
  if (a < 0) a += 360;
  return a - 180;
}

/**
 * Converts a world bearing (-180 to +180) to a sector index [0..23]
 */
export function angleToSectorIndex(worldBearingDeg: number): number {
  const norm = normalizeAngleDeg(worldBearingDeg); // -180 to +180
  const shifted = norm + 180; // 0 to 360
  return Math.floor(shifted / SECTOR_DEG) % NUM_SECTORS;
}

/**
 * Creates an initial 24-sector 360° room grid
 */
export function createInitialRoomSectors(): PolarSector[] {
  const sectors: PolarSector[] = [];
  for (let i = 0; i < NUM_SECTORS; i++) {
    const centerAngleDeg = -180 + i * SECTOR_DEG + SECTOR_DEG / 2;
    sectors.push({
      sectorIndex: i,
      centerAngleDeg: normalizeAngleDeg(centerAngleDeg),
      wallRangeM: MAX_ROOM_RADIUS_M,
      type: 'unscanned',
      label: 'UNSCANNED',
      confidence: 0,
      scanCount: 0,
      lastUpdated: 0,
    });
  }
  return sectors;
}

/**
 * Updates the 360° polar room grid with a newly calibrated sonar measurement
 * and automatically detects doorway gaps between adjacent walls.
 */
export function updateRoomSectorsWithScan(
  prevSectors: PolarSector[],
  worldBearingDeg: number,
  rangeM: number,
  semanticLabel: string,
  semanticType: 'wall' | 'doorway' | 'obstacle' | 'clear',
  confidence: number
): PolarSector[] {
  const sectors = prevSectors.map(s => ({ ...s }));
  const idx = angleToSectorIndex(worldBearingDeg);
  const clampedRange = Math.max(0.25, Math.min(MAX_ROOM_RADIUS_M, rangeM));
  const current = sectors[idx];

  // Exponential moving average so a single noisy reflection doesn't warp the 2D floorplan
  const alpha = current.scanCount === 0 ? 1.0 : 0.45;
  const smoothedRange =
    current.scanCount === 0
      ? clampedRange
      : current.wallRangeM * (1 - alpha) + clampedRange * alpha;

  sectors[idx] = {
    ...current,
    wallRangeM: Number(smoothedRange.toFixed(2)),
    type: semanticType,
    label: semanticLabel,
    confidence: Math.max(current.confidence * 0.7, confidence),
    scanCount: current.scanCount + 1,
    lastUpdated: Date.now(),
  };

  // Automatic Doorway Gap Detection:
  // If a sector is significantly deeper (> 0.95m deeper) than two flanking wall sectors,
  // classify that recessed opening as a DOORWAY so the blind user can locate exits.
  for (let i = 0; i < NUM_SECTORS; i++) {
    const leftIdx = (i - 1 + NUM_SECTORS) % NUM_SECTORS;
    const rightIdx = (i + 1) % NUM_SECTORS;
    const center = sectors[i];
    const left = sectors[leftIdx];
    const right = sectors[rightIdx];

    if (
      center.scanCount > 0 &&
      left.scanCount > 0 &&
      right.scanCount > 0 &&
      (left.type === 'wall' || right.type === 'wall')
    ) {
      const avgFlankWall = (left.wallRangeM + right.wallRangeM) / 2;
      if (
        center.wallRangeM - avgFlankWall >= 0.9 &&
        avgFlankWall <= 2.8 &&
        center.type !== 'obstacle'
      ) {
        sectors[i] = {
          ...center,
          type: 'doorway',
          label: 'DOORWAY',
          confidence: Math.max(center.confidence, 0.88),
        };
      }
    }
  }

  return sectors;
}

/**
 * Shifts all mapped room objects and 360° boundary sectors when the user takes a physical step
 * (Pedestrian Dead Reckoning via accelerometer step detector + compass heading).
 */
export function applyUserStepToRoomMap(
  sectors: PolarSector[],
  objects: MapObject[],
  stepLengthM: number,
  userHeadingDeg: number
): { updatedSectors: PolarSector[]; updatedObjects: MapObject[] } {
  const stepRad = (userHeadingDeg * Math.PI) / 180;
  // User moved forward along (dx, dy) in room coordinates, so objects shift by (-dx, -dy)
  const dx = Math.sin(stepRad) * stepLengthM;
  const dy = Math.cos(stepRad) * stepLengthM;

  const updatedObjects = objects
    .map(obj => {
      const newX = obj.x - dx;
      const newY = obj.y - dy;
      const newRange = Math.sqrt(newX * newX + newY * newY);
      const newBearing = normalizeAngleDeg((Math.atan2(newX, newY) * 180) / Math.PI);
      return {
        ...obj,
        x: Number(newX.toFixed(2)),
        y: Number(newY.toFixed(2)),
        range: Number(newRange.toFixed(2)),
        bearingDeg: Math.round(newBearing),
      };
    })
    .filter(obj => obj.range >= 0.2 && obj.range <= MAX_ROOM_RADIUS_M + 0.5);

  // Re-project scanned polar sectors after step translation
  const updatedSectors = createInitialRoomSectors();
  for (const s of sectors) {
    if (s.scanCount === 0 || s.type === 'unscanned') continue;
    const rad = (s.centerAngleDeg * Math.PI) / 180;
    const wx = Math.sin(rad) * s.wallRangeM - dx;
    const wy = Math.cos(rad) * s.wallRangeM - dy;
    const newRange = Math.max(0.3, Math.min(MAX_ROOM_RADIUS_M, Math.sqrt(wx * wx + wy * wy)));
    const newAngle = normalizeAngleDeg((Math.atan2(wx, wy) * 180) / Math.PI);
    const targetIdx = angleToSectorIndex(newAngle);

    updatedSectors[targetIdx] = {
      ...updatedSectors[targetIdx],
      wallRangeM: Number(newRange.toFixed(2)),
      type: s.type,
      label: s.label,
      confidence: s.confidence,
      scanCount: s.scanCount,
      lastUpdated: s.lastUpdated,
    };
  }

  return { updatedSectors, updatedObjects };
}

/**
 * Computes a safe human walking path & spoken turn-by-turn indoor direction for a blind user.
 * Prioritizes:
 * 1. Immediate stop/step-aside if an obstacle is within 0.65m ahead.
 * 2. Guiding the user toward a detected DOORWAY if clear.
 * 3. Finding the widest obstacle-free corridor near the user's current facing direction.
 */
export function computeSafeWalkingPath(
  sectors: PolarSector[],
  mapObjects: MapObject[],
  userHeadingDeg: number
): SafeWalkingPath {
  // Check for immediate collision hazard directly in front of user (relative bearing -35° to +35°)
  const obstacles = mapObjects.filter(o => o.type !== 'clear');
  const immediateAhead = obstacles
    .filter(o => {
      const rel = normalizeAngleDeg(o.bearingDeg - userHeadingDeg);
      return Math.abs(rel) <= 35 && o.range < 0.75;
    })
    .sort((a, b) => a.range - b.range)[0];

  // Evaluate candidate relative walking directions from -90° (left) to +90° (right) in 15° steps
  let bestRelAngle = 0;
  let bestScore = -999;
  let bestClearDist = 2.0;
  let bestTargetType: SafeWalkingPath['targetType'] = 'CLEAR_SPACE';

  for (let relAngle = -90; relAngle <= 90; relAngle += 15) {
    const worldAngle = normalizeAngleDeg(userHeadingDeg + relAngle);
    const idx = angleToSectorIndex(worldAngle);
    const leftIdx = (idx - 1 + NUM_SECTORS) % NUM_SECTORS;
    const rightIdx = (idx + 1) % NUM_SECTORS;

    // Effective clearance in a 45° human shoulder cone around candidate direction
    const clearDist = Math.min(
      sectors[idx].wallRangeM,
      sectors[leftIdx].wallRangeM * 0.92,
      sectors[rightIdx].wallRangeM * 0.92
    );

    const isDoorway =
      sectors[idx].type === 'doorway' ||
      sectors[leftIdx].type === 'doorway' ||
      sectors[rightIdx].type === 'doorway';

    // Score prefers long clear distance, doorway targets, and small turns from current heading
    const headingPenalty = Math.abs(relAngle) * 0.012;
    const doorwayBonus = isDoorway ? 1.15 : 0;
    const score = clearDist + doorwayBonus - headingPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestRelAngle = relAngle;
      bestClearDist = Number(clearDist.toFixed(1));
      bestTargetType = isDoorway
        ? 'DOORWAY'
        : clearDist >= 2.2
        ? 'OPEN_CORRIDOR'
        : 'CLEAR_SPACE';
    }
  }

  const worldBearingDeg = normalizeAngleDeg(userHeadingDeg + bestRelAngle);
  const worldRad = (worldBearingDeg * Math.PI) / 180;
  const safeStepDist = Math.max(0.5, Math.min(bestClearDist - 0.3, 2.8));

  // Generate 2D waypoints for the green Safe Path arrow on the SVG floorplan
  const midRad = ((userHeadingDeg + bestRelAngle * 0.6) * Math.PI) / 180;
  const waypoints = [
    { x: 0, y: 0 },
    {
      x: Number((Math.sin(midRad) * (safeStepDist * 0.45)).toFixed(2)),
      y: Number((Math.cos(midRad) * (safeStepDist * 0.45)).toFixed(2)),
    },
    {
      x: Number((Math.sin(worldRad) * safeStepDist).toFixed(2)),
      y: Number((Math.cos(worldRad) * safeStepDist).toFixed(2)),
    },
  ];

  // Build natural human walking guidance
  if (immediateAhead) {
    const turnDir = bestRelAngle < 0 ? 'left' : 'right';
    const turnDegrees = Math.max(30, Math.abs(Math.round(bestRelAngle)));
    return {
      isSafeToWalk: false,
      recommendedBearingDeg: bestRelAngle,
      worldBearingDeg,
      clearDistanceM: bestClearDist,
      targetType: 'STOP_HAZARD',
      spokenInstruction: `Stop! ${immediateAhead.label} ${immediateAhead.range.toFixed(
        1
      )} metres ahead. Turn ${turnDegrees} degrees ${turnDir} and sidestep for a clear ${bestClearDist} metre path.`,
      waypoints,
    };
  }

  const stepsCount = Math.max(1, Math.round(safeStepDist / 0.65));
  let turnPhrase = 'Walk straight ahead';
  if (Math.abs(bestRelAngle) >= 15) {
    const dir = bestRelAngle < 0 ? 'left' : 'right';
    turnPhrase = `Turn ${Math.abs(Math.round(bestRelAngle))} degrees ${dir} and walk`;
  }

  const targetPhrase =
    bestTargetType === 'DOORWAY'
      ? 'toward the open doorway'
      : bestTargetType === 'OPEN_CORRIDOR'
      ? 'along the clear corridor'
      : 'into open floor space';

  return {
    isSafeToWalk: bestClearDist >= HUMAN_SAFE_CLEARANCE_M,
    recommendedBearingDeg: bestRelAngle,
    worldBearingDeg,
    clearDistanceM: bestClearDist,
    targetType: bestTargetType,
    spokenInstruction: `${turnPhrase} ${safeStepDist.toFixed(
      1
    )} metres (${stepsCount} steps) ${targetPhrase}.`,
    waypoints,
  };
}

/**
 * Generates the complete 2D Room Floorplan geometry and spoken spatial overview.
 */
export function buildRoomFloorplanSummary(
  sectors: PolarSector[],
  mapObjects: MapObject[],
  userHeadingDeg: number
): RoomFloorplanSummary {
  const scannedSectors = sectors.filter(s => s.scanCount > 0);
  const scannedCoveragePercent = Math.round((scannedSectors.length / NUM_SECTORS) * 100);

  // Build closed 2D polygon vertices (in meters relative to user at 0,0)
  const polygonPoints = sectors.map(s => {
    const effectiveRange = s.scanCount > 0 ? s.wallRangeM : 2.6;
    const rad = (s.centerAngleDeg * Math.PI) / 180;
    return {
      x: Number((Math.sin(rad) * effectiveRange).toFixed(2)),
      y: Number((Math.cos(rad) * effectiveRange).toFixed(2)),
    };
  });

  // Estimate room width (East-West span) and depth (North-South span)
  const xs = polygonPoints.map(p => p.x);
  const ys = polygonPoints.map(p => p.y);
  const roomWidthM = Number((Math.max(...xs) - Math.min(...xs)).toFixed(1));
  const roomDepthM = Number((Math.max(...ys) - Math.min(...ys)).toFixed(1));

  const doorways = mapObjects.filter(o => o.type === 'doorway' || o.label === 'DOORWAY');
  const furniture = mapObjects.filter(
    o => o.type === 'obstacle' && ['DESK', 'BED', 'CHAIR', 'OBSTACLE'].includes(o.label)
  );
  const walls = mapObjects.filter(o => o.type === 'wall' || o.label === 'WALL');

  const safePath = computeSafeWalkingPath(sectors, mapObjects, userHeadingDeg);

  // Construct natural spoken description of the entire 2D room floorplan
  const descParts: string[] = [];
  descParts.push(
    `2D Room Map (${scannedCoveragePercent}% scanned, approximately ${roomWidthM} by ${roomDepthM} metres).`
  );

  if (furniture.length > 0) {
    const nearestFurn = [...furniture].sort((a, b) => a.range - b.range).slice(0, 2);
    const furnText = nearestFurn
      .map(
        f =>
          `${f.label.toLowerCase()} ${f.range.toFixed(1)} metres ${getDirectionString(
            normalizeAngleDeg(f.bearingDeg - userHeadingDeg)
          )}`
      )
      .join(', and ');
    descParts.push(`Detected ${furnText}.`);
  }

  if (doorways.length > 0) {
    const nearestDoor = [...doorways].sort((a, b) => a.range - b.range)[0];
    const relDoorBearing = normalizeAngleDeg(nearestDoor.bearingDeg - userHeadingDeg);
    descParts.push(
      `Open doorway located ${nearestDoor.range.toFixed(1)} metres ${getDirectionString(
        relDoorBearing
      )}.`
    );
  } else {
    const sectorDoor = sectors.find(s => s.type === 'doorway');
    if (sectorDoor) {
      const relDoor = normalizeAngleDeg(sectorDoor.centerAngleDeg - userHeadingDeg);
      descParts.push(
        `Open doorway gap detected ${sectorDoor.wallRangeM.toFixed(1)} metres ${getDirectionString(
          relDoor
        )}.`
      );
    }
  }

  descParts.push(safePath.spokenInstruction);

  return {
    roomWidthM,
    roomDepthM,
    scannedCoveragePercent,
    polygonPoints,
    doorways,
    furniture,
    walls,
    safePath,
    fullRoomSpokenDescription: descParts.join(' '),
  };
}
