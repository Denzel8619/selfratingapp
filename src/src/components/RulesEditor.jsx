import { useState, useEffect, useCallback } from 'react';
import { collection, getDocs, addDoc, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';

const DAILY_SCORES    = [5, 10, 15, 20, 25, 30];
const WEEKLY_TARGETS  = [1, 2, 3, 4, 5, 6, 7];
const GOOD_PTS        = [5, 10, 15, 20, 25, 30];
const BAD_PTS         = [-5, -10, -15, -20, -25, -30];

// Backward-compat helpers for legacy goalType:'numeric' rules
export function getRuleGoalType(rule) {
  return rule.goalType === 'numeric' ? 'daily' : (rule.goalType ?? 'daily');
}
export function getRuleInputType(rule) {
  if (rule.inputType) return rule.inputType;
  if (rule.goalType === 'numeric') return 'numeric';
  return rule.goalType === 'weekly' ? 'count' : 'yesno';
}

export default function RulesEditor({ user }) {
  const [rules, setRules]               = useState([]);
  const [name, setName]                 = useState('');
  const [type, setType]                 = useState('positive');
  const [goalType, setGoalType]         = useState('daily');
  const [inputType, setInputType]       = useState('yesno');
  const [scoreValue, setScoreValue]     = useState(10);
  const [weeklyTarget, setWeeklyTarget] = useState(3);
  const [unit, setUnit]                 = useState('');
  const [goodThreshold, setGoodThreshold] = useState('');
  const [goodPoints, setGoodPoints]     = useState(10);
  const [badThreshold, setBadThreshold] = useState('');
  const [badPoints, setBadPoints]       = useState(-10);
  const [scoringMode, setScoringMode]           = useState('simple');
  const [gradientDirection, setGradientDirection] = useState('higher');
  const [gradientTiers, setGradientTiers]       = useState([]);
  const [submitting, setSubmitting]             = useState(false);
  const [editingId, setEditingId]               = useState(null);

  const rulesRef = collection(db, 'users', user.uid, 'rules');

  const loadRules = useCallback(async () => {
    const snap = await getDocs(rulesRef);
    setRules(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, [user.uid]);

  useEffect(() => { loadRules(); }, [loadRules]);

  const addTier    = () => setGradientTiers(prev => [...prev, { threshold: '', points: 10 }]);
  const removeTier = (i) => setGradientTiers(prev => prev.filter((_, idx) => idx !== i));
  const updateTier = (i, field, val) => setGradientTiers(prev =>
    prev.map((t, idx) => idx === i ? { ...t, [field]: field === 'points' ? (parseInt(val) || 0) : val } : t)
  );

  const changeGoalType = (gt) => {
    setGoalType(gt);
    setInputType(gt === 'weekly' ? 'count' : 'yesno');
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);

    const ruleData = { name: name.trim(), goalType, inputType, createdAt: new Date() };

    if (inputType === 'numeric') {
      ruleData.type = 'numeric';
      if (unit.trim()) ruleData.unit = unit.trim();
      if (scoringMode === 'gradient') {
        const validTiers = gradientTiers.filter(t => t.threshold !== '').map(t => ({ threshold: parseFloat(t.threshold), points: t.points }));
        if (validTiers.length > 0) {
          ruleData.gradientTiers     = validTiers;
          ruleData.gradientDirection = gradientDirection;
        }
      } else {
        if (goodThreshold !== '') { ruleData.goodThreshold = parseFloat(goodThreshold); ruleData.goodPoints = goodPoints; }
        if (badThreshold  !== '') { ruleData.badThreshold  = parseFloat(badThreshold);  ruleData.badPoints  = badPoints;  }
      }
    } else {
      ruleData.type = type;
      if (inputType === 'count') ruleData.weeklyTarget = weeklyTarget;
      else                       ruleData.score        = scoreValue;
    }

    await addDoc(rulesRef, ruleData);
    setName('');
    setScoringMode('simple');
    setGradientTiers([]);
    await loadRules();
    setSubmitting(false);
  };

  const handleDelete = async (id) => {
    await updateDoc(doc(db, 'users', user.uid, 'rules', id), { deleted: true, deletedAt: new Date() });
    setRules(prev => prev.filter(r => r.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const handleSaveEdit = async (id, patch) => {
    await updateDoc(doc(db, 'users', user.uid, 'rules', id), patch);
    setRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    setEditingId(null);
  };

  const visible = rules.filter(r => !r.deleted);
  const daily   = visible.filter(r => getRuleGoalType(r) === 'daily');
  const weekly  = visible.filter(r => getRuleGoalType(r) === 'weekly');

  return (
    <div className="rules-editor">
      <h2 className="section-title">MISSION CONFIG</h2>

      <form className="add-rule-form" onSubmit={handleAdd}>
        <input
          className="rule-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="BEHAVIOR NAME..."
          autoComplete="off"
        />

        <div className="toggle-row">
          <span className="toggle-label">FREQUENCY</span>
          <div className="type-toggle">
            <button type="button" className={goalType === 'daily'  ? 'active' : ''} onClick={() => changeGoalType('daily')}>DAILY</button>
            <button type="button" className={goalType === 'weekly' ? 'active' : ''} onClick={() => changeGoalType('weekly')}>WEEKLY</button>
          </div>
        </div>

        <div className="toggle-row">
          <span className="toggle-label">INPUT TYPE</span>
          <div className="type-toggle">
            {goalType === 'daily'
              ? <>
                  <button type="button" className={inputType === 'yesno'   ? 'active' : ''} onClick={() => setInputType('yesno')}>YES / NO</button>
                  <button type="button" className={inputType === 'numeric'  ? 'active' : ''} onClick={() => setInputType('numeric')}>NUMERIC</button>
                </>
              : <>
                  <button type="button" className={inputType === 'count'   ? 'active' : ''} onClick={() => setInputType('count')}>COUNT</button>
                  <button type="button" className={inputType === 'numeric' ? 'active' : ''} onClick={() => setInputType('numeric')}>NUMERIC</button>
                </>
            }
          </div>
        </div>

        {inputType !== 'numeric' && (
          <div className="toggle-row">
            <span className="toggle-label">TYPE</span>
            <div className="type-toggle">
              <button type="button" className={type === 'positive' ? 'active positive' : ''} onClick={() => setType('positive')}>+ POSITIVE</button>
              <button type="button" className={type === 'negative' ? 'active negative' : ''} onClick={() => setType('negative')}>− NEGATIVE</button>
            </div>
          </div>
        )}

        {inputType === 'yesno' && (
          <div className="score-config">
            <span className="toggle-label">POINT VALUE</span>
            <div className="score-picker">
              {DAILY_SCORES.map(v => (
                <button key={v} type="button" className={`score-option ${scoreValue === v ? 'selected' : ''}`} onClick={() => setScoreValue(v)}>{v}</button>
              ))}
            </div>
          </div>
        )}

        {inputType === 'count' && (
          <div className="score-config">
            <span className="toggle-label">TIMES PER WEEK</span>
            <div className="score-picker">
              {WEEKLY_TARGETS.map(v => (
                <button key={v} type="button" className={`score-option ${weeklyTarget === v ? 'selected' : ''}`} onClick={() => setWeeklyTarget(v)}>{v}x</button>
              ))}
            </div>
          </div>
        )}

        {inputType === 'numeric' && (
          <>
            <div className="score-config">
              <span className="toggle-label">UNIT (optional, e.g. hrs, g, steps)</span>
              <input className="rule-input unit-input" value={unit} onChange={e => setUnit(e.target.value)} placeholder="hrs" maxLength={8} />
            </div>
            <div className="toggle-row">
              <span className="toggle-label">SCORING</span>
              <div className="type-toggle">
                <button type="button" className={scoringMode === 'simple' ? 'active' : ''} onClick={() => setScoringMode('simple')}>SIMPLE</button>
                <button type="button" className={scoringMode === 'gradient' ? 'active' : ''} onClick={() => setScoringMode('gradient')}>GRADIENT</button>
              </div>
            </div>
            {scoringMode === 'simple' ? (
              <>
                <div className="score-config">
                  <span className="toggle-label">REWARD IF AT OR BELOW (optional)</span>
                  <div className="threshold-row">
                    <input type="number" className="threshold-input" value={goodThreshold} onChange={e => setGoodThreshold(e.target.value)} placeholder="e.g. 15" />
                    <div className="score-picker">
                      {GOOD_PTS.map(v => (
                        <button key={v} type="button" className={`score-option ${goodPoints === v ? 'selected' : ''}`} onClick={() => setGoodPoints(v)}>+{v}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="score-config">
                  <span className="toggle-label">PENALTY IF AT OR ABOVE (optional)</span>
                  <div className="threshold-row">
                    <input type="number" className="threshold-input" value={badThreshold} onChange={e => setBadThreshold(e.target.value)} placeholder="e.g. 50" />
                    <div className="score-picker">
                      {BAD_PTS.map(v => (
                        <button key={v} type="button" className={`score-option negative ${badPoints === v ? 'selected' : ''}`} onClick={() => setBadPoints(v)}>{v}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="toggle-row">
                  <span className="toggle-label">DIRECTION</span>
                  <div className="type-toggle">
                    <button type="button" className={gradientDirection === 'higher' ? 'active positive' : ''} onClick={() => setGradientDirection('higher')}>↑ MORE = BETTER</button>
                    <button type="button" className={gradientDirection === 'lower'  ? 'active positive' : ''} onClick={() => setGradientDirection('lower')}>↓ LESS = BETTER</button>
                  </div>
                </div>
                <div className="score-config">
                  <span className="toggle-label">TIERS — THRESHOLD → POINTS</span>
                  <div className="gradient-tiers-config">
                    {gradientTiers.map((tier, i) => (
                      <div key={i} className="gradient-tier-row">
                        <span className="tier-op">{gradientDirection === 'higher' ? '≥' : '≤'}</span>
                        <input type="number" className="threshold-input" style={{width:'64px'}} value={tier.threshold}
                          onChange={e => updateTier(i, 'threshold', e.target.value)} placeholder="val" />
                        {unit && <span className="tier-unit">{unit}</span>}
                        <span className="tier-arrow">→</span>
                        <input type="number" className="tier-pts-input" value={tier.points}
                          onChange={e => updateTier(i, 'points', e.target.value)} />
                        <span className="tier-pts-label">pts</span>
                        <button type="button" className="tier-remove-btn" onClick={() => removeTier(i)}>×</button>
                      </div>
                    ))}
                    <button type="button" className="add-tier-btn" onClick={addTier}>[+ ADD TIER]</button>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        <button type="submit" className="add-btn" disabled={submitting || !name.trim()}>
          {submitting ? 'ADDING...' : '[ ADD MISSION ]'}
        </button>
      </form>

      <div className="rule-groups">
        <section className="rule-group">
          <h3 className="group-heading daily-heading">DAILY MISSIONS</h3>
          {daily.length === 0 && <p className="empty-state">NO MISSIONS PROGRAMMED.</p>}
          {daily.map(rule =>
            editingId === rule.id
              ? <RuleEditForm key={rule.id} rule={rule} onSave={handleSaveEdit} onCancel={() => setEditingId(null)} />
              : <RuleRow key={rule.id} rule={rule} onDelete={handleDelete} onEdit={() => setEditingId(rule.id)} />
          )}
        </section>

        <section className="rule-group">
          <h3 className="group-heading weekly-heading">WEEKLY MISSIONS</h3>
          {weekly.length === 0 && <p className="empty-state">NO MISSIONS PROGRAMMED.</p>}
          {weekly.map(rule =>
            editingId === rule.id
              ? <RuleEditForm key={rule.id} rule={rule} onSave={handleSaveEdit} onCancel={() => setEditingId(null)} />
              : <RuleRow key={rule.id} rule={rule} onDelete={handleDelete} onEdit={() => setEditingId(rule.id)} />
          )}
        </section>
      </div>
    </div>
  );
}

function RuleRow({ rule, onDelete, onEdit }) {
  const it = getRuleInputType(rule);
  let meta;
  if (it === 'numeric') {
    if (rule.gradientTiers?.length > 0) {
      const dir = rule.gradientDirection === 'higher' ? '↑' : '↓';
      const sorted = [...rule.gradientTiers].sort((a, b) => rule.gradientDirection === 'higher' ? b.threshold - a.threshold : a.threshold - b.threshold);
      meta = `${dir} ` + sorted.map(t => `${rule.gradientDirection === 'higher' ? '≥' : '≤'}${t.threshold}${rule.unit||''}:${t.points>0?'+':''}${t.points}p`).join(' ');
    } else {
      const parts = [];
      if (rule.goodThreshold != null) parts.push(`≤${rule.goodThreshold}${rule.unit || ''} +${rule.goodPoints}p`);
      if (rule.badThreshold  != null) parts.push(`≥${rule.badThreshold}${rule.unit || ''} ${rule.badPoints}p`);
      meta = parts.join('  ') || 'range';
    }
  } else if (it === 'count') {
    meta = `${rule.weeklyTarget ?? 3}x/wk`;
  } else {
    meta = `${rule.type === 'positive' ? '+' : '-'}${rule.score ?? 10}pts`;
  }

  const badge = it === 'numeric' ? '#' : rule.type === 'positive' ? '+' : '−';
  const badgeClass = it === 'numeric' ? 'numeric' : rule.type;

  return (
    <div className="rule-row">
      <span className={`type-badge ${badgeClass}`}>{badge}</span>
      <span className="rule-row-name">{rule.name}</span>
      <span className="rule-row-meta">{meta}</span>
      <button className="edit-btn" onClick={onEdit} title="Edit">✎</button>
      <button className="delete-btn" onClick={() => onDelete(rule.id)} title="Remove">×</button>
    </div>
  );
}

function RuleEditForm({ rule, onSave, onCancel }) {
  const gt = getRuleGoalType(rule);

  const [inputType, setInputType]         = useState(getRuleInputType(rule));
  const [name, setName]                   = useState(rule.name);
  const [type, setType]                   = useState(rule.type ?? 'positive');
  const [scoreValue, setScore]            = useState(rule.score ?? 10);
  const [weeklyTarget, setTarget]         = useState(rule.weeklyTarget ?? 3);
  const [unit, setUnit]                   = useState(rule.unit ?? '');
  const [goodThreshold, setGoodThreshold] = useState(rule.goodThreshold ?? '');
  const [goodPoints, setGoodPoints]       = useState(rule.goodPoints ?? 10);
  const [badThreshold, setBadThreshold]   = useState(rule.badThreshold ?? '');
  const [badPoints, setBadPoints]         = useState(rule.badPoints ?? -10);
  const [scoringMode, setScoringMode]     = useState(rule.gradientTiers?.length > 0 ? 'gradient' : 'simple');
  const [gradientDirection, setGradientDirection] = useState(rule.gradientDirection ?? 'higher');
  const [gradientTiers, setGradientTiers] = useState(
    rule.gradientTiers?.map(t => ({ threshold: String(t.threshold), points: t.points })) ?? []
  );
  const [saving, setSaving]               = useState(false);

  const addTierEdit    = () => setGradientTiers(prev => [...prev, { threshold: '', points: 10 }]);
  const removeTierEdit = (i) => setGradientTiers(prev => prev.filter((_, idx) => idx !== i));
  const updateTierEdit = (i, field, val) => setGradientTiers(prev =>
    prev.map((t, idx) => idx === i ? { ...t, [field]: field === 'points' ? (parseInt(val) || 0) : val } : t)
  );

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const patch = { name: name.trim(), inputType };
    if (inputType === 'numeric') {
      patch.type          = 'numeric';
      patch.unit          = unit.trim();
      patch.score         = null;
      patch.weeklyTarget  = null;
      if (scoringMode === 'gradient') {
        const validTiers = gradientTiers.filter(t => t.threshold !== '').map(t => ({ threshold: parseFloat(t.threshold), points: t.points }));
        patch.gradientTiers     = validTiers.length > 0 ? validTiers : null;
        patch.gradientDirection = gradientDirection;
        patch.goodThreshold     = null;
        patch.badThreshold      = null;
      } else {
        patch.gradientTiers     = null;
        patch.gradientDirection = null;
        if (goodThreshold !== '') { patch.goodThreshold = parseFloat(goodThreshold); patch.goodPoints = goodPoints; }
        else patch.goodThreshold = null;
        if (badThreshold !== '') { patch.badThreshold = parseFloat(badThreshold); patch.badPoints = badPoints; }
        else patch.badThreshold = null;
      }
    } else if (inputType === 'count') {
      patch.type = type; patch.weeklyTarget = weeklyTarget;
      patch.score = null; patch.unit = null; patch.goodThreshold = null; patch.badThreshold = null; patch.gradientTiers = null;
    } else {
      patch.type = type; patch.score = scoreValue;
      patch.weeklyTarget = null; patch.unit = null; patch.goodThreshold = null; patch.badThreshold = null; patch.gradientTiers = null;
    }
    await onSave(rule.id, patch);
  };

  return (
    <div className="rule-edit-form">
      <input className="rule-input rule-edit-input" value={name} onChange={e => setName(e.target.value)} autoFocus />

      <div className="rule-edit-row">
        <div className="type-toggle rule-edit-toggle">
          {gt === 'daily'
            ? <>
                <button type="button" className={inputType === 'yesno'   ? 'active' : ''} onClick={() => setInputType('yesno')}>YES / NO</button>
                <button type="button" className={inputType === 'numeric' ? 'active' : ''} onClick={() => setInputType('numeric')}>NUMERIC</button>
              </>
            : <>
                <button type="button" className={inputType === 'count'   ? 'active' : ''} onClick={() => setInputType('count')}>COUNT</button>
                <button type="button" className={inputType === 'numeric' ? 'active' : ''} onClick={() => setInputType('numeric')}>NUMERIC</button>
              </>
          }
        </div>
      </div>

      {inputType !== 'numeric' && (
        <div className="rule-edit-row">
          <div className="type-toggle rule-edit-toggle">
            <button type="button" className={type === 'positive' ? 'active positive' : ''} onClick={() => setType('positive')}>+ POS</button>
            <button type="button" className={type === 'negative' ? 'active negative' : ''} onClick={() => setType('negative')}>− NEG</button>
          </div>
          <div className="score-picker rule-edit-picker">
            {inputType === 'count'
              ? WEEKLY_TARGETS.map(v => (
                  <button key={v} type="button" className={`score-option ${weeklyTarget === v ? 'selected' : ''}`} onClick={() => setTarget(v)}>{v}x</button>
                ))
              : DAILY_SCORES.map(v => (
                  <button key={v} type="button" className={`score-option ${scoreValue === v ? 'selected' : ''}`} onClick={() => setScore(v)}>{v}</button>
                ))
            }
          </div>
        </div>
      )}

      {inputType === 'numeric' && (
        <div className="numeric-edit-fields">
          <input className="rule-input unit-input" value={unit} onChange={e => setUnit(e.target.value)} placeholder="unit (e.g. hrs)" maxLength={8} />
          <div className="rule-edit-row">
            <div className="type-toggle rule-edit-toggle">
              <button type="button" className={scoringMode === 'simple'   ? 'active' : ''} onClick={() => setScoringMode('simple')}>SIMPLE</button>
              <button type="button" className={scoringMode === 'gradient' ? 'active' : ''} onClick={() => setScoringMode('gradient')}>GRADIENT</button>
            </div>
          </div>
          {scoringMode === 'simple' ? (
            <>
              <div className="threshold-row">
                <span className="toggle-label" style={{fontSize:'.44rem'}}>≤ REWARD</span>
                <input type="number" className="threshold-input" value={goodThreshold} onChange={e => setGoodThreshold(e.target.value)} placeholder="threshold" />
                <div className="score-picker rule-edit-picker">
                  {GOOD_PTS.map(v => (
                    <button key={v} type="button" className={`score-option ${goodPoints === v ? 'selected' : ''}`} onClick={() => setGoodPoints(v)}>+{v}</button>
                  ))}
                </div>
              </div>
              <div className="threshold-row">
                <span className="toggle-label" style={{fontSize:'.44rem'}}>≥ PENALTY</span>
                <input type="number" className="threshold-input" value={badThreshold} onChange={e => setBadThreshold(e.target.value)} placeholder="threshold" />
                <div className="score-picker rule-edit-picker">
                  {BAD_PTS.map(v => (
                    <button key={v} type="button" className={`score-option negative ${badPoints === v ? 'selected' : ''}`} onClick={() => setBadPoints(v)}>{v}</button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="rule-edit-row">
                <div className="type-toggle rule-edit-toggle">
                  <button type="button" className={gradientDirection === 'higher' ? 'active positive' : ''} onClick={() => setGradientDirection('higher')}>↑ MORE</button>
                  <button type="button" className={gradientDirection === 'lower'  ? 'active positive' : ''} onClick={() => setGradientDirection('lower')}>↓ LESS</button>
                </div>
              </div>
              <div className="gradient-tiers-config">
                {gradientTiers.map((tier, i) => (
                  <div key={i} className="gradient-tier-row">
                    <span className="tier-op">{gradientDirection === 'higher' ? '≥' : '≤'}</span>
                    <input type="number" className="threshold-input" style={{width:'56px'}} value={tier.threshold}
                      onChange={e => updateTierEdit(i, 'threshold', e.target.value)} placeholder="val" />
                    {unit && <span className="tier-unit">{unit}</span>}
                    <span className="tier-arrow">→</span>
                    <input type="number" className="tier-pts-input" value={tier.points}
                      onChange={e => updateTierEdit(i, 'points', e.target.value)} />
                    <span className="tier-pts-label">pts</span>
                    <button type="button" className="tier-remove-btn" onClick={() => removeTierEdit(i)}>×</button>
                  </div>
                ))}
                <button type="button" className="add-tier-btn" onClick={addTierEdit}>[+ ADD TIER]</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="rule-edit-actions">
        <button className="edit-save-btn" onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? 'SAVING...' : '[ SAVE ]'}
        </button>
        <button className="edit-cancel-btn" onClick={onCancel}>CANCEL</button>
      </div>
    </div>
  );
}
