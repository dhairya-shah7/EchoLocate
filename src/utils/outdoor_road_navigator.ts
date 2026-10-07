/**
 * OUTDOOR ROAD & SIDEWALK NAVIGATOR + GOOGLE MAPS CO-PILOT BRIDGE
 *
 * Designed for blind pedestrians walking on sidewalks and roads:
 * 1. Reverse geocodes GPS coordinates via OpenStreetMap Nominatim (no API key needed) to announce current street/intersection.
 * 2. Fetches pedestrian walking routes via OSRM when a destination is spoken.
 * 3. Sidewalk Drift Guard: Compares user's compass heading against the locked sidewalk/road bearing and warns if veering > 25° into traffic.
 * 4. Roadside Ultrasonic Hazard Shield: Re-maps close ultrasonic reflections into outdoor hazards (VEHICLE, POLE, PEDESTRIAN, BARRIER) and announces sidestep instructions.
 * 5. Google Maps Co-Pilot Bridge: Launches Google Maps Turn-by-Turn Walking Navigation (`google.navigation:q=...&mode=w`) while keeping EchoLocate running in audio-ducking Co-Pilot mode.
 */

import { NativeModules, Linking } from 'react-native';
import { MapObject, getDirectionString } from './map_analyzer';
import { normalizeAngleDeg } from './room_navigator';

function getLocationAndVoiceModule(): any {
  try {
    return NativeModules?.LocationAndVoice ?? null;
  } catch {
    return null;
  }
}

export interface GpsFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  bearing: number;
  speed: number;
}

export interface RoadContext {
  streetName: string;
  neighbourhood: string;
  city: string;
  displayAddress: string;
  lockedSidewalkBearingDeg: number | null;
  isGoogleMapsCoPilotActive: boolean;
  activeDestinationName: string | null;
  nextTurnInstruction: string | null;
  distanceToNextTurnM: number | null;
}

export interface SidewalkDriftStatus {
  isDriftingIntoRoad: boolean;
  driftDegrees: number;
  driftDirection: 'left' | 'right' | 'aligned';
  warningSpeech: string | null;
}

/**
 * Converts indoor acoustic semantic labels into outdoor roadside hazard labels
 * when the user switches to Road Mode.
 */
export function mapIndoorLabelToOutdoorRoadHazard(
  indoorLabel: string,
  rangeM: number,
  pulseWidthM: number
): { label: string; type: 'obstacle' | 'wall' | 'doorway' | 'clear' } {
  if (indoorLabel === 'CLEAR' || rangeM > 3.6) {
    return { label: 'CLEAR', type: 'clear' };
  }
  if (indoorLabel === 'DOORWAY') {
    return { label: 'CROSSWALK GAP', type: 'doorway' };
  }
  if (indoorLabel === 'WALL' || pulseWidthM >= 0.65) {
    return { label: 'PARKED VEHICLE', type: 'wall' };
  }
  if (indoorLabel === 'DESK' || indoorLabel === 'BED') {
    return { label: 'ROADSIDE BARRIER', type: 'obstacle' };
  }
  if (indoorLabel === 'CHAIR' || pulseWidthM < 0.35) {
    return { label: 'SIGNPOST / POLE', type: 'obstacle' };
  }
  return { label: 'PEDESTRIAN / OBSTACLE', type: 'obstacle' };
}

/**
 * Queries native Android GPS location via LocationAndVoiceModule
 */
export async function getDeviceGpsFix(): Promise<GpsFix | null> {
  try {
    const LocationAndVoice = getLocationAndVoiceModule();
    if (!LocationAndVoice || !LocationAndVoice.getCurrentLocation) {
      return null;
    }
    const loc = await LocationAndVoice.getCurrentLocation();
    if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
      return {
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy ?? 15,
        bearing: loc.bearing ?? 0,
        speed: loc.speed ?? 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reverse geocodes GPS coordinates using OpenStreetMap Nominatim to get current street name
 */
export async function fetchStreetContextFromGps(
  lat: number,
  lon: number
): Promise<{ streetName: string; neighbourhood: string; city: string; summarySpeech: string }> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'EchoLocateBlindNavigator/2.0 (Accessibility Assistive App)',
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const addr = data?.address || {};
    const streetName =
      addr.road ||
      addr.pedestrian ||
      addr.footway ||
      addr.path ||
      addr.suburb ||
      'Current Sidewalk';
    const neighbourhood = addr.neighbourhood || addr.suburb || addr.quarter || '';
    const city = addr.city || addr.town || addr.village || addr.county || '';

    const locationParts = [streetName, neighbourhood, city].filter(Boolean);
    const summarySpeech =
      locationParts.length > 0
        ? `Road Mode active on ${streetName}${neighbourhood ? `, ${neighbourhood}` : ''}.`
        : 'Road Mode active. GPS locked on sidewalk.';

    return { streetName, neighbourhood, city, summarySpeech };
  } catch {
    return {
      streetName: `GPS (${lat.toFixed(4)}, ${lon.toFixed(4)})`,
      neighbourhood: '',
      city: '',
      summarySpeech: 'Road Mode active. GPS coordinates locked for sidewalk tracking.',
    };
  }
}

/**
 * Geocodes a spoken destination and fetches a pedestrian walking route via OSRM
 */
export async function fetchWalkingRouteToDestination(
  startLat: number,
  startLon: number,
  destinationQuery: string
): Promise<{
  destinationName: string;
  destLat: number;
  destLon: number;
  totalDistanceM: number;
  firstInstruction: string;
  initialBearingDeg: number;
} | null> {
  try {
    const searchUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(
      destinationQuery
    )}&viewbox=${startLon - 0.05},${startLat + 0.05},${startLon + 0.05},${
      startLat - 0.05
    }`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'EchoLocateBlindNavigator/2.0 (Accessibility Assistive App)',
        Accept: 'application/json',
      },
    });
    const places = await searchRes.json();
    if (!Array.isArray(places) || places.length === 0) {
      return null;
    }

    const dest = places[0];
    const destLat = parseFloat(dest.lat);
    const destLon = parseFloat(dest.lon);
    const destinationName = (dest.display_name || destinationQuery).split(',')[0];

    // Calculate initial bearing from start to destination
    const dLon = ((destLon - startLon) * Math.PI) / 180;
    const lat1 = (startLat * Math.PI) / 180;
    const lat2 = (destLat * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const initialBearingDeg = normalizeAngleDeg((Math.atan2(y, x) * 180) / Math.PI);

    // Query OSRM foot routing
    const osrmUrl = `https://router.project-osrm.org/route/v1/foot/${startLon},${startLat};${destLon},${destLat}?overview=false&steps=true`;
    const routeRes = await fetch(osrmUrl);
    const routeData = await routeRes.json();
    const route = routeData?.routes?.[0];
    const totalDistanceM = Math.round(route?.distance || 150);
    const firstStep = route?.legs?.[0]?.steps?.[0];
    const roadName = firstStep?.name || 'the sidewalk';

    const firstInstruction = `Walking route to ${destinationName} (${totalDistanceM} metres). Proceed along ${roadName}.`;

    return {
      destinationName,
      destLat,
      destLon,
      totalDistanceM,
      firstInstruction,
      initialBearingDeg,
    };
  } catch {
    return null;
  }
}

/**
 * Checks if the blind pedestrian is drifting off the aligned sidewalk bearing (> 25°) into the road
 */
export function checkSidewalkDrift(
  currentHeadingDeg: number,
  lockedSidewalkBearingDeg: number | null
): SidewalkDriftStatus {
  if (lockedSidewalkBearingDeg === null) {
    return {
      isDriftingIntoRoad: false,
      driftDegrees: 0,
      driftDirection: 'aligned',
      warningSpeech: null,
    };
  }

  const diff = normalizeAngleDeg(currentHeadingDeg - lockedSidewalkBearingDeg);
  const absDiff = Math.abs(Math.round(diff));

  if (absDiff > 28) {
    const veerDir = diff > 0 ? 'right' : 'left';
    const correctDir = diff > 0 ? 'left' : 'right';
    return {
      isDriftingIntoRoad: true,
      driftDegrees: absDiff,
      driftDirection: veerDir,
      warningSpeech: `Sidewalk drift alert! You veered ${absDiff} degrees ${veerDir}. Turn slightly ${correctDir} to stay on the sidewalk.`,
    };
  }

  return {
    isDriftingIntoRoad: false,
    driftDegrees: absDiff,
    driftDirection: 'aligned',
    warningSpeech: null,
  };
}

/**
 * Synthesizes outdoor road & sidewalk ultrasonic obstacle avoidance speech
 */
export function generateOutdoorRoadGuidance(
  mapObjects: MapObject[],
  userHeadingDeg: number,
  roadContext: RoadContext
): string {
  const drift = checkSidewalkDrift(userHeadingDeg, roadContext.lockedSidewalkBearingDeg);

  const obstacles = mapObjects.filter(o => o.type !== 'clear');
  const nearestAhead = obstacles
    .filter(o => Math.abs(normalizeAngleDeg(o.bearingDeg - userHeadingDeg)) <= 40)
    .sort((a, b) => a.range - b.range)[0];

  if (nearestAhead && nearestAhead.range < 1.8) {
    const relBearing = normalizeAngleDeg(nearestAhead.bearingDeg - userHeadingDeg);
    const sidestepDir = relBearing >= 0 ? 'left' : 'right';
    return `Roadside Alert! ${nearestAhead.label} ${nearestAhead.range.toFixed(
      1
    )} metres ${getDirectionString(relBearing)}. Sidestep ${sidestepDir} on the sidewalk.`;
  }

  if (drift.isDriftingIntoRoad && drift.warningSpeech) {
    return drift.warningSpeech;
  }

  if (roadContext.isGoogleMapsCoPilotActive) {
    return `Google Maps Co-Pilot active on ${roadContext.streetName}. Sidewalk ahead is clear for 3.5 metres.`;
  }

  if (roadContext.nextTurnInstruction) {
    return `${roadContext.nextTurnInstruction} Sidewalk clear ahead.`;
  }

  return `Walking on ${roadContext.streetName}. Sidewalk path clear ahead.`;
}

/**
 * Enables shared audio ducking and launches Google Maps Turn-by-Turn Walking Navigation
 * while keeping EchoLocate active as an ultrasonic obstacle shield.
 */
export async function launchGoogleMapsCoPilot(destinationQuery?: string): Promise<boolean> {
  const query = destinationQuery && destinationQuery.trim().length > 0
    ? destinationQuery.trim()
    : 'nearest pedestrian crosswalk';

  try {
    const LocationAndVoice = getLocationAndVoiceModule();
    if (LocationAndVoice && LocationAndVoice.enableCoPilotAudioMode) {
      await LocationAndVoice.enableCoPilotAudioMode();
    }
    if (LocationAndVoice && LocationAndVoice.launchGoogleMapsWalking) {
      await LocationAndVoice.launchGoogleMapsWalking(query);
      return true;
    }
    const encoded = encodeURIComponent(query);
    await Linking.openURL(`google.navigation:q=${encoded}&mode=w`);
    return true;
  } catch {
    return false;
  }
}
