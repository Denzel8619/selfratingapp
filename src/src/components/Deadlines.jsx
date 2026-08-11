import { useState, useMemo } from 'react';

const OFFSET_OPTIONS = [
  { value: 1440, label: '1 DAY BEFORE' },
  { value: 60,   label: '1 HR BEFORE' },
  { value: 0,    label: 'AT DUE TIME' },
];

function toMillis(dueAt) {
  return dueAt?.toDate ? dueAt.toDate().getTime() : new Date(dueAt).getTime();
}

function formatDue(dueAt) {
  const d = new Date(toMillis(dueAt));
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function countdown(dueAt) {
  const diff = toMillis(dueAt) - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  let str;
  if (mins < 60) str = `${mins}m`;
  else if (mins < 1440) str = `${Math.round(mins / 60)}h`;
  else str = `${Math.round(mins / 1440)}d`;
  return diff < 0 ? `${str} overdue` : `in ${str}`;
}

function urgency(dueAt, done) {
  if (done) return 'done';
  const diff = toMillis(dueAt) - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 24 * 3_600_000) return 'today';
  if (diff < 7 * 86_400_000) return 'week';
  return 'later';
}

export default function Deadlines({
  deadlines, loading, notifPermission, isElectron,
  requestPermission, addDeadline, toggleDone, deleteDeadline,
}) {
  const [title, setTitle]           = useState('');
  const [date, setDate]             = useState('');
  const [time, setTime]             = useState('');
  const [notes, setNotes]           = useState('');
  const [offsets, setOffsets]       = useState([1440, 60, 0]);
  const [submitting, setSubmitting] = useState(false);
  const [showDone, setShowDone]     = useState(false);

  const alertsEnabled = isElectron || notifPermission === 'granted';

  const toggleOffset = (v) => setOffsets(prev =>
    prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v].sort((a, b) => b - a)
  );

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!title.trim() || !date || !time) return;
    setSubmitting(true);
    const dueAt = new Date(`${date}T${time}`);
    await addDeadline({ title: title.trim(), dueAt, notes, remindOffsets: offsets });
    setTitle(''); setDate(''); setTime(''); setNotes('');
    setSubmitting(false);
  };

  const groups = useMemo(() => {
    const g = { overdue: [], today: [], week: [], later: [], done: [] };
    for (const d of deadlines) g[urgency(d.dueAt, d.done)].push(d);
    for (const k of ['overdue', 'today', 'week', 'later', 'done']) {
      g[k].sort((a, b) => toMillis(a.dueAt) - toMillis(b.dueAt));
    }
    return g;
  }, [deadlines]);

  if (loading) return <div className="loading-inner">LOADING...</div>;

  return (
    <div className="deadlines">
      <h2 className="section-title">// DEADLINES</h2>

      <form className="add-rule-form" onSubmit={handleAdd}>
        <input
          className="rule-input"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="WHAT'S DUE..."
          autoComplete="off"
        />
        <div className="reminder-row">
          <input type="date" className="reminder-time-input" value={date} onChange={e => setDate(e.target.value)} />
          <input type="time" className="reminder-time-input" value={time} onChange={e => setTime(e.target.value)} />
        </div>
        <textarea
          className="day-note-input"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="notes (optional)"
          rows={2}
        />
        <div className="toggle-row">
          <span className="toggle-label">REMIND ME</span>
          <div className="score-picker">
            {OFFSET_OPTIONS.map(o => (
              <button
                key={o.value}
                type="button"
                className={`score-option ${offsets.includes(o.value) ? 'selected' : ''}`}
                onClick={() => toggleOffset(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {!alertsEnabled && (
          <div className="reminder-row">
            {notifPermission === 'denied' ? (
              <p className="reminder-blocked">NOTIFICATIONS BLOCKED — ENABLE IN BROWSER SETTINGS</p>
            ) : (
              <button type="button" className="reminder-toggle" onClick={requestPermission}>
                [ ENABLE ALARMS ]
              </button>
            )}
          </div>
        )}

        <button type="submit" className="add-btn" disabled={submitting || !title.trim() || !date || !time}>
          {submitting ? 'ADDING...' : '[ ADD DEADLINE ]'}
        </button>
      </form>

      <DeadlineGroup title="OVERDUE"    items={groups.overdue} cls="overdue" onToggle={toggleDone} onDelete={deleteDeadline} />
      <DeadlineGroup title="TODAY"      items={groups.today}   cls="today"   onToggle={toggleDone} onDelete={deleteDeadline} />
      <DeadlineGroup title="THIS WEEK"  items={groups.week}    cls="week"    onToggle={toggleDone} onDelete={deleteDeadline} />
      <DeadlineGroup title="LATER"      items={groups.later}   cls="later"   onToggle={toggleDone} onDelete={deleteDeadline} />

      {groups.done.length > 0 && (
        <section className="rule-group deadline-group">
          <h3 className="group-heading daily-heading" style={{ cursor: 'pointer' }} onClick={() => setShowDone(v => !v)}>
            COMPLETED ({groups.done.length}) {showDone ? '▾' : '▸'}
          </h3>
          {showDone && groups.done.map(d => (
            <DeadlineRow key={d.id} d={d} onToggle={toggleDone} onDelete={deleteDeadline} />
          ))}
        </section>
      )}

      {deadlines.length === 0 && <p className="empty-state">NO DEADLINES TRACKED.</p>}
    </div>
  );
}

function DeadlineGroup({ title, items, cls, onToggle, onDelete }) {
  if (items.length === 0) return null;
  return (
    <section className={`rule-group deadline-group deadline-group-${cls}`}>
      <h3 className={`group-heading deadline-heading-${cls}`}>{title} ({items.length})</h3>
      {items.map(d => <DeadlineRow key={d.id} d={d} onToggle={onToggle} onDelete={onDelete} />)}
    </section>
  );
}

function DeadlineRow({ d, onToggle, onDelete }) {
  const u = urgency(d.dueAt, d.done);
  return (
    <div className={`rule-row deadline-row deadline-${u}`}>
      <button
        className={`check-btn ${d.done ? 'checked' : ''}`}
        onClick={() => onToggle(d.id, !d.done)}
        title={d.done ? 'Mark not done' : 'Mark done'}
      >
        {d.done ? '✓' : ''}
      </button>
      <div className="deadline-info">
        <span className={`rule-row-name ${d.done ? 'deadline-title-done' : ''}`}>{d.title}</span>
        {d.notes && <span className="deadline-notes">{d.notes}</span>}
      </div>
      <div className="deadline-meta">
        <span className="rule-row-meta">{formatDue(d.dueAt)}</span>
        {!d.done && <span className={`deadline-countdown deadline-countdown-${u}`}>{countdown(d.dueAt)}</span>}
      </div>
      <button className="delete-btn" onClick={() => onDelete(d.id)} title="Remove">×</button>
    </div>
  );
}
