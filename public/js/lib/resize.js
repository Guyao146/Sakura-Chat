/** 共用拖拽生命周期：只响应主键，取消/失焦时释放捕获并恢复页面状态。 */
export function bindResizeHandle(handle, { enabled, start, move, end, reset }) {
  if (!handle || handle.dataset.resizeBound) return;
  handle.dataset.resizeBound = '1';
  let pointerId = null;
  let oldCursor = '', oldSelect = '';
  const finish = () => {
    if (pointerId === null) return;
    const id = pointerId;
    pointerId = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', finish);
    handle.classList.remove('dragging');
    document.body.style.cursor = oldCursor;
    document.body.style.userSelect = oldSelect;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    end();
  };
  const onMove = (e) => {
    if (e.pointerId !== pointerId) return;
    if (!enabled() || e.buttons === 0) { finish(); return; }
    move(e);
  };
  const onUp = (e) => { if (e.pointerId === pointerId) finish(); };
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('pointerdown', (e) => {
    if (pointerId !== null || e.button !== 0 || !e.isPrimary || e.pointerType === 'touch' || !enabled()) return;
    pointerId = e.pointerId;
    oldCursor = document.body.style.cursor;
    oldSelect = document.body.style.userSelect;
    document.body.style.cursor = getComputedStyle(handle).cursor;
    document.body.style.userSelect = 'none';
    handle.classList.add('dragging');
    start(e);
    handle.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', finish);
  });
  if (reset) handle.addEventListener('dblclick', (e) => {
    if (!enabled()) return;
    e.preventDefault();
    finish();
    reset();
  });
}
