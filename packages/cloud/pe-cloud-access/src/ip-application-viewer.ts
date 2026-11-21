/** The trusted IP viewer is constant HTML. The selected application contributes only private-renderer PNG bytes. */
import { FRAME_HEIGHT, FRAME_WIDTH } from './ip-application-renderer.ts'

export function ipApplicationViewer(nonce: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Service preview</title>
<button id="refresh">Refresh preview</button> <button id="close">Close preview</button>
<p id="status" role="status">Loading preview…</p>
<img id="frame" alt="Service preview" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" hidden>
<script nonce="${nonce}">
  const frame = document.getElementById('frame');
  const status = document.getElementById('status');
  const refresh = document.getElementById('refresh');
  const close = document.getElementById('close');
  let objectUrl, busy = false, closed = false;
  async function send(action) {
    if (busy || closed) return;
    busy = true;
    refresh.disabled = close.disabled = true;
    try {
      const response = await fetch(location.pathname + location.search, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: {'content-type': 'application/json'}, body: JSON.stringify(action)
      });
      if (action.kind === 'close' && response.status === 204) {
        closed = true;
        frame.removeAttribute('src');
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        frame.hidden = true;
        status.textContent = 'Preview closed.';
        return;
      }
      if (!response.ok || response.headers.get('content-type') !== 'image/png') {
        await response.body?.cancel();
        throw new Error('Preview unavailable');
      }
      const blob = await response.blob();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      frame.src = objectUrl;
      frame.hidden = false;
      status.textContent = '';
    } catch {
      status.textContent = 'Preview unavailable.';
    } finally {
      busy = false;
      refresh.disabled = close.disabled = closed;
    }
  }
  frame.addEventListener('click', event => {
    const rect = frame.getBoundingClientRect();
    void send({kind: 'click', x: Math.floor((event.clientX - rect.left) * frame.naturalWidth / rect.width),
      y: Math.floor((event.clientY - rect.top) * frame.naturalHeight / rect.height)});
  });
  refresh.addEventListener('click', () => { void send({kind: 'frame'}); });
  close.addEventListener('click', () => { void send({kind: 'close'}); });
  void send({kind: 'frame'});
</script></html>`
}
