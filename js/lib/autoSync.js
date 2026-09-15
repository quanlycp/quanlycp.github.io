// Mọi máy đều kéo dữ liệu, kể cả khi hàng đợi gửi của chính máy đó đang rỗng.
export function startAutoSync(state, { window: win = window, document: doc = document, onStatus = () => {} } = {}) {
  const refresh = () => {
    onStatus();
    if (!state.getSession() || doc.visibilityState === 'hidden') return;
    return state.refresh().catch((error) => console.warn('Chưa đồng bộ được:', error)).finally(onStatus);
  };
  const onVisible = () => { if (doc.visibilityState === 'visible') refresh(); };
  win.addEventListener('online', refresh);
  win.addEventListener('offline', onStatus);
  win.addEventListener('focus', refresh);
  doc.addEventListener('visibilitychange', onVisible);
  const timer = win.setInterval(refresh, 5000);
  return () => {
    win.clearInterval(timer);
    win.removeEventListener('online', refresh);
    win.removeEventListener('offline', onStatus);
    win.removeEventListener('focus', refresh);
    doc.removeEventListener('visibilitychange', onVisible);
  };
}
