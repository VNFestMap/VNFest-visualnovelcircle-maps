/* ==========================================================================
   谁是卧底 · 房间状态 hook
   [HERE] Game/spy-react/src/state/useTable.js
   rev 游标增量轮询：3 秒一次（页面隐藏时降为 10 秒），单飞 + 指数退避。
   快照为 null 表示「还没进房」；error 供界面提示。
   ========================================================================== */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchTable } from '@/data/api.js';

const VISIBLE_INTERVAL = 3000;
const HIDDEN_INTERVAL = 10000;

export function useTable(code) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!!code);

  const revRef = useRef(0);
  const codeRef = useRef(code);
  const snapshotRef = useRef(null);
  const timerRef = useRef(null);
  const inflightRef = useRef(false);
  const failRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const backoff = Math.min(failRef.current, 4) * 2000;
    const base = document.hidden ? HIDDEN_INTERVAL : VISIBLE_INTERVAL;
    timerRef.current = setTimeout(() => { poll(); }, base + backoff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const poll = useCallback(async () => {
    const target = codeRef.current;
    if (!target || inflightRef.current) return;
    inflightRef.current = true;
    try {
      const data = await fetchTable(target, revRef.current);
      if (!mountedRef.current || codeRef.current !== target) return;
      failRef.current = 0;
      setError(null);
      // changed=false 时响应里只有 rev，不覆盖已有快照
      if (!data.changed && snapshotRef.current) return;
      revRef.current = data.rev;
      snapshotRef.current = data;
      setSnapshot(data);
    } catch (e) {
      if (!mountedRef.current) return;
      failRef.current += 1;
      setError(e);
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        revRef.current = 0;
        snapshotRef.current = null;
        setSnapshot(null);
      }
    } finally {
      inflightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        schedule();
      }
    }
  }, [schedule]);

  useEffect(() => {
    codeRef.current = code;
    revRef.current = 0;
    snapshotRef.current = null;
    failRef.current = 0;
    setSnapshot(null);
    setError(null);
    setLoading(!!code);
    if (!code) return undefined;
    poll();
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [code, poll]);

  return { snapshot, error, loading, refresh: poll };
}

/* matchMedia 订阅：桌面 / 移动布局跟随真实视口，不再有手动切换按钮。 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    setMatches(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);
  return matches;
}
