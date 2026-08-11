import { useState, useEffect, useCallback } from 'react';
import {
  collection, getDocs, addDoc, doc, updateDoc, deleteDoc, arrayUnion,
} from 'firebase/firestore';
import { db } from '../firebase';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
const CHECK_INTERVAL_MS = 30_000;

function toMillis(dueAt) {
  return dueAt?.toDate ? dueAt.toDate().getTime() : new Date(dueAt).getTime();
}

function fireNotification(title, body) {
  if (isElectron) {
    window.electronAPI.notify(title, body);
    return;
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icon-192.png' });
  }
}

function offsetLabel(offsetMin) {
  if (offsetMin === 0) return 'now';
  if (offsetMin % 1440 === 0) return `in ${offsetMin / 1440} day${offsetMin === 1440 ? '' : 's'}`;
  if (offsetMin % 60 === 0) return `in ${offsetMin / 60} hr${offsetMin === 60 ? '' : 's'}`;
  return `in ${offsetMin} min`;
}

export default function useDeadlines(user) {
  const [deadlines, setDeadlines] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [notifPermission, setNotifPermission] = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  const colRef = user ? collection(db, 'users', user.uid, 'deadlines') : null;

  const load = useCallback(async () => {
    if (!colRef) return;
    const snap = await getDocs(colRef);
    setDeadlines(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, [user?.uid]);

  useEffect(() => { load(); }, [load]);

  // Alarm sweep: catches up on anything due (even if the app was just opened),
  // then re-checks every 30s while the app stays open.
  useEffect(() => {
    if (!user) return;
    const check = () => {
      const now = Date.now();
      for (const d of deadlines) {
        if (d.done) continue;
        const due = toMillis(d.dueAt);
        const offsets  = d.remindOffsets ?? [0];
        const notified = d.notifiedOffsets ?? [];
        for (const off of offsets) {
          if (notified.includes(off)) continue;
          if (now >= due - off * 60_000) {
            fireNotification(`⏰ ${d.title}`, off === 0 ? 'Due now' : `Due ${offsetLabel(off)}`);
            updateDoc(doc(db, 'users', user.uid, 'deadlines', d.id), {
              notifiedOffsets: arrayUnion(off),
            }).catch(() => {});
            setDeadlines(prev => prev.map(x => x.id === d.id
              ? { ...x, notifiedOffsets: [...(x.notifiedOffsets ?? []), off] }
              : x));
          }
        }
      }
    };
    check();
    const id = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [user, deadlines]);

  const requestPermission = useCallback(async () => {
    if (isElectron) { setNotifPermission('granted'); return 'granted'; }
    if (typeof Notification === 'undefined') return 'denied';
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    return perm;
  }, []);

  const addDeadline = useCallback(async ({ title, dueAt, notes, remindOffsets }) => {
    await addDoc(colRef, {
      title, dueAt, notes: notes || '', remindOffsets,
      notifiedOffsets: [], done: false, createdAt: new Date(),
    });
    await load();
  }, [colRef, load]);

  const toggleDone = useCallback(async (id, done) => {
    await updateDoc(doc(db, 'users', user.uid, 'deadlines', id), { done });
    setDeadlines(prev => prev.map(d => d.id === id ? { ...d, done } : d));
  }, [user?.uid]);

  const deleteDeadline = useCallback(async (id) => {
    await deleteDoc(doc(db, 'users', user.uid, 'deadlines', id));
    setDeadlines(prev => prev.filter(d => d.id !== id));
  }, [user?.uid]);

  const now = Date.now();
  const badgeCount = deadlines.filter(d =>
    !d.done && toMillis(d.dueAt) <= now + 24 * 3_600_000
  ).length;

  return {
    deadlines, loading, badgeCount, notifPermission, isElectron,
    requestPermission, addDeadline, toggleDone, deleteDeadline,
  };
}
