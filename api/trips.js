/**
 * /api/trips.js — Serverless function (Vercel-compatible)
 *
 * Reads a Google Calendar, parses travel events (Flighty + Amtrak + manual),
 * and merges individual legs into unified trips.
 *
 * Data sources:
 *
 *   FLIGHTY calendar events:
 *     Title:    "✈ JFK→SFO · AA 177"
 *     Location: "John F Kennedy Intl." (departure airport — NOT useful for destination)
 *     Description: "Booking Code: EQSGPJ\n\nAmerican Airlines 177\nNew York to San Francisco\n..."
 *     → We extract destination city from the description ("New York to San Francisco")
 *     → Fallback: extract destination airport code from title and map to city
 *
 *   AMTRAK app calendar events:
 *     Title:    "Amtrak: 152 Northeast Regional"
 *     Location: "50 Massachusetts Avenue NE , Washington DC 20002-4214"
 *     → City extracted from address; paired legs merged (non-home city = destination)
 *
 *   MANUAL entries:
 *     "Flight to Tokyo", "Train to Portland", "Tokyo Trip", etc.
 *
 * After parsing, all legs are merged into unified trips:
 *   - Consecutive travel legs within 1 day of each other get stitched together
 *   - Home-city legs (departures/returns) are absorbed into the trip
 *   - Mixed mode (train DC→NYC, then fly NYC→SFO) works correctly
 */

const { google } = require("googleapis");

// ── Airport code → city mapping ──
const AIRPORT_CITIES = {
  // US Major
  LAX: "Los Angeles", SFO: "San Francisco", OAK: "Oakland",
  JFK: "New York", EWR: "Newark", LGA: "New York",
  ORD: "Chicago", MDW: "Chicago",
  ATL: "Atlanta", DFW: "Dallas", DAL: "Dallas",
  DEN: "Denver", SEA: "Seattle", PDX: "Portland",
  BOS: "Boston", MIA: "Miami", FLL: "Fort Lauderdale",
  IAH: "Houston", HOU: "Houston",
  PHX: "Phoenix", SAN: "San Diego",
  AUS: "Austin", MSP: "Minneapolis",
  DTW: "Detroit", TPA: "Tampa", MCO: "Orlando",
  SLC: "Salt Lake City",
  DCA: "Washington DC", IAD: "Washington DC", BWI: "Baltimore",
  RDU: "Raleigh", CLT: "Charlotte", PHL: "Philadelphia",
  PIT: "Pittsburgh", CLE: "Cleveland", CVG: "Cincinnati",
  MCI: "Kansas City", STL: "St. Louis", IND: "Indianapolis",
  BNA: "Nashville", MEM: "Memphis", MSY: "New Orleans",
  JAX: "Jacksonville", RSW: "Fort Myers", PBI: "West Palm Beach",
  SJC: "San Jose", SMF: "Sacramento", BUR: "Burbank",
  HNL: "Honolulu", OGG: "Maui",
  // International
  NRT: "Tokyo", HND: "Tokyo", KIX: "Osaka",
  LHR: "London", LGW: "London", STN: "London",
  CDG: "Paris", ORY: "Paris",
  FCO: "Rome", MXP: "Milan",
  BCN: "Barcelona", MAD: "Madrid",
  AMS: "Amsterdam", FRA: "Frankfurt", MUC: "Munich",
  ZRH: "Zurich", VIE: "Vienna", CPH: "Copenhagen",
  DUB: "Dublin", LIS: "Lisbon", ATH: "Athens",
  ICN: "Seoul", HKG: "Hong Kong", SIN: "Singapore",
  BKK: "Bangkok", SYD: "Sydney", MEL: "Melbourne", AKL: "Auckland",
  MEX: "Mexico City", CUN: "Cancún", GRU: "São Paulo",
  BOG: "Bogotá", LIM: "Lima", SCL: "Santiago",
  YYZ: "Toronto", YVR: "Vancouver", YUL: "Montreal",
  DXB: "Dubai", DOH: "Doha", TLV: "Tel Aviv",
  CAI: "Cairo", JNB: "Johannesburg", CPT: "Cape Town",
};

// ── US state abbreviations ──
const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
  "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
  "TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

// ── Address parsing (for Amtrak) ──
function extractCityFromAmtrakAddress(address) {
  if (!address) return null;
  const parts = address.split(",").map(p => p.trim());
  const cityStateZip = parts[parts.length - 1];
  if (!cityStateZip) return null;

  const match = cityStateZip.match(/^(.+?)\s+([A-Z]{2})\s+\d{5}(-\d{4})?$/);
  if (match) return match[1].trim();

  const noZip = cityStateZip.match(/^(.+?)\s+([A-Z]{2})$/);
  if (noZip && US_STATES.has(noZip[2])) return noZip[1].trim();

  return cityStateZip.replace(/\s+\d{5}(-\d{4})?$/, "").trim() || null;
}

// ── Flighty description parsing ──
/**
 * Extract destination city from Flighty's event description.
 * The description contains a line like "New York to San Francisco".
 * We want the destination (second city).
 */
function extractDestCityFromFlightyDesc(description) {
  if (!description) return null;

  // Look for "CityA to CityB" pattern
  // This line appears after the airline + flight number line
  const match = description.match(/^(.+?)\s+to\s+(.+)$/m);
  if (match) {
    return match[2].trim();
  }
  return null;
}

/**
 * Extract origin city from Flighty's event description.
 */
function extractOriginCityFromFlightyDesc(description) {
  if (!description) return null;
  const match = description.match(/^(.+?)\s+to\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  return null;
}

// ── Parse a single calendar event into a travel leg ──
function parseEvent(event) {
  // Strip zero-width characters (U+200B, U+200C, U+200D, U+FEFF) from title
  // Flighty embeds zero-width spaces around the arrow: "DCA​→​LAX"
  const title = (event.summary || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  const location = event.location || "";
  const description = event.description || "";
  const start = event.start?.date || event.start?.dateTime?.split("T")[0];
  const end = event.end?.date || event.end?.dateTime?.split("T")[0];

  if (!start || !end) return null;

  let city = null;
  let originCity = null;
  let mode = "flight";

  // ── Flighty events ──
  // Title format: "✈ DCA→LAX • AA 3283" (after stripping zero-width chars)
  // Match any 3-letter airport code pair separated by arrow-like characters
  const flightyMatch = title.match(/([A-Z]{3})\s*[\u2192\u2794\u279D\u27A1→➔➝\->]+\s*([A-Z]{3})/);

  // Detect Flighty events by: has airport codes in title + either has description keywords
  // OR location contains "Intl" / "Airport" / "National" (Flighty puts departure airport in location)
  const hasFlightyDesc = description.includes("Flight time") || description.includes("Booking Code");
  const hasAirportLocation = /intl|airport|national|terminal/i.test(location);
  const isFlighty = flightyMatch && (hasFlightyDesc || hasAirportLocation);

  if (isFlighty) {
    const originCode = flightyMatch[1];
    const destCode = flightyMatch[2];

    // Prefer city names from description (more readable)
    city = extractDestCityFromFlightyDesc(description);
    originCity = extractOriginCityFromFlightyDesc(description);

    // Fallback to airport code lookup
    if (!city) city = AIRPORT_CITIES[destCode] || destCode;
    if (!originCity) originCity = AIRPORT_CITIES[originCode] || originCode;

    mode = "flight";

    return {
      id: event.id,
      city,          // destination city
      originCity,    // origin city
      region: "",
      start,
      end,
      mode,
      _legType: "flighty",
    };
  }

  // ── Amtrak app events ──
  // Title: "Amtrak: 152 Northeast Regional"
  const isAmtrakApp = /^amtrak:\s*\d+/i.test(title);
  if (isAmtrakApp) {
    city = extractCityFromAmtrakAddress(location);
    mode = "train";
    if (city) {
      return {
        id: event.id,
        city,
        originCity: null,
        region: location,
        start,
        end,
        mode,
        _legType: "amtrak",
      };
    }
  }

  // ── Manual patterns ──

  // "Flight to [City]"
  const flightTo = title.match(/(?:flight|fly|flying)\s+to\s+(.+)/i);
  if (flightTo) { city = flightTo[1].trim(); mode = "flight"; }

  // "Train to [City]"
  if (!city) {
    const trainTo = title.match(/(?:amtrak|train)\s+to\s+(.+)/i);
    if (trainTo) { city = trainTo[1].trim(); mode = "train"; }
  }

  // "ABC → DEF" airport codes (non-Flighty, no description)
  if (!city) {
    const codeMatch = title.match(/([A-Z]{3})\s*[\u2192\u2794\u279D\u27A1→➔➝\-\->–]+\s*([A-Z]{3})/);
    if (codeMatch) {
      city = AIRPORT_CITIES[codeMatch[2]] || codeMatch[2];
      originCity = AIRPORT_CITIES[codeMatch[1]] || codeMatch[1];
      mode = "flight";
    }
  }

  // "[City] Trip" or "Trip to [City]"
  if (!city) {
    const tripMatch = title.match(/(?:trip\s+to\s+(.+)|(.+?)\s+trip)/i);
    if (tripMatch) city = (tripMatch[1] || tripMatch[2]).trim();
  }

  if (mode !== "train" && /amtrak|train/i.test(title)) mode = "train";
  if (/drive|driving|road\s*trip/i.test(title)) mode = "drive";

  if (!city) return null;
  city = city.replace(/[.!?]$/, "").trim();

  return {
    id: event.id,
    city,
    originCity: originCity || null,
    region: location || "",
    start,
    end,
    mode,
    _legType: "manual",
  };
}

// ── Home city matching ──
function buildHomeCityVariants(homeCity) {
  const base = homeCity.toLowerCase().trim();
  const variants = new Set([base]);
  const aliases = {
    arlington: ["washington", "washington dc", "washington d.c."],
    washington: ["washington dc", "washington d.c.", "arlington"],
    "washington dc": ["washington", "washington d.c.", "arlington"],
    "new york": ["new york city", "nyc", "manhattan"],
    "los angeles": ["la"],
    "san francisco": ["sf"],
    philadelphia: ["philly"],
  };
  if (aliases[base]) aliases[base].forEach(a => variants.add(a));
  return variants;
}

function isHomeCity(city, homeVariants) {
  if (!city) return false;
  return homeVariants.has(city.toLowerCase().trim());
}

/**
 * ── Unified trip merger ──
 *
 * Takes all parsed legs (flights, trains, manual) and merges them into trips.
 *
 * Logic:
 *   1. Process legs chronologically
 *   2. A "trip" starts when you leave home and ends when you return
 *   3. Consecutive legs within 1 day of each other are part of the same trip
 *   4. For Amtrak: paired legs get merged (non-home city = destination)
 *   5. For Flighty: we know origin + destination cities from the description
 *   6. The "current city" of a trip is the last non-home destination
 *
 * Example: Train DC→NYC (May 8), Fly NYC→SFO (May 10), Fly SFO→DCA (May 14)
 *   → Trip 1: "New York" May 8 – May 10 (train)
 *   → Trip 2: "San Francisco" May 10 – May 14 (flight)
 *
 * But we actually want to show this as segments within one trip. The key insight:
 * a trip is "you're away from home." So we group everything from departure to return.
 */
function mergeLegsIntoTrips(legs, homeCity) {
  const homeVariants = buildHomeCityVariants(homeCity);
  const result = [];

  // Sort by start date
  const sorted = [...legs].sort((a, b) => a.start.localeCompare(b.start));

  let i = 0;
  while (i < sorted.length) {
    const leg = sorted[i];

    // For Amtrak legs: the city is the station address city (departure point)
    // For Flighty legs: we have both origin and destination
    // For manual legs: city is the destination

    // Is this a departure from home?
    const isLeavingHome =
      (leg._legType === "flighty" && isHomeCity(leg.originCity, homeVariants)) ||
      (leg._legType === "amtrak" && isHomeCity(leg.city, homeVariants)) ||
      (leg._legType === "manual" && !isHomeCity(leg.city, homeVariants));

    // Is this a return to home?
    const isReturningHome =
      (leg._legType === "flighty" && isHomeCity(leg.city, homeVariants)) ||
      (leg._legType === "amtrak" && isHomeCity(leg.city, homeVariants));

    // Determine the destination city for this leg
    let destCity = null;
    let destMode = leg.mode;

    if (leg._legType === "flighty") {
      destCity = isHomeCity(leg.city, homeVariants) ? null : leg.city;
    } else if (leg._legType === "amtrak") {
      destCity = isHomeCity(leg.city, homeVariants) ? null : leg.city;
    } else {
      destCity = leg.city;
    }

    // Try to build a complete trip by collecting consecutive legs
    const tripLegs = [leg];
    let j = i + 1;

    // Track whether we've been to a non-home destination yet
    let hasLeftHome = !isHomeCity(leg.city, homeVariants) ||
      (leg._legType === "flighty" && !isHomeCity(leg.city, homeVariants));
    let returnedHome = false;

    // For Amtrak: the first leg from home is a DEPARTURE, not a return
    // We only flag returnedHome when we see a home-city leg AFTER a non-home leg

    while (j < sorted.length && !returnedHome) {
      const nextLeg = sorted[j];
      const prevEnd = new Date(tripLegs[tripLegs.length - 1].end + "T00:00:00");
      const nextStart = new Date(nextLeg.start + "T00:00:00");
      const daysBetween = (nextStart - prevEnd) / (1000 * 60 * 60 * 24);

      if (daysBetween > 7) break; // Gap too large — separate trip

      // Determine if this next leg is a home-city leg
      const nextIsHome =
        (nextLeg._legType === "flighty" && isHomeCity(nextLeg.city, homeVariants)) ||
        (nextLeg._legType === "amtrak" && isHomeCity(nextLeg.city, homeVariants));
      const nextIsAway =
        (nextLeg._legType === "flighty" && !isHomeCity(nextLeg.city, homeVariants)) ||
        (nextLeg._legType === "amtrak" && !isHomeCity(nextLeg.city, homeVariants)) ||
        (nextLeg._legType === "manual");

      if (nextIsAway) hasLeftHome = true;

      tripLegs.push(nextLeg);

      // Only flag return if we've been somewhere and now we see a home leg
      if (nextIsHome && hasLeftHome) returnedHome = true;

      j++;
    }

    // Now extract the distinct destination segments from the collected legs
    const segments = [];
    let currentDest = null;
    let pendingDepartureDate = null; // Track when we left home

    for (const tl of tripLegs) {
      let tlDest = null;
      let tlMode = tl.mode;

      if (tl._legType === "flighty") {
        tlDest = isHomeCity(tl.city, homeVariants) ? null : tl.city;
      } else if (tl._legType === "amtrak") {
        tlDest = isHomeCity(tl.city, homeVariants) ? null : tl.city;
      } else {
        tlDest = tl.city;
      }

      if (!tlDest && !currentDest) {
        // Departing from home — remember the departure date
        pendingDepartureDate = tl.start;
      } else if (tlDest && tlDest !== currentDest) {
        // Arriving at a new destination
        if (currentDest && segments.length > 0) {
          // Close the previous segment at this leg's start
          segments[segments.length - 1].end = tl.start;
        }
        // Open a new segment — start from when we departed (or this leg's start)
        const segStart = pendingDepartureDate || tl.start;
        currentDest = tlDest;
        pendingDepartureDate = null;
        segments.push({
          city: tlDest,
          start: segStart,
          end: tl.end, // will be updated by subsequent legs
          mode: tlMode,
        });
      } else if (!tlDest && currentDest) {
        // Returning home — close the current segment at this leg's start
        // (you're "in" the destination until you board the return)
        segments[segments.length - 1].end = tl.start;
        currentDest = null;
        pendingDepartureDate = null;
      }
      // If tlDest === currentDest, we're still at the same destination — no action
    }

    // If only home legs (e.g., single Amtrak leg from home), skip
    if (segments.length === 0) {
      i = j;
      continue;
    }

    // Finalize segment end dates
    // If the last segment doesn't have a return leg, use its own end date
    // or the last leg's end date
    if (segments.length > 0) {
      const lastLeg = tripLegs[tripLegs.length - 1];
      const lastSeg = segments[segments.length - 1];
      if (new Date(lastLeg.end) > new Date(lastSeg.end)) {
        lastSeg.end = lastLeg.end;
      }
    }

    // Add each segment as a separate trip for display
    for (const seg of segments) {
      result.push({
        id: tripLegs[0].id + "_" + seg.city,
        city: seg.city,
        region: "",
        start: seg.start,
        end: seg.end,
        mode: seg.mode,
      });
    }

    i = j;
  }

  return result;
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
  arlington: { lat: 38.8816, lng: -77.091 },
  amsterdam: { lat: 52.3676, lng: 4.9041 },
  barcelona: { lat: 41.3851, lng: 2.1734 },
  rome: { lat: 41.9028, lng: 12.4964 },
  madrid: { lat: 40.4168, lng: -3.7038 },
  seoul: { lat: 37.5665, lng: 126.978 },
  singapore: { lat: 1.3521, lng: 103.8198 },
  sydney: { lat: -33.8688, lng: 151.2093 },
  "hong kong": { lat: 22.3193, lng: 114.1694 },
  toronto: { lat: 43.6532, lng: -79.3832 },
  vancouver: { lat: 49.2827, lng: -123.1207 },
  montreal: { lat: 45.5017, lng: -73.5673 },
  "mexico city": { lat: 19.4326, lng: -99.1332 },
  orlando: { lat: 28.5383, lng: -81.3792 },
  "san diego": { lat: 32.7157, lng: -117.1611 },
  phoenix: { lat: 33.4484, lng: -112.074 },
  minneapolis: { lat: 44.9778, lng: -93.265 },
  "salt lake city": { lat: 40.7608, lng: -111.891 },
  cancun: { lat: 21.1619, lng: -86.8515 },
  "cancún": { lat: 21.1619, lng: -86.8515 },
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
  nashville: { lat: 36.1627, lng: -86.7816 },
  charlotte: { lat: 35.2271, lng: -80.8431 },
  "fort lauderdale": { lat: 26.1224, lng: -80.1373 },
  dubai: { lat: 25.2048, lng: 55.2708 },
  dublin: { lat: 53.3498, lng: -6.2603 },
  lisbon: { lat: 38.7223, lng: -9.1393 },
  honolulu: { lat: 21.3069, lng: -157.8583 },
  bangkok: { lat: 13.7563, lng: 100.5018 },
  osaka: { lat: 34.6937, lng: 135.5023 },
  "tel aviv": { lat: 32.0853, lng: 34.7818 },
  zurich: { lat: 47.3769, lng: 8.5417 },
  copenhagen: { lat: 55.6761, lng: 12.5683 },
  vienna: { lat: 48.2082, lng: 16.3738 },
  munich: { lat: 48.1351, lng: 11.582 },
  milan: { lat: 45.4642, lng: 9.19 },
  athens: { lat: 37.9838, lng: 23.7275 },
  newark: { lat: 40.7357, lng: -74.1724 },
  oakland: { lat: 37.8044, lng: -122.2712 },
  "san jose": { lat: 37.3382, lng: -121.8863 },
  sacramento: { lat: 38.5816, lng: -121.4944 },
  "kansas city": { lat: 39.0997, lng: -94.5786 },
  "st. louis": { lat: 38.627, lng: -90.1994 },
  indianapolis: { lat: 39.7684, lng: -86.1581 },
  cleveland: { lat: 41.4993, lng: -81.6944 },
  cincinnati: { lat: 39.1031, lng: -84.512 },
  memphis: { lat: 35.1495, lng: -90.049 },
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

    // Debug mode: /api/trips?debug=1 shows raw events
    if (req.query && req.query.debug === "1") {
      const raw = events.map(e => ({
        summary: e.summary,
        location: e.location,
        description: e.description ? e.description.substring(0, 200) : null,
        start: e.start,
        end: e.end,
      }));
      return res.status(200).json({ ok: true, debug: true, event_count: events.length, events: raw });
    }

    // Parse all events into legs, then merge into trips
    const legs = events.map(parseEvent).filter(Boolean);
    let trips = mergeLegsIntoTrips(legs, homeCity);

    // Add coordinates
    trips = trips.map((trip) => {
      const coords = getCoords(trip.city);
      return { ...trip, lat: coords?.lat || null, lng: coords?.lng || null };
    });

    const home = {
      city: homeCity,
      region: process.env.HOME_REGION || "VA",
      lat: parseFloat(process.env.HOME_LAT) || 38.8816,
      lng: parseFloat(process.env.HOME_LNG) || -77.091,
    };

    res.status(200).json({ ok: true, home, trips, fetched_at: new Date().toISOString() });
  } catch (error) {
    console.error("Calendar API error:", error.message);
    res.status(500).json({ ok: false, error: "Failed to fetch calendar data", detail: error.message });
  }
}

module.exports = handler;
