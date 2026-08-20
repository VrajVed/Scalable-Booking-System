import postgres from "postgres";

// Seeds one venue/event with enough available seats to run a real POST
// /bookings load test against the reservation endpoint (not the fake
// /bookings/nonexistent path used for raw-throughput LB tests) without every
// request past the first few thousand 409-ing on an already-held seat.
// Sized for the ~13k rps baseline established in tonight's autocannon runs:
// 100 sections * 100 rows * 40 seats = 400,000 seats covers ~30s sustained
// at 13k rps. Bulk-inserted via generate_series (single statement) instead
// of one row per Drizzle insert — 400k individual inserts would take
// minutes; this takes well under a second.
// Idempotent: reuses the venue/event if SEED_EVENT_NAME already exists, and
// ON CONFLICT DO NOTHING on seats means reruns are a safe no-op.

const SECTIONS = 100;
const ROWS = 100;
const SEATS_PER_ROW = 40;
const VENUE_NAME = "Load Test Arena";
const EVENT_NAME = "Load Test Event";

const client = postgres(process.env.DATABASE_URL!, { max: 5, connect_timeout: 5 });

try {
  const [venue] = await client`
    INSERT INTO venues (name, city)
    SELECT ${VENUE_NAME}, 'Test City'
    WHERE NOT EXISTS (SELECT 1 FROM venues WHERE name = ${VENUE_NAME})
    RETURNING id
  `;
  const venueId =
    venue?.id ?? (await client`SELECT id FROM venues WHERE name = ${VENUE_NAME}`)[0].id;

  const [event] = await client`
    INSERT INTO events (venue_id, name, starts_at)
    SELECT ${venueId}, ${EVENT_NAME}, now() + interval '30 days'
    WHERE NOT EXISTS (SELECT 1 FROM events WHERE name = ${EVENT_NAME})
    RETURNING id
  `;
  const eventId =
    event?.id ?? (await client`SELECT id FROM events WHERE name = ${EVENT_NAME}`)[0].id;

  const result = await client`
    INSERT INTO seats (event_id, section, row_label, seat_number)
    SELECT ${eventId}, 'S' || sec, 'R' || row_n, seat_n
    FROM generate_series(1, ${SECTIONS}) AS sec
    CROSS JOIN generate_series(1, ${ROWS}) AS row_n
    CROSS JOIN generate_series(1, ${SEATS_PER_ROW}) AS seat_n
    ON CONFLICT DO NOTHING
  `;

  console.log(`venue id=${venueId} (${VENUE_NAME})`);
  console.log(`event id=${eventId} (${EVENT_NAME})`);
  console.log(`seats inserted: ${result.count} (target ${SECTIONS * ROWS * SEATS_PER_ROW})`);
  console.log(`seat id range: use SELECT min(id), max(id) FROM seats WHERE event_id = ${eventId}`);
} finally {
  await client.end();
}
