/**
 * test-parser.js — Verify Amtrak parsing against real calendar data
 * Run: node test-parser.js
 */

// Inline the parsing functions for testing (in production these come from trips.js)
const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
  "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
  "TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

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

function buildHomeCityVariants(homeCity) {
  const base = homeCity.toLowerCase().trim();
  const variants = new Set([base]);
  const aliases = {
    arlington: ["washington", "washington dc", "washington d.c."],
    washington: ["washington dc", "washington d.c.", "arlington"],
    "washington dc": ["washington", "washington d.c.", "arlington"],
  };
  if (aliases[base]) aliases[base].forEach(a => variants.add(a));
  return variants;
}

// ── Test Cases ──

console.log("=== Address Parsing ===\n");

const addressTests = [
  {
    input: "50 Massachusetts Avenue NE , Washington DC 20002-4214",
    expected: "Washington",
  },
  {
    input: "351 West 31st Street , New York NY 10001",
    expected: "New York",
  },
  {
    input: "30th Street Station , Philadelphia PA 19104",
    expected: "Philadelphia",
  },
  {
    input: "128 Main Street , Boston MA 02101",
    expected: "Boston",
  },
  {
    input: "100 S Charles St , Baltimore MD 21201",
    expected: "Baltimore",
  },
  {
    input: "1 Park Avenue , New Haven CT 06511",
    expected: "New Haven",
  },
  {
    input: "800 N Capitol St NW , Washington DC 20002",
    expected: "Washington",
  },
];

let passed = 0;
let failed = 0;

for (const test of addressTests) {
  const result = extractCityFromAmtrakAddress(test.input);
  const ok = result === test.expected;
  console.log(`${ok ? "✅" : "❌"} "${test.input}"`);
  console.log(`   Expected: "${test.expected}" | Got: "${result}"`);
  if (ok) passed++; else failed++;
}

console.log("\n=== Amtrak Leg Pairing ===\n");

// Simulate Kevin's real DC→NYC weekend trip
const mockLegs = [
  {
    id: "1",
    city: "Washington",
    region: "50 Massachusetts Avenue NE , Washington DC 20002-4214",
    start: "2026-03-28",
    end: "2026-03-28",
    mode: "train",
    _isAmtrakLeg: true,
  },
  {
    id: "2",
    city: "New York",
    region: "351 West 31st Street , New York NY 10001",
    start: "2026-03-29",
    end: "2026-03-29",
    mode: "train",
    _isAmtrakLeg: true,
  },
];

// Home city is Arlington, VA — but Amtrak departs from Washington DC stations
const homeVariants = buildHomeCityVariants("Arlington");
const destLeg = mockLegs.find(g => !homeVariants.has(g.city.toLowerCase().trim()));

if (destLeg && destLeg.city === "New York") {
  console.log("✅ Correctly identified destination as New York (home=Arlington, outbound=Washington)");
  console.log(`   Trip: ${mockLegs[0].start} → ${mockLegs[mockLegs.length - 1].end}`);
  passed++;
} else {
  console.log("❌ Failed to identify destination");
  console.log(`   Got: ${destLeg?.city || "null"}`);
  failed++;
}

// Verify Arlington ↔ Washington aliasing
const arlingtonVariants = buildHomeCityVariants("Arlington");
const aliasingOk =
  arlingtonVariants.has("arlington") &&
  arlingtonVariants.has("washington") &&
  arlingtonVariants.has("washington dc") &&
  !arlingtonVariants.has("new york");
if (aliasingOk) {
  console.log("✅ Arlington aliases include Washington and Washington DC");
  passed++;
} else {
  console.log("❌ Arlington aliasing is missing expected variants");
  failed++;
}

// Test one-way (single leg, not home)
const singleLeg = [
  {
    id: "3",
    city: "Boston",
    start: "2026-04-05",
    end: "2026-04-05",
    mode: "train",
    _isAmtrakLeg: true,
  },
];

const singleDest = singleLeg.find(g => !homeVariants.has(g.city.toLowerCase().trim()));
if (singleDest && singleDest.city === "Boston") {
  console.log("✅ Single Amtrak leg to Boston correctly identified");
  passed++;
} else {
  console.log("❌ Single leg test failed");
  failed++;
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
