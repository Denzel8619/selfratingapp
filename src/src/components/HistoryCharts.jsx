import { useState, useEffect } from 'react';
import { collection, getDocs, getDoc, setDoc, doc, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { getRuleGoalType, getRuleInputType } from './RulesEditor';
import WeeklySummary from './WeeklySummary';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';

// ── date helpers (local-time safe) ──────────────────────

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLastNWeekMondays(n) {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun
  const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dow === 0 ? 6 : dow - 1));
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - (n - 1 - i) * 7);
    return toDateKey(d);
  });
}

function getWeekDays(weekMonday) {
  const [y, m, d] = weekMonday.split('-').map(Number);
  return Array.from({ length: 7 }, (_, i) => toDateKey(new Date(y, m - 1, d + i)));
}

function isWeekFinalized(weekMonday) {
  const [y, m, d] = weekMonday.split('-').map(Number);
  // Finalized after Saturday 23:59:59 local time
  const saturday = new Date(y, m - 1, d + 5, 23, 59, 59, 999);
  return new Date() > saturday;
}

// ── heatmap helpers ──────────────────────────────────────

function heatColor(score) {
  if (score === undefined || score === null) return '#161a28';
  if (score === 0) return '#252938';
  if (score > 0) {
    const t = Math.min(score / 40, 1);
    return `rgba(0,255,127,${(0.2 + t * 0.65).toFixed(2)})`;
  }
  const t = Math.min(-score / 40, 1);
  return `rgba(255,32,85,${(0.2 + t * 0.65).toFixed(2)})`;
}

function buildHeatmapCells(heatmapData) {
  const today   = new Date();
  const dow     = today.getDay();
  const lastSun = new Date(today);
  lastSun.setDate(today.getDate() + (dow === 0 ? 0 : 7 - dow));
  lastSun.setHours(0, 0, 0, 0);
  const startMon = new Date(lastSun);
  startMon.setDate(lastSun.getDate() - 16 * 7 + 1);

  const todayKey = toDateKey(today);
  const cells = [];
  for (let week = 0; week < 16; week++) {
    for (let day = 0; day < 7; day++) {
      const d = new Date(startMon);
      d.setDate(startMon.getDate() + week * 7 + day);
      d.setHours(0, 0, 0, 0);
      const key  = toDateKey(d);
      const data = heatmapData[key];
      const isFuture = d > today;
      let label = key;
      if (data) {
        label += ` · ${data.score > 0 ? '+' : ''}${data.score} pts`;
        if (data.note) label += ` · "${data.note}"`;
      }
      cells.push({ key, score: data?.score, isFuture, isToday: key === todayKey, label });
    }
  }
  return cells;
}

// ── daily tooltip ─────────────────────────────────────────

function DailyTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const pos  = payload.find(p => p.dataKey === 'positive')?.value ?? 0;
  const neg  = payload.find(p => p.dataKey === 'negative')?.value ?? 0;
  const note = payload[0]?.payload?.note ?? '';
  const net  = pos - neg;
  return (
    <div className="daily-tooltip">
      <div className="dtt-header">
        <span className="dtt-date">{label}</span>
        <span className={`dtt-net ${net >= 0 ? 'pos' : 'neg'}`}>
          {net >= 0 ? '+' : ''}{net} pts
        </span>
      </div>
      <div className="dtt-scores">
        <span className="dtt-pos">+{pos} pos</span>
        <span className="dtt-neg">−{neg} neg</span>
      </div>
      {note && <div className="dtt-note">"{note}"</div>}
    </div>
  );
}

// ── weekly score formula ─────────────────────────────────
// Positive rule: over target → +35/extra,  under target → -56/missed
// Negative rule: under limit → +35/under,  over  limit → -56/extra
// "spread to 7 days" = 35 = 5×7, 56 = 8×7

function calcWeeklyScore(weeklyRules, completions) {
  return weeklyRules.reduce((total, rule) => {
    const done   = completions[rule.id] ?? 0;
    const target = rule.weeklyTarget ?? 3;
    const diff   = done - target; // positive = over, negative = under
    if (diff === 0) return total;
    if (rule.type === 'positive') {
      return total + (diff > 0 ? diff * 35 : diff * 56); // over=+35×n, under=-56×n
    } else {
      return total + (diff < 0 ? (-diff) * 35 : -diff * 56); // under=+35×n, over=-56×n
    }
  }, 0);
}

function ruleWeeklyPts(rule, done) {
  const target = rule.weeklyTarget ?? 3;
  const diff   = done - target;
  if (diff === 0) return 0;
  if (rule.type === 'positive') return diff > 0 ? diff * 35 : diff * 56;
  return diff < 0 ? (-diff) * 35 : -diff * 56;
}

// ── weekly tooltip ───────────────────────────────────────

function WeeklyTooltip({ active, payload, rulesMeta }) {
  if (!active || !payload?.length) return null;
  const { week, score, finalized, completions = {} } = payload[0].payload;
  return (
    <div className="weekly-tooltip">
      <div className="wtt-header">
        <span className="wtt-week">WK {week}</span>
        <span className={`wtt-score ${score >= 0 ? 'pos' : 'neg'}`}>
          {score > 0 ? `+${score}` : score} pts
        </span>
        {!finalized && <span className="wtt-live">LIVE</span>}
      </div>
      {rulesMeta.map(r => {
        const done  = completions[r.id] ?? 0;
        const pts   = ruleWeeklyPts(r, done);
        const diff  = done - r.target;
        let status, badge;
        if (diff === 0) {
          status = 'met';
          badge  = 'MET ✓';
        } else if (r.type === 'positive') {
          status = diff > 0 ? 'exceeded' : 'missed';
          badge  = diff > 0 ? `OVER +${pts}` : `MISS ${pts}`;
        } else {
          status = diff < 0 ? 'exceeded' : 'missed';
          badge  = diff < 0 ? `UNDER +${pts}` : `OVER ${pts}`;
        }
        return (
          <div key={r.id} className={`wtt-rule wtt-${status}`}>
            <span className="wtt-rule-name">{r.name}</span>
            <span className="wtt-rule-count">{done}/{r.target}</span>
            <span className="wtt-rule-badge">{badge}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── component ────────────────────────────────────────────

export default function HistoryCharts({ user }) {
  const [dailyData,   setDailyData]   = useState([]);
  const [weeklyData,  setWeeklyData]  = useState([]);
  const [rulesMeta,       setRulesMeta]       = useState([]);
  const [heatmapData,     setHeatmapData]     = useState({});
  const [awards,          setAwards]          = useState([]);
  const [hasWeekly,       setHasWeekly]       = useState(false);
  const [loading,         setLoading]         = useState(true);
  const [reminderTime,    setReminderTime]    = useState(() => localStorage.getItem('bt-reminder') ?? '');
  const [notifOn,         setNotifOn]         = useState(() => !!localStorage.getItem('bt-reminder'));
  const [notifPermission, setNotifPermission] = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  useEffect(() => {
    let mounted = true;
    async function load() {
      const [rulesSnap, ratingsSnap] = await Promise.all([
        getDocs(collection(db, 'users', user.uid, 'rules')),
        getDocs(query(
          collection(db, 'users', user.uid, 'ratings'),
          orderBy('date', 'desc'),
          limit(120),
        )),
      ]);
      if (!mounted) return;

      const ruleMap = {};
      rulesSnap.docs.forEach(d => { ruleMap[d.id] = d.data(); });
      const allRules    = rulesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const weeklyRules = allRules.filter(r => getRuleGoalType(r) === 'weekly' && !r.deleted && getRuleInputType(r) === 'count');
      if (mounted) {
        setHasWeekly(weeklyRules.length > 0);
        setRulesMeta(weeklyRules.map(r => ({ id: r.id, name: r.name, target: r.weeklyTarget ?? 3, type: r.type })));
      }

      // Build date → rating lookup for weekly calc
      const ratingsMap = {};
      ratingsSnap.docs.forEach(d => { ratingsMap[d.data().date] = d.data(); });

      // Build heatmap score map from all loaded ratings
      const scoreMap = {};
      ratingsSnap.docs.forEach(d => {
        const { date, dailyDone = {}, scores = {}, numericScores = {}, note = '' } = d.data();
        let s = 0;
        const src = Object.keys(dailyDone).length > 0 ? dailyDone : scores;
        Object.entries(src).forEach(([ruleId, val]) => {
          const rule = ruleMap[ruleId];
          if (!rule || getRuleGoalType(rule) === 'weekly' || getRuleInputType(rule) === 'numeric') return;
          if (rule.type === 'positive') s += val; else s -= val;
        });
        Object.values(numericScores).forEach(pts => { s += pts; });
        scoreMap[date] = { score: s, note };
      });
      if (mounted) setHeatmapData(scoreMap);

      // Compute Positive Launcher awards (5 consecutive days ≥ +40 in a week)
      const earnedAwards = [];
      getLastNWeekMondays(8).forEach(weekMonday => {
        const dayScores = getWeekDays(weekMonday).map(d => scoreMap[d]?.score);
        for (let start = 0; start <= 2; start++) {
          if (dayScores.slice(start, start + 5).every(s => s !== undefined && s >= 40)) {
            earnedAwards.push({ weekStart: weekMonday, label: weekMonday.slice(5) });
            break;
          }
        }
      });
      if (mounted) setAwards(earnedAwards);

      // Daily chart: last 30 logged days
      const daily = ratingsSnap.docs.slice(0, 30).map(d => {
        const { date, dailyDone = {}, scores = {}, numericScores = {}, note = '' } = d.data();
        let positive = 0, negative = 0;
        const src = Object.keys(dailyDone).length > 0 ? dailyDone : scores;
        Object.entries(src).forEach(([ruleId, score]) => {
          const rule = ruleMap[ruleId];
          if (!rule || getRuleGoalType(rule) === 'weekly' || getRuleInputType(rule) === 'numeric') return;
          if (rule.type === 'positive') positive += score;
          else negative += score;
        });
        Object.values(numericScores).forEach(pts => {
          if (pts > 0) positive += pts;
          else if (pts < 0) negative += -pts;
        });
        return { date: date.slice(5), positive, negative, note };
      }).reverse();
      if (mounted) setDailyData(daily);

      // Weekly scoring
      if (weeklyRules.length > 0) {
        const weekMondays = getLastNWeekMondays(8);

        const savedSnaps = await Promise.all(
          weekMondays.map(w => getDoc(doc(db, 'users', user.uid, 'weeklyScores', w)))
        );
        if (!mounted) return;

        const chart   = [];
        const saves   = [];

        for (let i = 0; i < weekMondays.length; i++) {
          const weekMonday = weekMondays[i];
          const snap       = savedSnaps[i];
          const finalized  = isWeekFinalized(weekMonday);
          const label      = weekMonday.slice(5); // MM-DD

          if (snap.exists()) {
            chart.push({ week: label, score: snap.data().totalWeeklyPoints, finalized, completions: snap.data().completions ?? {} });
            continue;
          }

          // Compute from daily ratings
          const completions = {};
          weeklyRules.forEach(r => { completions[r.id] = 0; });
          getWeekDays(weekMonday).forEach(day => {
            const rating = ratingsMap[day];
            if (!rating) return;
            const wd = rating.weeklyDone ?? {};
            weeklyRules.forEach(r => {
              completions[r.id] = (completions[r.id] ?? 0) + (wd[r.id] ?? 0);
            });
          });

          const score = calcWeeklyScore(weeklyRules, completions);
          chart.push({ week: label, score, finalized, completions });

          if (finalized) {
            saves.push(setDoc(
              doc(db, 'users', user.uid, 'weeklyScores', weekMonday),
              { weekStart: weekMonday, totalWeeklyPoints: score, completions, calculatedAt: new Date() }
            ));
          }
        }

        await Promise.all(saves);
        if (mounted) setWeeklyData(chart);
      }

      if (mounted) setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [user.uid]);

  // Schedule daily reminder notification
  useEffect(() => {
    if (!notifOn || !reminderTime || notifPermission !== 'granted') return;
    const [h, m] = reminderTime.split(':').map(Number);
    const now  = new Date();
    const fire = new Date();
    fire.setHours(h, m, 0, 0);
    if (fire <= now) fire.setDate(fire.getDate() + 1);
    const id = setTimeout(async () => {
      const todayStr = toDateKey(new Date());
      const snap = await getDoc(doc(db, 'users', user.uid, 'ratings', todayStr));
      if (!snap.exists()) {
        new Notification('Behavior Tracker', {
          body: "You haven't logged today — rate your day!",
          icon: '/icon-192.png',
        });
      }
    }, fire - now);
    return () => clearTimeout(id);
  }, [notifOn, reminderTime, notifPermission, user.uid]);

  const handleNotifToggle = async () => {
    if (!notifOn && notifPermission !== 'granted') {
      const perm = await Notification.requestPermission();
      setNotifPermission(perm);
      if (perm !== 'granted') return;
    }
    const next = !notifOn;
    setNotifOn(next);
    if (next) {
      const time = reminderTime || '21:00';
      setReminderTime(time);
      localStorage.setItem('bt-reminder', time);
    } else {
      localStorage.removeItem('bt-reminder');
    }
  };

  const handleTimeChange = val => {
    setReminderTime(val);
    if (notifOn) localStorage.setItem('bt-reminder', val);
  };

  if (loading) return <div className="loading-inner">LOADING...</div>;

  if (dailyData.length === 0 && weeklyData.length === 0) {
    return (
      <div className="empty-state" style={{ marginTop: '2rem' }}>
        <p>NO DATA YET.</p>
        <p>RATE A DAY TO SEE HISTORY.</p>
      </div>
    );
  }

  const totalPos     = dailyData.reduce((s, d) => s + d.positive, 0);
  const totalNeg     = dailyData.reduce((s, d) => s + d.negative, 0);
  const bestDay      = dailyData.length > 0
    ? dailyData.reduce((b, d) => d.positive - d.negative > b.positive - b.negative ? d : b, dailyData[0])
    : null;
  const totalWeekly  = weeklyData.filter(w => w.finalized).reduce((s, w) => s + w.score, 0);
  const goodWeeks    = weeklyData.filter(w => w.finalized && w.score > 0).length;
  const failWeeks    = weeklyData.filter(w => w.finalized && w.score < 0).length;

  const tooltipStyle = {
    background: '#0d0d1f', border: '2px solid #252545',
    color: '#c8c8ff', fontFamily: 'Orbitron', fontSize: '0.7rem',
  };
  const tickStyle = (size = 9) => ({ fontSize: size, fill: '#50508a', fontFamily: 'Orbitron' });

  return (
    <div className="history-charts">
      <h2>COMMAND ANALYTICS</h2>

      <WeeklySummary user={user} />

      {/* Daily stats */}
      {dailyData.length > 0 && (
        <div className="stats-row">
          <div className="stat-card positive-card">
            <div className="stat-value">{totalPos}</div>
            <div className="stat-label">DAILY POS</div>
          </div>
          <div className="stat-card negative-card">
            <div className="stat-value">{totalNeg}</div>
            <div className="stat-label">DAILY NEG</div>
          </div>
          <div className="stat-card neutral-card">
            <div className="stat-value">{bestDay ? bestDay.date : '--'}</div>
            <div className="stat-label">BEST DAY</div>
          </div>
        </div>
      )}

      {/* Weekly stats */}
      {hasWeekly && weeklyData.some(w => w.finalized) && (
        <div className="stats-row">
          <div className={`stat-card ${totalWeekly >= 0 ? 'weekly-card' : 'negative-card'}`}>
            <div className="stat-value">{totalWeekly > 0 ? `+${totalWeekly}` : totalWeekly}</div>
            <div className="stat-label">WEEKLY PTS</div>
          </div>
          <div className="stat-card weekly-card">
            <div className="stat-value">{goodWeeks}</div>
            <div className="stat-label">GOOD WKS</div>
          </div>
          <div className="stat-card negative-card">
            <div className="stat-value">{failWeeks}</div>
            <div className="stat-label">FAIL WKS</div>
          </div>
        </div>
      )}

      {/* Awards */}
      {awards.length > 0 && (
        <div className="awards-section">
          <h3 className="section-label">// AWARDS</h3>
          <div className="awards-list">
            {awards.map((award, i) => (
              <div key={i} className="award-badge">
                <span className="award-star">✦</span>
                <span className="award-rocket">🚀</span>
                <span className="award-star">✦</span>
                <div className="award-text">
                  <div className="award-name">POSITIVE LAUNCHER</div>
                  <div className="award-sub">5-DAY STREAK · WK {award.label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Heatmap */}
      <div className="chart-wrapper" style={{ marginBottom: '1rem' }}>
        <h3>// 16-WEEK ACTIVITY MAP</h3>
        {(() => {
          const cells = buildHeatmapCells(heatmapData);
          return (
            <>
              <div className="heatmap-wrap">
                <div className="heatmap-days">
                  {['M', '', 'W', '', 'F', '', 'S'].map((d, i) => <div key={i}>{d}</div>)}
                </div>
                <div className="heatmap-cells">
                  {cells.map((cell, i) => (
                    <div
                      key={i}
                      className={`heatmap-cell${cell.isFuture ? ' hm-future' : ''}${cell.isToday ? ' hm-today' : ''}`}
                      style={{ background: cell.isFuture ? 'transparent' : heatColor(cell.score) }}
                      title={cell.label}
                    />
                  ))}
                </div>
              </div>
              <div className="heatmap-legend">
                <span className="hm-legend-label">NEG</span>
                {[-30, -10, undefined, 10, 30].map((s, i) => (
                  <div key={i} className="heatmap-cell" style={{ background: heatColor(s) }} />
                ))}
                <span className="hm-legend-label">POS</span>
              </div>
            </>
          );
        })()}
      </div>

      {/* Daily chart */}
      {dailyData.length > 0 && (
        <div className="chart-wrapper" style={{ marginBottom: '1rem' }}>
          <h3>// DAILY SCORE CHART</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={dailyData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#252545" />
              <XAxis dataKey="date" tick={tickStyle()} />
              <YAxis tick={tickStyle()} />
              <Tooltip content={<DailyTooltip />} cursor={{ fill: 'rgba(0,229,255,0.05)' }} />
              <Legend wrapperStyle={{ fontFamily: 'Orbitron', fontSize: '0.65rem', color: '#50508a' }} />
              <Bar dataKey="positive" name="Positive" fill="#00ff7f" />
              <Bar dataKey="negative" name="Negative" fill="#ff2055" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Weekly chart */}
      {hasWeekly && weeklyData.length > 0 && (
        <div className="chart-wrapper">
          <h3>// WEEKLY MISSION SCORE</h3>
          <p className="chart-note">FINALIZED SAT 23:59</p>

          {/* Score illustration */}
          <div className="weekly-score-legend">
            <div className="wsl-row">
              <div className="wsl-bar wsl-bar-green" />
              <div className="wsl-info">
                <div className="wsl-head">GREEN — UNDER TARGET</div>
                <div className="wsl-body">
                  Each missed count adds +35 pts<br />
                  e.g. target 3, done 1 → (3−1)×35 = <span style={{ color: 'var(--positive)' }}>+70 pts</span>
                </div>
              </div>
            </div>
            <div className="wsl-row">
              <div className="wsl-bar wsl-bar-red" />
              <div className="wsl-info">
                <div className="wsl-head">RED — OVER TARGET</div>
                <div className="wsl-body">
                  Flat penalty of −56 pts per rule<br />
                  e.g. target 3, done 5 → <span style={{ color: 'var(--negative)' }}>−56 pts</span>
                </div>
              </div>
            </div>
            <div className="wsl-note">SCORE 0 = PERFECT WEEK — ALL TARGETS MET EXACTLY</div>
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={weeklyData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#252545" />
              <XAxis dataKey="week" tick={tickStyle()} />
              <YAxis tick={tickStyle()} />
              <ReferenceLine y={0} stroke="#3a3a6a" strokeWidth={2} />
              <Tooltip
                content={<WeeklyTooltip rulesMeta={rulesMeta} />}
                cursor={{ fill: 'rgba(0,229,255,0.05)' }}
              />
              <Bar dataKey="score" name="Weekly Score">
                {weeklyData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.score >= 0
                      ? (entry.finalized ? '#00ff7f' : 'rgba(0,255,127,0.4)')
                      : (entry.finalized ? '#ff2055' : 'rgba(255,32,85,0.4)')
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="chart-legend-note">FADED BAR = CURRENT WEEK IN PROGRESS</p>
        </div>
      )}

      {/* Daily reminder */}
      <div className="reminder-section">
        <h3 className="section-label">// DAILY REMINDER</h3>
        {notifPermission === 'denied' ? (
          <p className="reminder-blocked">NOTIFICATIONS BLOCKED — ENABLE IN BROWSER SETTINGS</p>
        ) : (
          <div className="reminder-row">
            <span className="reminder-label">REMIND AT</span>
            <input
              type="time"
              className="reminder-time-input"
              value={reminderTime}
              onChange={e => handleTimeChange(e.target.value)}
              disabled={!notifOn}
            />
            <button
              className={`reminder-toggle${notifOn ? ' on' : ''}`}
              onClick={handleNotifToggle}
            >
              {notifOn ? '[ ON ]' : '[ OFF ]'}
            </button>
          </div>
        )}
        {notifOn && notifPermission === 'granted' && reminderTime && (
          <p className="reminder-info">WILL ALERT IF YOU HAVEN'T LOGGED BY {reminderTime}</p>
        )}
      </div>
    </div>
  );
}
