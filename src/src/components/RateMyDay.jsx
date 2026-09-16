import { useState, useEffect } from 'react';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../firebase';
import { getRuleGoalType, getRuleInputType } from './RulesEditor';

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function getWeekDaysForDate(date) {
  const dow = date.getDay();
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - (dow === 0 ? 6 : dow - 1));
  return Array.from({ length: 7 }, (_, i) =>
    localDateKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))
  );
}

function computeNumericPoints(value, rule) {
  const v = parseFloat(value);
  if (value === '' || value === null || value === undefined || isNaN(v)) return 0;

  if (rule.gradientTiers?.length > 0) {
    const tiers = [...rule.gradientTiers];
    if (rule.gradientDirection === 'higher') {
      tiers.sort((a, b) => b.threshold - a.threshold);
      for (const t of tiers) { if (v >= t.threshold) return t.points; }
    } else {
      tiers.sort((a, b) => a.threshold - b.threshold);
      for (const t of tiers) { if (v <= t.threshold) return t.points; }
    }
    return 0;
  }

  if (rule.goodThreshold != null && v <= rule.goodThreshold) return rule.goodPoints ?? 10;
  if (rule.badThreshold  != null && v >= rule.badThreshold)  return rule.badPoints  ?? -10;
  return 0;
}

export default function RateMyDay({ user }) {
  const [targetDate, setTargetDate]       = useState(new Date());
  const [rules, setRules]                 = useState([]);
  const [dailyDone, setDailyDone]         = useState({});
  const [weeklyDone, setWeeklyDone]       = useState({});
  const [weekTotals, setWeekTotals]       = useState({});
  const [numericValues, setNumericValues] = useState({});
  const [note, setNote]                   = useState('');
  const [saving, setSaving]               = useState(false);
  const [saved, setSaved]                 = useState(false);
  const [loading, setLoading]             = useState(true);
  const [plan, setPlan]                   = useState([]);
  const [nudgeLoading, setNudgeLoading]   = useState(true);
  const [nudgeError, setNudgeError]       = useState(false);

  const dateKey  = localDateKey(targetDate);
  const weekDays = getWeekDaysForDate(targetDate);
  const isToday  = dateKey === localDateKey(new Date());

  // Fetch the AI coaching plan once when the screen loads. Independent of
  // the TODAY/YESTERDAY toggle above - it always refers to "today's" plan.
  useEffect(() => {
    let mounted = true;
    const dailyNudge = httpsCallable(functions, 'dailyNudge');
    dailyNudge({ todayKey: localDateKey(new Date()) })
      .then(res => { if (mounted) setPlan(res.data?.plan ?? []); })
      .catch(err => {
        console.error('Failed to load daily plan:', err);
        if (mounted) setNudgeError(true);
      })
      .finally(() => { if (mounted) setNudgeLoading(false); });
    return () => { mounted = false; };
  }, [user.uid]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const [rulesSnap, todaySnap] = await Promise.all([
        getDocs(collection(db, 'users', user.uid, 'rules')),
        getDoc(doc(db, 'users', user.uid, 'ratings', dateKey)),
      ]);
      if (!mounted) return;

      const loadedRules = rulesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setRules(loadedRules);

      const todayData = todaySnap.exists() ? todaySnap.data() : {};
      setDailyDone(todayData.dailyDone ?? {});
      setWeeklyDone(todayData.weeklyDone ?? {});
      setNumericValues(
        Object.fromEntries(
          Object.entries(todayData.numericValues ?? {}).map(([k, v]) => [k, String(v)])
        )
      );
      setNote(todayData.note ?? '');

      const countRules = loadedRules.filter(r => !r.deleted && getRuleInputType(r) === 'count');
      if (countRules.length > 0) {
        const snaps = await Promise.all(
          weekDays.map(d => getDoc(doc(db, 'users', user.uid, 'ratings', d)))
        );
        const totals = {};
        snaps.forEach(snap => {
          if (!snap.exists()) return;
          const wd = snap.data().weeklyDone ?? {};
          countRules.forEach(r => { totals[r.id] = (totals[r.id] ?? 0) + (wd[r.id] ?? 0); });
        });
        if (mounted) setWeekTotals(totals);
      }

      if (mounted) setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [user.uid, dateKey]);

  const toggleDaily = (ruleId, score) => {
    setDailyDone(prev => ({ ...prev, [ruleId]: prev[ruleId] ? 0 : score }));
    setSaved(false);
  };

  const adjustWeekly = (ruleId, delta) => {
    const cur  = weeklyDone[ruleId] ?? 0;
    const next = Math.max(0, cur + delta);
    if (next === cur) return;
    setWeeklyDone(prev  => ({ ...prev,  [ruleId]: next }));
    setWeekTotals(prev  => ({ ...prev,  [ruleId]: Math.max(0, (prev[ruleId] ?? 0) + (next - cur)) }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);

    const activeRules  = rules.filter(r => !r.deleted);
    const numericRules = activeRules.filter(r => getRuleInputType(r) === 'numeric');

    const scores = Object.fromEntries(
      activeRules.map(r => [r.id, (getRuleInputType(r) === 'yesno') ? (dailyDone[r.id] ?? 0) : 0])
    );

    const numericScores = {};
    const numericValuesToSave = {};
    numericRules.forEach(r => {
      const raw = numericValues[r.id];
      numericScores[r.id] = computeNumericPoints(raw, r);
      if (raw !== '' && raw !== undefined) numericValuesToSave[r.id] = parseFloat(raw);
    });

    await setDoc(doc(db, 'users', user.uid, 'ratings', dateKey), {
      date: dateKey, dailyDone, weeklyDone, scores,
      numericValues: numericValuesToSave, numericScores, note, updatedAt: new Date(),
    });
    setSaving(false);
    setSaved(true);
  };

  const dateLabel = targetDate.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).toUpperCase();

  const activeRules  = rules.filter(r => !r.deleted);
  const dailyRules   = activeRules.filter(r => getRuleGoalType(r) === 'daily');
  const weeklyRules  = activeRules.filter(r => getRuleGoalType(r) === 'weekly');

  return (
    <div className={`rate-my-day${isToday ? '' : ' yesterday'}`}>
      {nudgeLoading && (
        <div className="nudge-banner nudge-loading">COACH IS THINKING...</div>
      )}
      {!nudgeLoading && !nudgeError && plan.length > 0 && (
        <div className="nudge-banner nudge-plan">
          <div className="nudge-plan-title">TODAY'S PLAN</div>
          <ul className="nudge-plan-list">
            {plan.map((b, i) => (
              <li key={i} className="nudge-plan-item">
                <span className="nudge-icon">{b.icon}</span>
                <span className="nudge-text">{b.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="date-toggle">
        <button
          className={`date-toggle-btn${isToday ? ' active' : ''}`}
          onClick={() => { setTargetDate(new Date()); setSaved(false); setLoading(true); }}
        >TODAY</button>
        <button
          className={`date-toggle-btn${!isToday ? ' active' : ''}`}
          onClick={() => { setTargetDate(getYesterday()); setSaved(false); setLoading(true); }}
        >YESTERDAY</button>
      </div>

      {loading ? <div className="loading-inner">LOADING...</div> : (<>
      <h2 className="date-heading">{dateLabel}</h2>

      {activeRules.length === 0 ? (
        <div className="empty-state">
          <p>NO MISSIONS LOADED.</p>
          <p>GO TO RULES TO CONFIGURE.</p>
        </div>
      ) : (
        <>
          {dailyRules.length > 0 && (
            <section className="rate-section">
              <h3 className="section-label">// DAILY MISSIONS</h3>
              <ul className="rate-list">
                {dailyRules.map(rule => {
                  const it = getRuleInputType(rule);
                  if (it === 'numeric') {
                    const val      = numericValues[rule.id] ?? '';
                    const pts      = computeNumericPoints(val, rule);
                    const ptsColor = pts > 0 ? 'var(--positive)' : pts < 0 ? 'var(--negative)' : 'var(--muted)';
                    return (
                      <li key={rule.id} className="rate-item numeric">
                        <div className="rate-item-body">
                          <span className="type-badge numeric">#</span>
                          <span className="rate-name">{rule.name}</span>
                          {val !== '' && (
                            <span className="rate-pts" style={{ color: ptsColor }}>
                              {pts > 0 ? `+${pts}` : pts}pts
                            </span>
                          )}
                          <div className="numeric-input-wrap">
                            <input
                              type="number"
                              className="numeric-input"
                              value={val}
                              placeholder="—"
                              onChange={e => { setNumericValues(prev => ({ ...prev, [rule.id]: e.target.value })); setSaved(false); }}
                            />
                            {rule.unit && <span className="numeric-unit">{rule.unit}</span>}
                          </div>
                        </div>
                        <div className="numeric-hints">
                          {rule.gradientTiers?.length > 0
                            ? [...rule.gradientTiers]
                                .sort((a, b) => rule.gradientDirection === 'higher' ? b.threshold - a.threshold : a.threshold - b.threshold)
                                .map((t, i) => (
                                  <span key={i} className={`numeric-hint ${t.points >= 0 ? 'positive' : 'negative'}`}>
                                    {rule.gradientDirection === 'higher' ? '≥' : '≤'}{t.threshold}{rule.unit || ''} → {t.points >= 0 ? `+${t.points}` : t.points}pts
                                  </span>
                                ))
                            : <>
                                {rule.goodThreshold != null && <span className="numeric-hint positive">≤{rule.goodThreshold}{rule.unit || ''} = +{rule.goodPoints}pts</span>}
                                {rule.badThreshold  != null && <span className="numeric-hint negative">≥{rule.badThreshold}{rule.unit || ''} = {rule.badPoints}pts</span>}
                              </>
                          }
                        </div>
                      </li>
                    );
                  }
                  // yes/no
                  const score = rule.score ?? 10;
                  const done  = !!(dailyDone[rule.id]);
                  return (
                    <li key={rule.id} className={`rate-item ${rule.type}${done ? ' done' : ''}`}>
                      <div className="rate-item-body">
                        <span className={`type-badge ${rule.type}`}>{rule.type === 'positive' ? '+' : '−'}</span>
                        <span className="rate-name">{rule.name}</span>
                        <span className="rate-pts">{rule.type === 'positive' ? '+' : '-'}{score}pts</span>
                        <button className={`check-btn${done ? ' checked' : ''}`} onClick={() => toggleDaily(rule.id, score)}>
                          {done ? '✓' : '○'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {weeklyRules.length > 0 && (
            <section className="rate-section">
              <h3 className="section-label">// WEEKLY MISSIONS</h3>
              <ul className="rate-list">
                {weeklyRules.map(rule => {
                  const it = getRuleInputType(rule);
                  if (it === 'numeric') {
                    const val      = numericValues[rule.id] ?? '';
                    const pts      = computeNumericPoints(val, rule);
                    const ptsColor = pts > 0 ? 'var(--positive)' : pts < 0 ? 'var(--negative)' : 'var(--muted)';
                    return (
                      <li key={rule.id} className="rate-item numeric">
                        <div className="rate-item-body">
                          <span className="type-badge numeric">#</span>
                          <span className="rate-name">{rule.name}</span>
                          {val !== '' && (
                            <span className="rate-pts" style={{ color: ptsColor }}>
                              {pts > 0 ? `+${pts}` : pts}pts
                            </span>
                          )}
                          <div className="numeric-input-wrap">
                            <input
                              type="number"
                              className="numeric-input"
                              value={val}
                              placeholder="—"
                              onChange={e => { setNumericValues(prev => ({ ...prev, [rule.id]: e.target.value })); setSaved(false); }}
                            />
                            {rule.unit && <span className="numeric-unit">{rule.unit}</span>}
                          </div>
                        </div>
                        <div className="numeric-hints">
                          {rule.gradientTiers?.length > 0
                            ? [...rule.gradientTiers]
                                .sort((a, b) => rule.gradientDirection === 'higher' ? b.threshold - a.threshold : a.threshold - b.threshold)
                                .map((t, i) => (
                                  <span key={i} className={`numeric-hint ${t.points >= 0 ? 'positive' : 'negative'}`}>
                                    {rule.gradientDirection === 'higher' ? '≥' : '≤'}{t.threshold}{rule.unit || ''} → {t.points >= 0 ? `+${t.points}` : t.points}pts
                                  </span>
                                ))
                            : <>
                                {rule.goodThreshold != null && <span className="numeric-hint positive">≤{rule.goodThreshold}{rule.unit || ''} = +{rule.goodPoints}pts</span>}
                                {rule.badThreshold  != null && <span className="numeric-hint negative">≥{rule.badThreshold}{rule.unit || ''} = {rule.badPoints}pts</span>}
                              </>
                          }
                        </div>
                      </li>
                    );
                  }
                  // count
                  const target   = rule.weeklyTarget ?? 3;
                  const total    = weekTotals[rule.id] ?? 0;
                  const today    = weeklyDone[rule.id] ?? 0;
                  const progress = Math.min(total / target, 1);
                  const exceeded = total > target;
                  const complete = total >= target;
                  // For positive rules: exceeding = good (bonus). For negative rules: exceeding = bad.
                  const isGoodExceed = exceeded && rule.type === 'positive';
                  const isBadExceed  = exceeded && rule.type !== 'positive';
                  const itemClass = `rate-item weekly ${rule.type}${isGoodExceed ? ' done' : isBadExceed ? ' exceeded' : complete ? ' done' : ''}`;
                  const diff = total - target;
                  const livePreview = exceeded
                    ? (rule.type === 'positive' ? `+${diff * 35}` : `${-diff * 56}`)
                    : complete ? '✓' : '';
                  return (
                    <li key={rule.id} className={itemClass}>
                      <div className="rate-item-body">
                        <span className={`type-badge ${rule.type}`}>{rule.type === 'positive' ? '+' : '−'}</span>
                        <span className="rate-name">{rule.name}</span>
                        <span className={`weekly-count${isGoodExceed ? ' complete' : isBadExceed ? ' exceeded' : complete ? ' complete' : ''}`}>
                          {total}/{target}{livePreview ? ` ${livePreview}` : ''}
                        </span>
                      </div>
                      <div className="weekly-progress-bar">
                        <div className="weekly-progress-fill" style={{ width: `${progress * 100}%` }} />
                      </div>
                      <div className="weekly-controls">
                        <button className="weekly-btn decrement" onClick={() => adjustWeekly(rule.id, -1)}>−</button>
                        <span className="today-count">TODAY: {today}</span>
                        <button className="weekly-btn increment" onClick={() => adjustWeekly(rule.id, +1)}>+</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <div className="note-section">
            <h3 className="section-label">// DAY NOTE</h3>
            <textarea
              className="day-note-input"
              placeholder={isToday ? 'HOW DID TODAY GO? (OPTIONAL)' : 'HOW DID YESTERDAY GO? (OPTIONAL)'}
              value={note}
              onChange={e => { setNote(e.target.value); setSaved(false); }}
              maxLength={280}
              rows={3}
            />
          </div>

          <button className={`save-btn${saved ? ' saved' : ''}`} onClick={handleSave} disabled={saving}>
            {saving ? 'SAVING...' : saved ? '[ SAVED! ]' : '[ SAVE DAY ]'}
          </button>
        </>
      )}
      </>)}
    </div>
  );
}
