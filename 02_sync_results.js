// ============================================================
// World Cup 2026 Pick'em — results sync  (v3: hybrid live)
//
// PRIMARY: football-data.org — canonical fixtures, groups, kickoff times,
//          penalties, final scores. Owns the match IDs (picks reference them).
// LIVE:    API-Football — ONLY called while a match is in its live window,
//          to overlay the current in-play score onto the matching row.
//          (Keeps us well under API-Football's free 100 requests/day.)
//
// Env vars:
//   FOOTBALL_DATA_TOKEN   - football-data.org key (required)
//   APIFOOTBALL_KEY       - API-Football / api-sports.io key (optional; enables live)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// Node 22+.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const REFERENCE_TZ = 'America/New_York';
const LOCK_LEAD_MINUTES = 5;
const LIVE_WINDOW_MIN = 150; // a match counts as "possibly live" up to 150 min after kickoff

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!FOOTBALL_DATA_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing env: FOOTBALL_DATA_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const WC_URL = 'https://api.football-data.org/v4/competitions/WC/matches';

function mapPhase(stage) {
  return ({ GROUP_STAGE:'GROUP', LAST_32:'R32', ROUND_OF_32:'R32', LAST_16:'R16', ROUND_OF_16:'R16',
    QUARTER_FINALS:'QF', SEMI_FINALS:'SF', THIRD_PLACE:'3RD', FINAL:'FINAL' })[stage] || 'GROUP';
}
const side = (w) => w==='HOME_TEAM'?'HOME':w==='AWAY_TEAM'?'AWAY':w==='DRAW'?'DRAW':null;
const mapStatus = (s) => s==='FINISHED'?'FINISHED':(s==='IN_PLAY'||s==='PAUSED')?'IN_PLAY':'SCHEDULED';
const refDay = (iso) => new Intl.DateTimeFormat('en-CA',
  { timeZone: REFERENCE_TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(iso));

function deriveResult(phase, score, status) {
  const out = { actual_home:null, actual_away:null, result_90:null, went_to_pens:false, advancing_team:null };
  if (!score) return out;
  if (status === 'IN_PLAY' || status === 'FINISHED') {
    const h = score.fullTime?.home, a = score.fullTime?.away;
    out.actual_home = (h ?? null); out.actual_away = (a ?? null);
    if (h != null && a != null) out.result_90 = h>a ? 'HOME' : h<a ? 'AWAY' : 'DRAW';
  }
  if (status === 'FINISHED') {
    out.went_to_pens = score.duration === 'PENALTY_SHOOTOUT';
    if (phase !== 'GROUP') out.advancing_team = side(score.winner);
  }
  return out;
}

// ---- cross-provider team-name matching (football-data <-> API-Football) ----
function norm(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z]/g,''); }
const ALIAS = {
  korearepublic:'southkorea', republicofkorea:'southkorea', koreasouth:'southkorea',
  unitedstates:'usa', us:'usa', cotedivoire:'ivorycoast', iriran:'iran', iranislamicrepublic:'iran',
  czechrepublic:'czechia', turkiye:'turkey', capeverdeislands:'capeverde', drcongo:'congodr',
};
const canon = (name) => { const n = norm(name); return ALIAS[n] || n; };

async function run() {
  // ---------- 1. football-data: canonical pull ----------
  const res = await fetch(WC_URL, { headers: {
    'X-Auth-Token': FOOTBALL_DATA_TOKEN, 'User-Agent': 'worldcup-pickem-sync', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`football-data.org ${res.status}: ${await res.text()}`);
  const { matches = [] } = await res.json();

  const firstKickoffByDay = {};
  const base = matches.map((m) => {
    const phase = mapPhase(m.stage);
    const status = mapStatus(m.status);
    const day = refDay(m.utcDate);
    const ms = new Date(m.utcDate).getTime();
    if (firstKickoffByDay[day] === undefined || ms < firstKickoffByDay[day]) firstKickoffByDay[day] = ms;
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
  let rows = base.map((r) => ({
    ...r, lock_at: new Date(firstKickoffByDay[r.match_day] - LOCK_LEAD_MINUTES*60000).toISOString(),
  }));

  // ---------- 2. live overlay (only during a live window) ----------
  const now = Date.now();
  const liveWindow = rows.some((r) => r.status !== 'FINISHED'
    && new Date(r.kickoff_utc).getTime() <= now
    && now <= new Date(r.kickoff_utc).getTime() + LIVE_WINDOW_MIN*60000);
  let overlaid = 0;
  if (liveWindow && APIFOOTBALL_KEY) {
    try {
      const af = await fetch('https://v3.football.api-sports.io/fixtures?league=1&season=2026&live=all',
        { headers: { 'x-apisports-key': APIFOOTBALL_KEY } });
      if (af.ok) {
        const data = await af.json();
        for (const fx of (data.response || [])) {
          const d = (fx.fixture?.date || '').slice(0,10);
          const hn = canon(fx.teams?.home?.name), an = canon(fx.teams?.away?.name);
          const gh = fx.goals?.home, ga = fx.goals?.away;
          const row = rows.find((r) => (r.kickoff_utc || '').slice(0,10) === d
            && canon(r.home_team) === hn && canon(r.away_team) === an);
          if (row && gh != null && ga != null && row.status !== 'FINISHED') {
            row.status = 'IN_PLAY'; row.actual_home = gh; row.actual_away = ga;
            row.result_90 = gh>ga ? 'HOME' : gh<ga ? 'AWAY' : 'DRAW';
            overlaid++;
          }
        }
      } else {
        console.error('API-Football returned', af.status, await af.text());
      }
    } catch (e) { console.error('Live overlay failed (non-fatal):', e.message); }
  }

  // ---------- 3. don't clobber admin-corrected matches, then upsert ----------
  const { data: overridden } = await supabase.from('matches').select('id').eq('manual_override', true);
  const skip = new Set((overridden || []).map((r) => r.id));
  const before = rows.length;
  rows = rows.filter((r) => !skip.has(r.id));

  const { error } = await supabase.from('matches').upsert(rows, { onConflict: 'id' });
  if (error) throw error;
  console.log(`Synced ${rows.length} matches (${rows.filter(r=>r.status==='FINISHED').length} finished, `
    + `${before-rows.length} admin-locked skipped). Live window: ${liveWindow}, live scores overlaid: ${overlaid}.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
