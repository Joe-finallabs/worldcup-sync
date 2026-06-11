// ============================================================
// World Cup 2026 Pick'em — results sync  (v2)
// Pulls fixtures + results from football-data.org, computes the per-day lock
// deadline (in a single reference timezone, stored as a UTC instant), and the
// 90-minute scoring fields, then upserts everything into `matches`.
//
// Env vars required:
//   FOOTBALL_DATA_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Node 18+ (built-in fetch + Intl with timezone support).
// ============================================================

import { createClient } from '@supabase/supabase-js';

// The single reference timezone that defines "what day a match belongs to".
// Everyone's picks for a given day lock 5 minutes before that day's first kickoff.
// Change this one line if you want a different anchor (e.g. 'Europe/London').
const REFERENCE_TZ = 'America/New_York';
const LOCK_LEAD_MINUTES = 5;

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!FOOTBALL_DATA_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing env: FOOTBALL_DATA_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const WC_URL = 'https://api.football-data.org/v4/competitions/WC/matches';

function mapPhase(stage) {
  return ({
    GROUP_STAGE:'GROUP', LAST_32:'R32', ROUND_OF_32:'R32', LAST_16:'R16', ROUND_OF_16:'R16',
    QUARTER_FINALS:'QF', SEMI_FINALS:'SF', THIRD_PLACE:'3RD', FINAL:'FINAL',
  })[stage] || 'GROUP';
}
function side(w) { return w==='HOME_TEAM'?'HOME':w==='AWAY_TEAM'?'AWAY':w==='DRAW'?'DRAW':null; }
function mapStatus(s) { return s==='FINISHED'?'FINISHED':(s==='IN_PLAY'||s==='PAUSED')?'IN_PLAY':'SCHEDULED'; }

// 'YYYY-MM-DD' for an instant, in the reference timezone
function refDay(iso) {
  return new Intl.DateTimeFormat('en-CA',
    { timeZone: REFERENCE_TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(iso));
}

// 90-minute scoring fields from a finished match.
// NB: football-data's fullTime is the score after extra time for ET matches; for
// penalty shootouts it is the (level) score after ET. Group games are pure 90-min.
// The admin screen can correct the rare extra-time game if you want strict 90-min.
function deriveResult(phase, score, status) {
  const out = { actual_home:null, actual_away:null, result_90:null, went_to_pens:false, advancing_team:null };
  if (status !== 'FINISHED' || !score) return out;
  const h = score.fullTime?.home, a = score.fullTime?.away;
  out.actual_home = (h ?? null);
  out.actual_away = (a ?? null);
  if (h != null && a != null) out.result_90 = h>a ? 'HOME' : h<a ? 'AWAY' : 'DRAW';
  out.went_to_pens = score.duration === 'PENALTY_SHOOTOUT';
  if (phase !== 'GROUP') out.advancing_team = side(score.winner); // who progressed
  return out;
}

async function run() {
  const res = await fetch(WC_URL, { headers: {
    'X-Auth-Token': FOOTBALL_DATA_TOKEN,
    'User-Agent': 'worldcup-pickem-sync',
    'Accept': 'application/json',
  } });
  if (!res.ok) throw new Error(`football-data.org ${res.status}: ${await res.text()}`);
  const { matches = [] } = await res.json();

  // First pass: build rows + remember each ref-day's earliest kickoff
  const firstKickoffByDay = {};
  const base = matches.map((m) => {
    const phase = mapPhase(m.stage);
    const status = mapStatus(m.status);
    const day = refDay(m.utcDate);
    const ms = new Date(m.utcDate).getTime();
    if (firstKickoffByDay[day] === undefined || ms < firstKickoffByDay[day]) firstKickoffByDay[day] = ms;
    // football-data gives e.g. "GROUP_A" for group matches; take the letter(s)
    const group_name = (m.group && /^GROUP_/.test(m.group)) ? m.group.replace('GROUP_','') : null;
    return {
      id: String(m.id), phase, group_name, match_day: day,
      home_team: m.homeTeam?.name || m.homeTeam?.shortName || 'TBD',
      away_team: m.awayTeam?.name || m.awayTeam?.shortName || 'TBD',
      kickoff_utc: m.utcDate, status,
      ...deriveResult(phase, m.score, status),
      updated_at: new Date().toISOString(),
    };
  });

  // Second pass: stamp the per-day lock deadline (first kickoff − lead minutes)
  let rows = base.map((r) => ({
    ...r,
    lock_at: new Date(firstKickoffByDay[r.match_day] - LOCK_LEAD_MINUTES*60000).toISOString(),
  }));

  // Don't clobber matches an admin has manually corrected. (They're finished, so their
  // schedule won't change anyway — safe to leave them entirely untouched by the sync.)
  const { data: overridden } = await supabase
    .from('matches').select('id').eq('manual_override', true);
  const skip = new Set((overridden || []).map((r) => r.id));
  const before = rows.length;
  rows = rows.filter((r) => !skip.has(r.id));

  const { error } = await supabase.from('matches').upsert(rows, { onConflict: 'id' });
  if (error) throw error;
  console.log(`Synced ${rows.length} matches across ${Object.keys(firstKickoffByDay).length} match-days `
    + `(${rows.filter(r=>r.status==='FINISHED').length} finished, ${before-rows.length} admin-locked skipped). `
    + `Knockout teams auto-fill as groups finish. Lock anchor: ${REFERENCE_TZ}.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
