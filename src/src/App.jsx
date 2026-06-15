import { useState, useEffect } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from './firebase';
import Login from './components/Login';
import RateMyDay from './components/RateMyDay';
import RulesEditor from './components/RulesEditor';
import HistoryCharts from './components/HistoryCharts';
import FocusTimer from './components/FocusTimer';
import './App.css';

const TABS = [
  { id: 'rate',    label: 'Rate My Day' },
  { id: 'rules',   label: 'Rules' },
  { id: 'history', label: 'History' },
  { id: 'focus',   label: 'Focus' },
];

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading
  const [tab, setTab] = useState('rate');

  useEffect(() => {
    return onAuthStateChanged(auth, u => setUser(u ?? null));
  }, []);

  if (user === undefined) {
    return <div className="full-loading"><div className="spinner" /></div>;
  }

  if (!user) return <Login />;

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">Behavior Tracker</span>
        <div className="user-info">
          {user.photoURL && (
            <img src={user.photoURL} alt="" className="avatar" referrerPolicy="no-referrer" />
          )}
          <button className="sign-out-btn" onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </header>

      <nav className="tab-nav">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="tab-content">
        {tab === 'rate'    && <RateMyDay    user={user} />}
        {tab === 'rules'   && <RulesEditor  user={user} />}
        {tab === 'history' && <HistoryCharts user={user} />}
        {tab === 'focus'   && <FocusTimer   user={user} />}
      </main>
    </div>
  );
}
