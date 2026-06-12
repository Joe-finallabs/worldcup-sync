// ============================================================
// World Cup 2026 Pick'em — results sync  (v4: API-Football is the results source)
//
// STRUCTURE: football-data.org — fixtures, groups, kickoff times, match IDs
//            (the IDs your picks reference). It does NOT drive scores anymore.
// RESULTS:   API-Football — live AND final scores, penalties, who advanced.
//            One call to the full WC fixture list (covers in-play + finished),
//            made only while there is a started-but-not-yet-final match, so we
//            stay well under API-Football's free 100 requests/day.
//
// Env: FOOTBALL_DATA_TOKEN, APIFOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Node 22+.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const REFERENCE_TZ = 'America/New_York';
const LOCK_LEAD_MINUTES = 5;
const AF_LEAGUE_ID = 1;     // FIFA World Cup
const AF_SEASON = 2026;

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
const refDay = (iso) => new Intl.DateTimeFormat('en-CA',
  { timeZone: REFERENCE_TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(iso));

// cross-provider team-name matching
function norm(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z]/g,''); }
const ALIAS = {
  korearepublic:'southkorea', republicofkorea:'southkorea', koreasouth:'southkorea',
  unitedstates:'usa', us:'usa', cotedivoire:'ivorycoast', iriran:'iran', iranislamicrepublic:'iran',
  czechrepublic:'czechia', turkiye:'turkey', capeverdeislands:'capeverde', drcongo:'congodr',
};
const canon = (name) => { const n = norm(name); return ALIAS[n] || n; };

// API-Football status short code -> our status
function afStatus(short) {
  if (['FT','AET','PEN'].includes(short)) return 'FINISHED';
  if (['1H','2H','HT','ET','BT','P','LIVE','INT','SUSP'].includes(short)) return 'IN_PLAY';
  return 'SCHEDULED';
}

async function run() {
  const now = Date.now();

  // ---------- 0. existing statuses (to preserve finals / respect admin) ----------
  const { data: existing } = await supabase.from('matches').select('id,status,manual_override');
  const finishedIds  = new Set((existing||[]).filter(r=>r.status==='FINISHED').map(r=>r.id));
  const overriddenIds= new Set((existing||[]).filter(r=>r.manual_override).map(r=>r.id));

  // ---------- 1. football-data: fixture STRUCTURE only ----------
  const res = await fetch(WC_URL, { headers: {
    'X-Auth-Token': FOOTBALL_DATA_TOKEN, 'User-Agent': 'worldcup-pickem-sync', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`football-data.org ${res.status}: ${await res.text()}`);
  const { matches = [] } = await res.json();

  const firstKickoffByDay = {};
  const rows = matches.map((m) => {
    const day = refDay(m.utcDate);
    const ms = new Date(m.utcDate).getTime();
    if (firstKickoffByDay[day] === undefined || ms < firstKickoffByDay[day]) firstKickoffByDay[day] = ms;
    const group_name = (m.group && /^GROUP_/.test(m.group)) ? m.group.replace('GROUP_','') : null;
    return {
      id: String(m.id), phase: mapPhase(m.stage), group_name, match_day: day,
      home_team: m.homeTeam?.name || m.homeTeam?.shortName || 'TBD',
      away_team: m.awayTeam?.name || m.awayTeam?.shortName || 'TBD',
      kickoff_utc: m.utcDate,
      status: 'SCHEDULED', actual_home: null, actual_away: null,
      result_90: null, went_to_pens: false, advancing_team: null,
      updated_at: new Date().toISOString(),
    };
  });
  rows.forEach((r) => { r.lock_at = new Date(firstKickoffByDay[r.match_day] - LOCK_LEAD_MINUTES*60000).toISOString(); });

  // ---------- 2. results from API-Football (only if something needs finalising) ----------
  // Trigger when any match has kicked off but isn't FINISHED yet in our DB.
  const needsResults = rows.some((r) =>
    new Date(r.kickoff_utc).getTime() <= now && !finishedIds.has(r.id) && !overriddenIds.has(r.id));
  const afUpdated = new Set();
  let afCount = 0, afFinal = 0, afLiveN = 0;

  if (needsResults && APIFOOTBALL_KEY) {
    try {
      const af = await fetch(`https://v3.football.api-sports.io/fixtures?league=${AF_LEAGUE_ID}&season=${AF_SEASON}`,
        { headers: { 'x-apisports-key': APIFOOTBALL_KEY } });
      if (af.ok) {
        const data = await af.json();
        for (const fx of (data.response || [])) {
          const st = afStatus(fx.fixture?.status?.short);
          if (st === 'SCHEDULED') continue;
          afCount++;
          const d = (fx.fixture?.date || '').slice(0,10);
          const hn = canon(fx.teams?.home?.name), an = canon(fx.teams?.away?.name);
          const row = rows.find((r) => (r.kickoff_utc||'').slice(0,10) === d
            && canon(r.home_team) === hn && canon(r.away_team) === an);
          if (!row) continue;
          const gh = fx.goals?.home, ga = fx.goals?.away;
          row.status = st;
          if (gh != null && ga != null) {
            row.actual_home = gh; row.actual_away = ga;
            row.result_90 = gh>ga ? 'HOME' : gh<ga ? 'AWAY' : 'DRAW';
          }
          if (st === 'FINISHED') {
            afFinal++;
            row.went_to_pens = fx.fixture?.status?.short === 'PEN';
            if (row.phase !== 'GROUP') {
              row.advancing_team = fx.teams?.home?.winner ? 'HOME' : fx.teams?.away?.winner ? 'AWAY' : null;
            }
          } else { afLiveN++; }
          afUpdated.add(row.id);
        }
      } else {
        console.error('API-Football returned', af.status, (await af.text()).slice(0,200));
      }
    } catch (e) { console.error('Results fetch failed (non-fatal):', e.message); }
  }

  // ---------- 3. upsert ----------
  // Skip admin-overridden matches, and skip already-FINISHED matches that AF didn't
  // refresh this run (so we never overwrite a final with football-data's SCHEDULED).
  const toWrite = rows.filter((r) =>
    !overriddenIds.has(r.id) && !(finishedIds.has(r.id) && !afUpdated.has(r.id)));

  const { error } = await supabase.from('matches').upsert(toWrite, { onConflict: 'id' });
  if (error) throw error;
  console.log(`Synced ${toWrite.length} rows. Needs-results: ${needsResults}, AF used: ${needsResults && !!APIFOOTBALL_KEY}, `
    + `AF matches seen: ${afCount} (live ${afLiveN}, final ${afFinal}), overlaid: ${afUpdated.size}.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
