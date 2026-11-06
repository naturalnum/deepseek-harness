import {publicAddresses} from '../public-addresses.mjs';
export const embedded = new URLSearchParams(location.search).get('embed') === '1';
export const platformIdentity = embedded || window.__DS_RESEARCH_PUBLIC__?.platformIdentity === true;
export function openWorkbench(target) {
  if (embedded && window.parent !== window) {
    window.parent.postMessage({type:'research-open',sessionId:new URLSearchParams(location.search).get('session'),target},publicAddresses().harness.origin);
    return true;
  }
  return false;
}
