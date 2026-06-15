import { useState } from 'react';
import {
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '../firebase';

const ERROR_MESSAGES = {
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/user-not-found': 'No account found with this email.',
  'auth/wrong-password': 'Incorrect password.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/too-many-requests': 'Too many attempts. Please try again later.',
};

export default function Login() {
  const [mode, setMode] = useState('signin'); // 'signin' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGoogle = async () => {
    setError('');
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };

  const handleEmailAuth = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'register') {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(ERROR_MESSAGES[err.code] ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-icon">◈</div>
        <h1>BEHAVIOR TRACKER</h1>
        <p>Initialize mission protocol. Track daily & weekly objectives.</p>

        <form onSubmit={handleEmailAuth} style={{ width: '100%', marginBottom: '12px' }}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={inputStyle}
          />
          {error && <p style={{ color: '#ff6b6b', fontSize: '0.8rem', marginBottom: '8px' }}>{error}</p>}
          <button type="submit" className="google-btn" disabled={loading} style={{ width: '100%' }}>
            {loading ? '...' : mode === 'register' ? 'CREATE ACCOUNT' : 'SIGN IN'}
          </button>
        </form>

        <p style={{ fontSize: '0.8rem', marginBottom: '12px', opacity: 0.6 }}>
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => { setMode(mode === 'signin' ? 'register' : 'signin'); setError(''); }}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit', padding: 0 }}
          >
            {mode === 'signin' ? 'Register' : 'Sign in'}
          </button>
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', opacity: 0.4 }}>
          <hr style={{ flex: 1, border: 'none', borderTop: '1px solid currentColor' }} />
          <span style={{ fontSize: '0.75rem' }}>OR</span>
          <hr style={{ flex: 1, border: 'none', borderTop: '1px solid currentColor' }} />
        </div>

        <button className="google-btn" onClick={handleGoogle}>
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          SIGN IN WITH GOOGLE
        </button>
      </div>
    </div>
  );
}

const inputStyle = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  marginBottom: '10px',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: '6px',
  color: 'inherit',
  fontSize: '0.9rem',
};
