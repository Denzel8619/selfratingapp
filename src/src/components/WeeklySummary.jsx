import { useState, useEffect } from 'react';
import { collection, getDocs, getDoc, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { getRuleGoalType, getRuleInputType } from './RulesEditor';

function toDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getCurrentWeekDays() {
  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dow === 0 ? 6 : dow - 1));
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
}

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function getGrade(avgScore) {
  if (avgScore >= 50) return { grade: 'S', color: '#ffd700', msg: 'LEGENDARY WEEK' };
  if (avgScore >= 30) return { grade: 'A', color: 'var(--positive)', msg: 'EXCELLENT WEEK' };
  if (avgScore >= 10) return { grade: 'B', color: 'var(--cyan)', msg: 'GOOD WEEK' };
  if (avgScore >= 0)  return { grade: 'C', color: 'var(--text)', msg: 'AVERAGE WEEK' };
  return { grade: 'D', color: 'var(--negative)', msg: 'NEEDS IMPROVEMENT' };
}

export default function WeeklySummary({ user }) {
  const [days, setDays]       = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const weekDays = getCurrentWeekDays();
      const [rulesSnap, ...ratingSnaps] = await Promise.all([
        getDocs(collection(db, 'users', user.uid, 'rules')),
        ...weekDays.map(d => getDoc(doc(db, 'users', user.uid, 'ratings', toDateKey(d)))),
      ]);
      if (!mounted) return;

      const ruleMap = {};
      rulesSnap.docs.forEach(d => { ruleMap[d.id] = d.data(); });

      const dayData = weekDays.map((date, i) => {
        const snap = ratingSnaps[i];
        if (!snap.exists()) return { date, score: null, logged: false };
        const { dailyDone = {}, scores = {}, numericScores = {} } = snap.data();
        let score = 0;
        const src = Object.keys(dailyDone).length > 0 ? dailyDone : scores;
        Object.entries(src).forEach(([ruleId, val]) => {
          const rule = ruleMap[ruleId];
          if (!rule || getRuleGoalType(rule) === 'weekly' || getRuleInputType(rule) === 'numeric') return;
          if (rule.type === 'positive') score += val; else score -= val;
        });
        Object.values(numericScores).forEach(pts => { score += pts; });
        return { date, score, logged: true };
      });

      if (mounted) { setDays(dayData); setLoading(false); }
    }
    load();
    return () => { mounted = false; };
  }, [user.uid]);

  if (loading || days.length === 0) return null;

  const logged    = days.filter(d => d.logged);
  const total     = logged.reduce((s, d) => s + d.score, 0);
  const avgScore  = logged.length > 0 ? total / logged.length : 0;
  const { grade, color, msg } = getGrade(avgScore);
  const todayKey  = toDateKey(new Date());
  const now       = new Date(); now.setHours(0, 0, 0, 0);

  const mon = days[0]?.date;
  const sun = days[6]?.date;
  const range = mon && sun
    ? `${mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${sun.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : '';

  return (
    <div className="weekly-summary-card">
      <div className="ws-header">
        <div>
          <h3 className="section-label" style={{ marginBottom: '4px' }}>// THIS WEEK</h3>
          <span className="ws-range">{range}</span>
        </div>
        {logged.length > 0 && (
          <div className="ws-grade" style={{ color }}>
            <div className="ws-grade-letter">{grade}</div>
            <div className="ws-grade-msg">{msg}</div>
          </div>
        )}
      </div>

      <div className="ws-days">
        {days.map((d, i) => {
          const key      = toDateKey(d.date);
          const isToday  = key === todayKey;
          const dayStart = new Date(d.date); dayStart.setHours(0, 0, 0, 0);
          const isFuture = dayStart > now;
          const scoreStr = d.logged ? (d.score > 0 ? `+${d.score}` : String(d.score)) : (isFuture ? '' : '—');
          const scoreColor = !d.logged ? 'var(--muted)'
            : d.score > 0 ? 'var(--positive)'
            : d.score < 0 ? 'var(--negative)'
            : 'var(--muted)';
          return (
            <div key={i} className={`ws-day${isToday ? ' ws-today' : ''}${isFuture ? ' ws-future' : ''}`}>
              <div className="ws-day-name">{DAY_NAMES[i]}</div>
              <div className="ws-day-score" style={{ color: scoreColor }}>{scoreStr}</div>
            </div>
          );
        })}
      </div>

      {logged.length > 0 && (
        <div className="ws-totals">
          <span className="ws-total-label">WEEK TOTAL</span>
          <span className="ws-total-val" style={{ color: total >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
            {total > 0 ? `+${total}` : total} pts
          </span>
          <span className="ws-days-logged">{logged.length}/7 DAYS</span>
        </div>
      )}
    </div>
  );
}
