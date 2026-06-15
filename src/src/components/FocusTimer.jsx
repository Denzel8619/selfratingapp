import { useState, useEffect, useRef, useCallback } from 'react';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { getRuleGoalType, getRuleInputType } from './RulesEditor';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function computeNumericPoints(value, rule) {
  const v = parseFloat(value);
  if (isNaN(v)) return 0;
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

function formatTime(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

export default function FocusTimer({ user }) {
  const [rules, setRules]               = useState([]);
  const [selectedRuleId, setSelectedRuleId] = useState('');
  const [durHours, setDurHours]         = useState(1);
  const [durMins, setDurMins]           = useState(0);
  const [sites, setSites]               = useState([]);
  const [siteInput, setSiteInput]       = useState('');
  const [password, setPassword]         = useState('');

  const [phase, setPhase]               = useState('idle'); // idle | active | done
  const [timeLeft, setTimeLeft]         = useState(0);
  const [showStop, setShowStop]         = useState(false);
  const [stopInput, setStopInput]       = useState('');
  const [stopError, setStopError]       = useState('');
  const [hoursRecorded, setHoursRecorded] = useState(0);
  const [blocking, setBlocking]         = useState(false);
  const [blockError, setBlockError]     = useState('');

  const intervalRef   = useRef(null);
  const endTimeRef    = useRef(null);
  const startTimeRef  = useRef(null);
  const passwordRef   = useRef('');
  const sitesRef      = useRef([]);
  const ruleIdRef     = useRef('');

  // Load numeric daily rules
  useEffect(() => {
    getDocs(collection(db, 'users', user.uid, 'rules')).then(snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setRules(all.filter(r =>
        !r.deleted &&
        getRuleInputType(r) === 'numeric' &&
        getRuleGoalType(r) === 'daily'
      ));
    });
  }, [user.uid]);

  const saveToFirestore = useCallback(async (hoursSpent) => {
    const ruleId = ruleIdRef.current;
    const rule   = rules.find(r => r.id === ruleId);
    if (!rule) return;
    const dateKey   = localDateKey();
    const ratingRef = doc(db, 'users', user.uid, 'ratings', dateKey);
    const snap      = await getDoc(ratingRef);
    const existing  = snap.exists() ? snap.data() : {};

    const prevHrs = parseFloat(existing.numericValues?.[ruleId]) || 0;
    const newHrs  = Math.round((prevHrs + hoursSpent) * 100) / 100;

    const numericValues = { ...(existing.numericValues ?? {}), [ruleId]: newHrs };
    const numericScores = {
      ...(existing.numericScores ?? {}),
      [ruleId]: computeNumericPoints(newHrs, rule),
    };

    await setDoc(ratingRef, { ...existing, numericValues, numericScores, updatedAt: new Date() });
    return newHrs;
  }, [rules, user.uid]);

  const endSession = useCallback(async (early = false) => {
    clearInterval(intervalRef.current);
    intervalRef.current = null;

    const hoursSpent = (Date.now() - startTimeRef.current) / 3_600_000;

    if (isElectron && sitesRef.current.length > 0) {
      await window.electronAPI.unblockSites();
    }

    const recorded = await saveToFirestore(hoursSpent);
    setHoursRecorded(recorded ?? Math.round(hoursSpent * 100) / 100);
    setPhase('done');
    setShowStop(false);
  }, [saveToFirestore]);

  // Countdown tick
  useEffect(() => {
    if (phase !== 'active') return;
    intervalRef.current = setInterval(() => {
      const left = Math.ceil((endTimeRef.current - Date.now()) / 1000);
      if (left <= 0) {
        setTimeLeft(0);
        clearInterval(intervalRef.current);
        endSession(false);
      } else {
        setTimeLeft(left);
      }
    }, 500);
    return () => clearInterval(intervalRef.current);
  }, [phase, endSession]);

  const startSession = async () => {
    const totalMs = ((durHours * 60) + durMins) * 60 * 1000;
    if (totalMs <= 0) return;
    if (!selectedRuleId) return;
    if (!password.trim()) return;

    setBlockError('');
    setBlocking(true);

    if (isElectron && sites.length > 0) {
      const res = await window.electronAPI.blockSites(sites);
      if (!res.ok) {
        setBlockError(res.error || 'Failed to block sites. Try running as admin.');
        setBlocking(false);
        return;
      }
    }

    passwordRef.current  = password;
    sitesRef.current     = sites;
    ruleIdRef.current    = selectedRuleId;
    startTimeRef.current = Date.now();
    endTimeRef.current   = Date.now() + totalMs;

    setTimeLeft(Math.ceil(totalMs / 1000));
    setBlocking(false);
    setPhase('active');
  };

  const tryStop = () => {
    if (stopInput === passwordRef.current) {
      endSession(true);
    } else {
      setStopError('WRONG PASSWORD');
      setStopInput('');
    }
  };

  const addSite = () => {
    const v = siteInput.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (v && !sites.includes(v)) setSites(prev => [...prev, v]);
    setSiteInput('');
  };

  const selectedRule = rules.find(r => r.id === selectedRuleId);
  const totalSecs    = ((durHours * 60) + durMins) * 60;
  const progress     = totalSecs > 0 ? 1 - timeLeft / totalSecs : 0;

  // ── DONE ────────────────────────────────────────────────────────────
  if (phase === 'done') {
    return (
      <div className="focus-timer">
        <h2 className="section-title">// FOCUS COMPLETE</h2>
        <div className="focus-done-card">
          <div className="focus-done-hours">{hoursRecorded} hrs</div>
          <div className="focus-done-label">
            recorded to <span className="focus-rule-name">{selectedRule?.name ?? 'rule'}</span>
          </div>
          <div className="focus-done-sub">check Rate My Day to see your updated score</div>
          <button className="focus-start-btn" onClick={() => {
            setPhase('idle');
            setPassword('');
            setSites([]);
            setSiteInput('');
            setStopInput('');
            setStopError('');
          }}>[ NEW SESSION ]</button>
        </div>
      </div>
    );
  }

  // ── ACTIVE ──────────────────────────────────────────────────────────
  if (phase === 'active') {
    return (
      <div className="focus-timer">
        <h2 className="section-title">// FOCUS ACTIVE</h2>

        <div className="focus-countdown-wrap">
          <div className="focus-countdown">{formatTime(timeLeft)}</div>
          <div className="focus-progress-bar">
            <div className="focus-progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>

        <div className="focus-active-info">
          <span className="focus-info-label">TRACKING TO</span>
          <span className="focus-rule-name">{selectedRule?.name}</span>
        </div>

        {sites.length > 0 && (
          <div className="focus-active-info">
            <span className="focus-info-label">BLOCKED</span>
            <span className="focus-sites-list">{sites.join('  ·  ')}</span>
          </div>
        )}

        {!isElectron && (
          <div className="focus-warning">browser mode — site blocking unavailable</div>
        )}

        {!showStop ? (
          <button className="focus-stop-btn" onClick={() => { setShowStop(true); setStopError(''); }}>
            [ STOP EARLY ]
          </button>
        ) : (
          <div className="focus-stop-dialog">
            <span className="focus-info-label">ENTER PASSWORD TO STOP</span>
            <input
              type="password"
              className="focus-pw-input"
              value={stopInput}
              onChange={e => { setStopInput(e.target.value); setStopError(''); }}
              onKeyDown={e => e.key === 'Enter' && tryStop()}
              placeholder="••••••••"
              autoFocus
            />
            {stopError && <span className="focus-error">{stopError}</span>}
            <div className="focus-stop-actions">
              <button className="focus-confirm-stop-btn" onClick={tryStop}>[ CONFIRM STOP ]</button>
              <button className="focus-cancel-btn" onClick={() => { setShowStop(false); setStopInput(''); setStopError(''); }}>CANCEL</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── IDLE ─────────────────────────────────────────────────────────────
  return (
    <div className="focus-timer">
      <h2 className="section-title">// FOCUS MODE</h2>

      {!isElectron && (
        <div className="focus-warning">
          running in browser — site blocking requires the desktop app
        </div>
      )}

      <div className="focus-config">

        {/* Rule selector */}
        <div className="focus-field">
          <span className="focus-label">TRACK HOURS TO</span>
          {rules.length === 0 ? (
            <span className="focus-muted">no numeric daily rules found — add one in Rules tab</span>
          ) : (
            <div className="focus-rule-list">
              {rules.map(r => (
                <button
                  key={r.id}
                  type="button"
                  className={`focus-rule-option ${selectedRuleId === r.id ? 'selected' : ''}`}
                  onClick={() => setSelectedRuleId(r.id)}
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Duration */}
        <div className="focus-field">
          <span className="focus-label">DURATION</span>
          <div className="focus-duration-row">
            <input
              type="number"
              className="focus-dur-input"
              min={0} max={23}
              value={durHours}
              onChange={e => setDurHours(Math.max(0, parseInt(e.target.value) || 0))}
            />
            <span className="focus-dur-unit">hr</span>
            <input
              type="number"
              className="focus-dur-input"
              min={0} max={59}
              value={durMins}
              onChange={e => setDurMins(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
            />
            <span className="focus-dur-unit">min</span>
          </div>
        </div>

        {/* Sites to block */}
        <div className="focus-field">
          <span className="focus-label">BLOCK SITES {!isElectron && <span className="focus-muted">(desktop only)</span>}</span>
          <div className="focus-site-row">
            <input
              className="focus-site-input"
              value={siteInput}
              onChange={e => setSiteInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addSite()}
              placeholder="youtube.com"
            />
            <button type="button" className="focus-add-site-btn" onClick={addSite}>[+]</button>
          </div>
          {sites.length > 0 && (
            <div className="focus-site-tags">
              {sites.map((s, i) => (
                <span key={i} className="focus-site-tag">
                  {s}
                  <button type="button" className="focus-site-remove" onClick={() => setSites(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Password */}
        <div className="focus-field">
          <span className="focus-label">SESSION PASSWORD</span>
          <input
            type="password"
            className="focus-pw-input"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="required to stop early"
          />
        </div>

        {blockError && <div className="focus-error">{blockError}</div>}

        <button
          className="focus-start-btn"
          onClick={startSession}
          disabled={blocking || !selectedRuleId || totalSecs <= 0 || !password.trim()}
        >
          {blocking ? 'BLOCKING SITES...' : '[ START FOCUS ]'}
        </button>
      </div>
    </div>
  );
}
