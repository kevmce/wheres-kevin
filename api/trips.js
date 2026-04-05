/**
 * /api/trips.js — Serverless function (Vercel-compatible)
 *
 * Reads a Google Calendar, parses travel events into structured trip data,
 * and returns JSON for the frontend.
 *
 * Amtrak app integration:
 *   - Amtrak calendar events look like: "Amtrak: 152 Northeast Regional"
 *   - The address field is just street + city + state zip (no station name):
 *       "50 Massachusetts Avenue NE , Washington DC 20002-4214"
 *       "351 West 31st Street , New York NY 10001"
 *   - Note: city + state are NOT comma-separated ("New York NY" not "New York, NY")
 *   - Outbound leg address = departure station (your home city)
 *   - Return leg address = departure station of the return (your destination)
 *   - We group paired Amtrak legs and pick the non-home city as the destination.
 */

const { google } = require("googleapis");

// ── Airport code → city mapping ──
const AIRPORT_CITIES = {
  LAX: "Los Angeles", SFO: "San Francisco", JFK: "New York", EWR: "New York",
  LGA: "New York", ORD: "Chicago", ATL: "Atlanta", DFW: "Dallas",
  DEN: "Denver", SEA: "Seattle", PDX: "Portland", BOS: "Boston",
  MIA: "Miami", IAH: "Houston", PHX: "Phoenix", SAN: "San Diego",
  AUS: "Austin", MSP: "Minneapolis", DTW: "Detroit", TPA: "Tampa",
  MCO: "Orlando", SLC: "Salt Lake City", DCA: "Washington DC",
  IAD: "Washington DC", BWI: "Baltimore", RDU: "Raleigh",
  NRT: "Tokyo", HND: "Tokyo", LHR: "London", CDG: "Paris",
  FCO: "Rome", BCN: "Barcelona", AMS: "Amsterdam", FRA: "Frankfurt",
  ICN: "Seoul", HKG: "Hong Kong", SIN: "Singapore", SYD: "Sydney",
  MEX: "Mexico City", GRU: "São Paulo", YYZ: "Toronto", YVR: "Vancouver",
  CUN: "Cancún", LIR: "Liberia", SJO: "San José",
};

// ── US state abbreviations (for address parsing) ──
const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
  "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
  "TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

/**
 * Extract city from an Amtrak-style address string.
 *
 * Real examples from the Amtrak app's calendar exports:
 *   "50 Massachusetts Avenue NE , Washington DC 20002-4214"
 *   "351 West 31st Street , New York NY 10001"
 *
 * The format is:  Street Address , City STATE ZIP
 * City and STATE are space-separated (no comma between them).
 * The comma separates the street from the city+state+zip chunk.
 */
function extractCityFromAmtrakAddress(address) {
  if (!address) return null;

  // Split on comma — last chunk should be "City STATE ZIP"
  const parts = address.split(",").map(p => p.trim());
  const cityStateZip = parts[parts.length - 1];
  if (!cityStateZip) return null;

  // Match "City ST ZIP" or "City ST ZIP-PLUS4"
  // e.g. "Washington DC 20002-4214" → "Washington"
  // e.g. "New York NY 10001" → "New York"
  const match = cityStateZip.match(/^(.+?)\s+([A-Z]{2})\s+\d{5}(-\d{4})?$/);
  if (match) return match[1].trim();

  // Match "City ST" (no zip)
  const noZip = cityStateZip.match(/^(.+?)\s+([A-Z]{2})$/);
  if (noZip && US_STATES.has(noZip[2])) return noZip[1].trim();

  // Fallback: strip any trailing zip and return what's left
  return cityStateZip.replace(/\s+\d{5}(-\d{4})?$/, "").trim() || null;
}

/**
 * Extract city from a general location field (Flighty, manual entries, etc.)
 */
function extractCityFromLocation(location) {
  if (!location) return null;
  const parts = location.split(",").map(p => p.trim());

  if (parts.length >= 3) {
    const last = parts[parts.length - 1].trim();
    const secondLast = parts[parts.length - 2].trim();
    if (/^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(last)) return secondLast;
    return secondLast;
  }
  if (parts.length === 2) return parts[0];
  return parts[0] || null;
}

// ── Parse a single calendar event ──
function parseEvent(event) {
  const title = event.summary || "";
  const location = event.location || "";
  const start = event.start?.date || event.start?.dateTime?.split("T")[0];
  const end = event.end?.date || event.end?.dateTime?.split("T")[0];

  if (!start || !end) return null;

  let city = null;
  let mode = "flight";

  // ── Amtrak app events ──
  // Format: "Amtrak: 152 Northeast Regional" or "Amtrak: 2259 Acela"
  const isAmtrakApp = /^amtrak:\s*\d+/i.test(title);
  if (isAmtrakApp) {
    city = extractCityFromAmtrakAddress(location);
    mode = "train";
    if (city) {
      return {
        id: event.id,
        city,
        region: location,
        start,
        end,
        mode,
        _isAmtrakLeg: true,
      };
    }
  }

  // ── Flight / other patterns ──

  // "Flight to [City]"
  const flightTo = title.match(/(?:flight|fly|flying)\s+to\s+(.+)/i);
  if (flightTo) { city = flightTo[1].trim(); mode = "flight"; }

  // "Train to [City]" (manual)
  if (!city) {
    const trainTo = title.match(/(?:amtrak|train)\s+to\s+(.+)/i);
    if (trainTo) { city = trainTo[1].trim(); mode = "train"; }
  }

  // "ABC → DEF" airport codes
  if (!city) {
    const codeMatch = title.match(/([A-Z]{3})\s*[→\->–]\s*([A-Z]{3})/);
    if (codeMatch) { city = AIRPORT_CITIES[codeMatch[2]] || codeMatch[2]; mode = "flight"; }
  }

  // "[Mode]: Origin → Destination"
  if (!city) {
    const modeRoute = title.match(/(?:flight|train|amtrak):\s*.+?[→\->–]\s*(.+)/i);
    if (modeRoute) { city = modeRoute[1].trim(); if (/train|amtrak/i.test(title)) mode = "train"; }
  }

  // "[City] Trip" or "Trip to [City]"
  if (!city) {
    const tripMatch = title.match(/(?:trip\s+to\s+(.+)|(.+?)\s+trip)/i);
    if (tripMatch) city = (tripMatch[1] || tripMatch[2]).trim();
  }

  // Fallback: location field
  if (!city && location) city = extractCityFromLocation(location);

  if (mode !== "train" && /amtrak|train/i.test(title)) mode = "train";
  if (/drive|driving|road\s*trip/i.test(title)) mode = "drive";

  if (!city) return null;
  city = city.replace(/[.!?]$/, "").trim();

  return { id: event.id, city, region: location || "", start, end, mode, _isAmtrakLeg: false };
}

/**
 * Merge paired Amtrak legs into single round-trips.
 *
 * Example: DC → NYC weekend trip
 *   Sat 3/28 8:22 AM  "Amtrak: 152 NE Regional" @ ...Washington DC 20002
 *   Sun 3/29 8:24 PM  "Amtrak: 2259 Acela"      @ ...New York NY 10001
 *
 * The outbound departs from home (Washington), the return departs from the
 * destination (New York). We group them, find the non-home city, and create
 * one trip: "New York" from Sat 3/28 → Sun 3/29.
 */
function mergeAmtrakLegs(trips, homeCity) {
  const homeVariants = buildHomeCityVariants(homeCity);
  const result = [];
  let i = 0;

  while (i < trips.length) {
    const trip = trips[i];

    if (!trip._isAmtrakLeg) {
      result.push(trip);
      i++;
      continue;
    }

    // Gather consecutive Amtrak legs within a 7-day window
    const group = [trip];
    let j = i + 1;
    while (j < trips.length && trips[j]._isAmtrakLeg) {
      const prevEnd = new Date(group[group.length - 1].end + "T00:00:00");
      const nextStart = new Date(trips[j].start + "T00:00:00");
      const daysBetween = (nextStart - prevEnd) / (1000 * 60 * 60 * 24);
      if (daysBetween <= 7) {
        group.push(trips[j]);
        j++;
      } else {
        break;
      }
    }

    // Find destination: the leg whose city is NOT home
    const destLeg = group.find(g => !isHomeCity(g.city, homeVariants));

    if (destLeg) {
      result.push({
        id: destLeg.id,
        city: destLeg.city,
        region: destLeg.region,
        start: group[0].start,
        end: group[group.length - 1].end,
        mode: "train",
      });
    } else {
      // All legs match home city — show as-is (one-way trip?)
      result.push({ ...group[0] });
    }

    i = j;
  }

  return result;
}

/**
 * Build variants of the home city name for flexible matching.
 * "Arlington" should also match "Washington" and "Washington DC" since
 * DC-area transit hubs (Union Station, etc.) are in Washington proper.
 */
function buildHomeCityVariants(homeCity) {
  const base = homeCity.toLowerCase().trim();
  const variants = new Set([base]);

  // Common aliases — includes regional transit hub mappings
  const aliases = {
    arlington: ["washington", "washington dc", "washington d.c."],
    washington: ["washington dc", "washington d.c.", "arlington"],
    "washington dc": ["washington", "washington d.c.", "arlington"],
    "new york": ["new york city", "nyc", "manhattan"],
    "los angeles": ["la"],
    "san francisco": ["sf"],
    philadelphia: ["philly"],
  };

  if (aliases[base]) {
    aliases[base].forEach(a => variants.add(a));
  }

  return variants;
}

function isHomeCity(city, homeVariants) {
  return homeVariants.has(city.toLowerCase().trim());
}

// ── City coordinates ──
const CITY_COORDS = {
  "los angeles": { lat: 34.0522, lng: -118.2437 },
  "new york": { lat: 40.7128, lng: -74.006 },
  "san francisco": { lat: 37.7749, lng: -122.4194 },
  tokyo: { lat: 35.6762, lng: 139.6503 },
  portland: { lat: 45.5152, lng: -122.6784 },
  seattle: { lat: 47.6062, lng: -122.3321 },
  chicago: { lat: 41.8781, lng: -87.6298 },
  london: { lat: 51.5074, lng: -0.1278 },
  paris: { lat: 48.8566, lng: 2.3522 },
  denver: { lat: 39.7392, lng: -104.9903 },
  austin: { lat: 30.2672, lng: -97.7431 },
  boston: { lat: 42.3601, lng: -71.0589 },
  miami: { lat: 25.7617, lng: -80.1918 },
  atlanta: { lat: 33.749, lng: -84.388 },
  dallas: { lat: 32.7767, lng: -96.797 },
  washington: { lat: 38.9072, lng: -77.0369 },
  "washington dc": { lat: 38.9072, lng: -77.0369 },
  arlington: { lat: 38.8816, lng: -77.0910 },
  amsterdam: { lat: 52.3676, lng: 4.9041 },
  barcelona: { lat: 41.3851, lng: 2.1734 },
  rome: { lat: 41.9028, lng: 12.4964 },
  seoul: { lat: 37.5665, lng: 126.978 },
  singapore: { lat: 1.3521, lng: 103.8198 },
  sydney: { lat: -33.8688, lng: 151.2093 },
  "hong kong": { lat: 22.3193, lng: 114.1694 },
  toronto: { lat: 43.6532, lng: -79.3832 },
  vancouver: { lat: 49.2827, lng: -123.1207 },
  "mexico city": { lat: 19.4326, lng: -99.1332 },
  orlando: { lat: 28.5383, lng: -81.3792 },
  "san diego": { lat: 32.7157, lng: -117.1611 },
  phoenix: { lat: 33.4484, lng: -112.074 },
  minneapolis: { lat: 44.9778, lng: -93.265 },
  "salt lake city": { lat: 40.7608, lng: -111.891 },
  cancun: { lat: 21.1619, lng: -86.8515 },
  houston: { lat: 29.7604, lng: -95.3698 },
  tampa: { lat: 27.9506, lng: -82.4572 },
  raleigh: { lat: 35.7796, lng: -78.6382 },
  baltimore: { lat: 39.2904, lng: -76.6122 },
  detroit: { lat: 42.3314, lng: -83.0458 },
  frankfurt: { lat: 50.1109, lng: 8.6821 },
  philadelphia: { lat: 39.9526, lng: -75.1652 },
  "new haven": { lat: 41.3083, lng: -72.9279 },
  providence: { lat: 41.824, lng: -71.4128 },
  richmond: { lat: 37.5407, lng: -77.436 },
  wilmington: { lat: 39.7391, lng: -75.5398 },
  norfolk: { lat: 36.8508, lng: -76.2859 },
  "new orleans": { lat: 29.9511, lng: -90.0715 },
  pittsburgh: { lat: 40.4406, lng: -79.9959 },
  albany: { lat: 42.6526, lng: -73.7562 },
  savannah: { lat: 32.0809, lng: -81.0912 },
  jacksonville: { lat: 30.3322, lng: -81.6557 },
};

function getCoords(city) {
  return CITY_COORDS[city.toLowerCase().trim()] || null;
}

// ── Main handler ──
async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      },
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const calendar = google.calendar({ version: "v3", auth });

    const now = new Date();
    const timeMin = new Date(now); timeMin.setDate(timeMin.getDate() - 30);
    const timeMax = new Date(now); timeMax.setDate(timeMax.getDate() + 90);

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];
    const homeCity = process.env.HOME_CITY || "Arlington";

    // Parse → merge Amtrak pairs → add coordinates
    let trips = events.map(parseEvent).filter(Boolean);
    trips = mergeAmtrakLegs(trips, homeCity);
    trips = trips.map((trip) => {
      const coords = getCoords(trip.city);
      const { _isAmtrakLeg, ...clean } = trip;
      return { ...clean, lat: coords?.lat || null, lng: coords?.lng || null };
    });

    const home = {
      city: homeCity,
      region: process.env.HOME_REGION || "VA",
      lat: parseFloat(process.env.HOME_LAT) || 38.8816,
      lng: parseFloat(process.env.HOME_LNG) || -77.0910,
    };

    res.status(200).json({ ok: true, home, trips, fetched_at: new Date().toISOString() });
  } catch (error) {
    console.error("Calendar API error:", error.message);
    res.status(500).json({ ok: false, error: "Failed to fetch calendar data", detail: error.message });
  }
}

module.exports = handler;
