/**
 * ACOUSTIC GROUND-SLAM ENGINE (SE(2) Ground-Plane Constrained SLAM)
 *
 * Adapts robotics Ground-SLAM principles specifically for a blind pedestrian holding a smartphone:
 * 1. IMU Pitch/Roll Ground-Plane Projection:
 *    - Converts 3D slant Time-of-Flight range into true 2D horizontal ground range: r = d * cos(pitch).
 *    - Eliminates "phantom wall" false positives caused by the ultrasonic beam bouncing off the floor
 *      when the user tilts the phone slightly downward.
 * 2. Ground Anomaly Detection (Curbs, Step-Ups, Potholes & Downward Stairs):
 *    - Compares measured slant distance against expected ground-plane intersection distance (H / sin(|pitch|))
 *      to detect raised curbs/steps and dangerous ground drop-offs/stairs.
 * 3. 2D Log-Odds Bayesian Occupancy Grid (Bresenham Raycasting):
 *    - Maintains a persistent 25cm-resolution 2D occupancy grid around the walker, marking raycasted free
 *      cells as Verified Walkable Ground and hit cells as Occupied.
 * 4. Pose-Graph Breadcrumb Trail & Homing:
 *    - Tracks the walker's 2D trajectory from the room entrance (0,0) and provides "Return to Start" guidance.
 */

import { normalizeAngleDeg } from './room_navigator';
import { getDirectionString } from './map_analyzer';

export const GRID_DIM = 33; // 33 x 33 cells
export const CELL_SIZE_M = 0.25; // 25cm per grid cell (8.25m x 8.25m physical coverage)
export const GRID_CENTER_IDX = Math.floor(GRID_DIM / 2); // 16
export const DEFAULT_PHONE_HEIGHT_M = 1.20; // Typical chest/hand holding height (metres)

export type GroundSurfaceAnomaly =
  | 'NONE'
  | 'FLAT_GROUND_BOUNCE'
  | 'CEILING_BOUNCE'
  | 'CURB_STEP_UP'
  | 'GROUND_DROP_OFF';

export interface GroundProjectedMeasurement {
  horizontalRangeM: number;       // True horizontal distance on the 2D ground plane
  slantRangeM: number;            // Raw acoustic ToF slant distance
  estimatedHitHeightM: number;    // Height of reflection point above ground (0 = floor)
  expectedGroundDistM: number | null; // Expected floor intersection distance if tilted down
  anomaly: GroundSurfaceAnomaly;
  isFloorBounceCancelled: boolean; // True if echo was just the flat floor and should NOT be a wall
  overrideLabel?: string;          // e.g. 'CURB / STEP-UP' or 'DROP-OFF / STAIRS'
  overrideType?: 'obstacle' | 'wall' | 'doorway' | 'clear';
  hazardSpeech?: string;
}

export interface WalkableCellRender {
  id: string;
  relX: number; // Metres relative to user's current position
  relY: number; // Metres relative to user's current position
  state: 'walkable' | 'occupied' | 'hazard_drop';
  probability: number;
}

export interface GroundSlamState {
  userWorldX: number; // Metres East/West from origin (0,0)
  userWorldY: number; // Metres North/South from origin (0,0)
  logOddsGrid: Float32Array; // 33x33 log-odds values in [-4.0, +4.0]
  breadcrumbs: Array<{ x: number; y: number }>; // World coordinates of user's walked path
  walkableAreaSqM: number; // Total verified walkable floor area in square metres
  lastGroundAnomaly: GroundSurfaceAnomaly;
}

/**
 * Creates a fresh Ground-SLAM state centered at (0,0)
 */
export function createInitialGroundSlamState(): GroundSlamState {
  const grid = new Float32Array(GRID_DIM * GRID_DIM);
  // Mark initial standing cell (center) as verified walkable ground
  grid[GRID_CENTER_IDX * GRID_DIM + GRID_CENTER_IDX] = -1.5;

  return {
    userWorldX: 0,
    userWorldY: 0,
    logOddsGrid: grid,
    breadcrumbs: [{ x: 0, y: 0 }],
    walkableAreaSqM: 0.25,
    lastGroundAnomaly: 'NONE',
  };
}

/**
 * Projects a raw 3D slant sonar range onto the 2D horizontal ground plane using IMU Pitch,
 * cancels false floor bounces when the phone is tilted down, and detects curbs or drop-offs.
 */
export function projectSlantToGroundPlane(
  slantRangeM: number,
  pitchRad: number,
  rawType: 'obstacle' | 'wall' | 'doorway' | 'clear',
  rawLabel: string,
  phoneHeightM: number = DEFAULT_PHONE_HEIGHT_M
): GroundProjectedMeasurement {
  const safePitch = isFinite(pitchRad) ? pitchRad : 0;
  // Clamp cos(pitch) so extreme tilts don't collapse horizontal distance to 0
  const cosPitch = Math.max(0.35, Math.cos(safePitch));
  const horizontalRangeM = Number((slantRangeM * cosPitch).toFixed(2));

  // Height of acoustic reflection point relative to ground (z = 0):
  // Positive pitchRad = tilted UP; Negative pitchRad = tilted DOWN toward ground
  const estimatedHitHeightM = Number(
    (phoneHeightM + slantRangeM * Math.sin(safePitch)).toFixed(2)
  );

  // 1. Check for steep upward tilt hitting ceiling (> +35 degrees)
  if (safePitch > 0.61 && estimatedHitHeightM > 2.1) {
    return {
      horizontalRangeM,
      slantRangeM,
      estimatedHitHeightM,
      expectedGroundDistM: null,
      anomaly: 'CEILING_BOUNCE',
      isFloorBounceCancelled: true,
      overrideLabel: 'CLEAR',
      overrideType: 'clear',
    };
  }

  // 2. Downward tilt analysis: When user tilts phone downward (pitch < -14 degrees = -0.244 rad)
  const downAngleRad = -safePitch;
  if (downAngleRad >= 0.244 && downAngleRad <= 1.22) {
    const sinDown = Math.max(0.24, Math.sin(downAngleRad));
    const expectedGroundDistM = Number((phoneHeightM / sinDown).toFixed(2));

    // Only evaluate ground intersection if expected floor hit is within sonar range (<= 3.4m)
    if (expectedGroundDistM <= 3.4) {
      const deltaGround = slantRangeM - expectedGroundDistM;

      // Case A: Echo matches flat floor distance within ±0.28m -> Cancel false wall/obstacle!
      if (Math.abs(deltaGround) <= 0.28 && rawType !== 'clear') {
        return {
          horizontalRangeM,
          slantRangeM,
          estimatedHitHeightM: 0,
          expectedGroundDistM,
          anomaly: 'FLAT_GROUND_BOUNCE',
          isFloorBounceCancelled: true,
          overrideLabel: 'CLEAR',
          overrideType: 'clear',
        };
      }

      // Case B: Echo returns significantly earlier than flat floor -> Curb / Step-Up / Low Tripping Hazard!
      if (
        deltaGround < -0.32 &&
        slantRangeM >= 0.4 &&
        estimatedHitHeightM >= 0.12 &&
        estimatedHitHeightM <= 0.55
      ) {
        return {
          horizontalRangeM,
          slantRangeM,
          estimatedHitHeightM,
          expectedGroundDistM,
          anomaly: 'CURB_STEP_UP',
          isFloorBounceCancelled: false,
          overrideLabel: 'CURB / STEP-UP',
          overrideType: 'obstacle',
          hazardSpeech: `Caution! Curb or step-up ${horizontalRangeM.toFixed(
            1
          )} metres ahead.`,
        };
      }

      // Case C: Expected floor echo is missing and range is much deeper -> Drop-Off / Pothole / Downward Stairs!
      if (
        downAngleRad >= 0.35 &&
        expectedGroundDistM <= 2.4 &&
        deltaGround > 0.48
      ) {
        const dropHorizDist = Number((expectedGroundDistM * cosPitch).toFixed(1));
        return {
          horizontalRangeM: dropHorizDist,
          slantRangeM,
          estimatedHitHeightM,
          expectedGroundDistM,
          anomaly: 'GROUND_DROP_OFF',
          isFloorBounceCancelled: false,
          overrideLabel: 'DROP-OFF / STAIRS',
          overrideType: 'obstacle',
          hazardSpeech: `Warning! Ground drop-off or downward stairs ${dropHorizDist.toFixed(
            1
          )} metres ahead! Stop and check with cane.`,
        };
      }
    }
  }

  // Normal vertical obstacle / wall / doorway on the ground plane
  return {
    horizontalRangeM,
    slantRangeM,
    estimatedHitHeightM,
    expectedGroundDistM: null,
    anomaly: 'NONE',
    isFloorBounceCancelled: false,
    overrideLabel: rawLabel,
    overrideType: rawType,
  };
}

/**
 * Converts world (x, y) metres into grid indices (gx, gy) in [0 .. GRID_DIM-1]
 */
function worldToGridIndex(worldX: number, worldY: number): { gx: number; gy: number } | null {
  const gx = Math.round(worldX / CELL_SIZE_M) + GRID_CENTER_IDX;
  const gy = Math.round(worldY / CELL_SIZE_M) + GRID_CENTER_IDX;
  if (gx < 0 || gx >= GRID_DIM || gy < 0 || gy >= GRID_DIM) {
    return null;
  }
  return { gx, gy };
}

/**
 * Updates the 2D Log-Odds Occupancy Grid using Bresenham raycasting from the user's pose
 * to the ground-projected acoustic measurement.
 */
export function updateGroundSlamGrid(
  prevState: GroundSlamState,
  worldBearingDeg: number,
  projected: GroundProjectedMeasurement
): GroundSlamState {
  const grid = new Float32Array(prevState.logOddsGrid);
  const startCell = worldToGridIndex(prevState.userWorldX, prevState.userWorldY);
  if (!startCell) {
    return prevState;
  }

  const rad = (worldBearingDeg * Math.PI) / 180;
  const hitWorldX = prevState.userWorldX + Math.sin(rad) * projected.horizontalRangeM;
  const hitWorldY = prevState.userWorldY + Math.cos(rad) * projected.horizontalRangeM;

  // Clamp ray endpoint to grid bounds
  const maxCoordM = (GRID_CENTER_IDX - 1) * CELL_SIZE_M;
  const clampedHitX = Math.max(-maxCoordM, Math.min(maxCoordM, hitWorldX));
  const clampedHitY = Math.max(-maxCoordM, Math.min(maxCoordM, hitWorldY));
  const endCell = worldToGridIndex(clampedHitX, clampedHitY);

  if (!endCell) {
    return prevState;
  }

  // Bresenham 2D line traversal from (gx0, gy0) to (gx1, gy1)
  let x0 = startCell.gx;
  let y0 = startCell.gy;
  const x1 = endCell.gx;
  const y1 = endCell.gy;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    const isEndpoint = x0 === x1 && y0 === y1;
    const cellIdx = y0 * GRID_DIM + x0;

    if (!isEndpoint) {
      // Intermediate cell traversed by acoustic pulse -> Mark as Verified Walkable Ground (negative log-odds)
      grid[cellIdx] = Math.max(-4.0, grid[cellIdx] - 0.55);
    } else {
      // Endpoint cell
      if (
        projected.overrideType === 'clear' ||
        projected.isFloorBounceCancelled ||
        projected.overrideType === 'doorway'
      ) {
        grid[cellIdx] = Math.max(-4.0, grid[cellIdx] - 0.55);
      } else {
        // Occupied by wall, furniture, curb, or drop-off
        grid[cellIdx] = Math.min(4.0, grid[cellIdx] + 0.95);
      }
      break;
    }

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }

  // Compute total verified walkable ground area in square metres
  let walkableCount = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] < -0.45) {
      walkableCount++;
    }
  }
  const walkableAreaSqM = Number(
    (walkableCount * CELL_SIZE_M * CELL_SIZE_M).toFixed(1)
  );

  return {
    ...prevState,
    logOddsGrid: grid,
    walkableAreaSqM,
    lastGroundAnomaly: projected.anomaly,
  };
}

/**
 * Updates the user's Ground-SLAM world pose and breadcrumb trail when a physical step is detected,
 * clamping against occupied wall cells so IMU drift cannot push the user through a mapped wall.
 */
export function recordGroundSlamStep(
  prevState: GroundSlamState,
  stepLengthM: number,
  userHeadingDeg: number
): GroundSlamState {
  const rad = (userHeadingDeg * Math.PI) / 180;
  const candidateX = prevState.userWorldX + Math.sin(rad) * stepLengthM;
  const candidateY = prevState.userWorldY + Math.cos(rad) * stepLengthM;

  const maxCoordM = (GRID_CENTER_IDX - 2) * CELL_SIZE_M;
  let nextX = Math.max(-maxCoordM, Math.min(maxCoordM, candidateX));
  let nextY = Math.max(-maxCoordM, Math.min(maxCoordM, candidateY));

  // Ground-SLAM Wall Constraint: If candidate cell has high occupied log-odds (> 1.2), damp step
  const candidateCell = worldToGridIndex(nextX, nextY);
  const grid = new Float32Array(prevState.logOddsGrid);
  if (candidateCell) {
    const idx = candidateCell.gy * GRID_DIM + candidateCell.gx;
    if (grid[idx] > 1.2) {
      // User cannot walk through a solid wall; clamp movement
      nextX = prevState.userWorldX + (nextX - prevState.userWorldX) * 0.25;
      nextY = prevState.userWorldY + (nextY - prevState.userWorldY) * 0.25;
    } else {
      // Mark newly stepped cell as verified walkable ground
      grid[idx] = Math.max(-4.0, grid[idx] - 0.8);
    }
  }

  const breadcrumbs = [
    ...prevState.breadcrumbs.slice(-40),
    { x: Number(nextX.toFixed(2)), y: Number(nextY.toFixed(2)) },
  ];

  return {
    ...prevState,
    userWorldX: Number(nextX.toFixed(2)),
    userWorldY: Number(nextY.toFixed(2)),
    logOddsGrid: grid,
    breadcrumbs,
  };
}

/**
 * Extracts verified walkable ground cells relative to the user's current position
 * for rendering on the 2D SVG Floorplan.
 */
export function getRelativeWalkableCells(
  state: GroundSlamState,
  maxRenderCells: number = 90
): WalkableCellRender[] {
  const cells: WalkableCellRender[] = [];

  for (let gy = 0; gy < GRID_DIM; gy++) {
    for (let gx = 0; gx < GRID_DIM; gx++) {
      const logOdds = state.logOddsGrid[gy * GRID_DIM + gx];
      if (logOdds > -0.45) continue; // Only render verified walkable ground cells

      const cellWorldX = (gx - GRID_CENTER_IDX) * CELL_SIZE_M;
      const cellWorldY = (gy - GRID_CENTER_IDX) * CELL_SIZE_M;
      const relX = Number((cellWorldX - state.userWorldX).toFixed(2));
      const relY = Number((cellWorldY - state.userWorldY).toFixed(2));

      if (Math.abs(relX) <= 3.8 && Math.abs(relY) <= 3.8) {
        const prob = 1 - 1 / (1 + Math.exp(Math.abs(logOdds)));
        cells.push({
          id: `g_${gx}_${gy}`,
          relX,
          relY,
          state: 'walkable',
          probability: Number(prob.toFixed(2)),
        });
      }
    }
  }

  return cells.slice(0, maxRenderCells);
}

/**
 * Computes spoken guidance to return the blind user along their walked Ground-SLAM
 * breadcrumb trail back to their starting point (0,0).
 */
export function computeReturnToStartGuidance(
  state: GroundSlamState,
  userHeadingDeg: number
): string {
  const dx = 0 - state.userWorldX;
  const dy = 0 - state.userWorldY;
  const distToStartM = Math.sqrt(dx * dx + dy * dy);

  if (distToStartM < 0.55) {
    return 'You are already at your starting entrance point.';
  }

  const worldBearingToStart = normalizeAngleDeg(
    (Math.atan2(dx, dy) * 180) / Math.PI
  );
  const relTurnDeg = normalizeAngleDeg(worldBearingToStart - userHeadingDeg);
  const stepsBack = Math.max(1, Math.round(distToStartM / 0.62));
  const dirPhrase = getDirectionString(relTurnDeg);

  if (Math.abs(relTurnDeg) <= 20) {
    return `Return to start: Walk straight ahead ${distToStartM.toFixed(
      1
    )} metres (${stepsBack} steps) along your verified ground trail.`;
  }

  const turnSide = relTurnDeg < 0 ? 'left' : 'right';
  return `Return to start: Turn ${Math.abs(
    Math.round(relTurnDeg)
  )} degrees ${turnSide} (${dirPhrase}) and walk ${distToStartM.toFixed(
    1
  )} metres (${stepsBack} steps) back to your starting point.`;
}
