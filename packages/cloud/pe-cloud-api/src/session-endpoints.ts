/** Session exposure metadata shared by guarded Native inventory and Cloud bootstrap. */
import type { ExposureGuard } from './types.ts'

function sessionEndpoint<const E extends `session/${string}`, const M extends 'rpc' | 'stream',
  const G extends ExposureGuard, const R extends 'always' | 'firstScreen' | 'modelSelection'>(
  endpoint: E, mode: M, guard: G, requires: R,
) {
  return Object.freeze({ endpoint, mode, guard, requires, handlerId: 'native:sessionController' as const })
}

/** Reviewed native Session Controller endpoints and their installation requirements. */
export const SESSION_CONTROLLER_ENDPOINTS = Object.freeze([
  sessionEndpoint('session/create', 'rpc', 'account-project', 'always'),
  sessionEndpoint('session/prompt', 'rpc', 'account-session', 'always'),
  sessionEndpoint('session/fork', 'rpc', 'account-session', 'always'),
  sessionEndpoint('session/cancel', 'rpc', 'account-session', 'always'),
  sessionEndpoint('session/page', 'rpc', 'account-session', 'always'),
  sessionEndpoint('session/updateQueue', 'rpc', 'account-session', 'always'),
  sessionEndpoint('session/rename', 'rpc', 'account-session', 'always'),
  sessionEndpoint('session/follow', 'stream', 'account-session', 'always'),
  sessionEndpoint('session/list', 'rpc', 'account-session', 'firstScreen'),
  sessionEndpoint('session/control', 'stream', 'account-session', 'firstScreen'),
  sessionEndpoint('session/projections', 'rpc', 'account-session', 'firstScreen'),
  sessionEndpoint('session/modelCatalog', 'rpc', 'authenticated-account', 'modelSelection'),
  sessionEndpoint('session/selectModel', 'rpc', 'account-session', 'modelSelection'),
] as const)
