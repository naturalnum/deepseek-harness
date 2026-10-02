/** Stop and resume the exact application Deployments around an operator-owned backup. */
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const appLabel = 'app.kubernetes.io/name'
const roles = ['host', 'platform']
const dnsName = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u
const yaml = createRequire(new URL('../application/package.json', import.meta.url))('js-yaml')
const listener = yaml.loadAll(readFileSync(new URL('../connector-runner/deploy/forbidden-listener.yaml', import.meta.url),
  'utf8'))[0].spec.template.spec

function refuse(message) { throw new Error(message) }
function validateScope(scope) {
  if (!scope || typeof scope.context !== 'string' || !scope.context
    || /[\u0000-\u0020\u007f]/u.test(scope.context)
    || ![scope.namespace, scope.runnerNamespace, scope.connectorNamespace]
      .every(value => typeof value === 'string' && dnsName.test(value))
    || new Set([scope.namespace, scope.runnerNamespace, scope.connectorNamespace]).size !== 3
    || typeof scope.appImage !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/u.test(scope.appImage)) {
    refuse('Invalid Deployment backup scope')
  }
}
function validateDeployment(deployment, role, scope) {
  const name = `power-evolve-${role}`, metadata = deployment?.metadata, spec = deployment?.spec
  if (deployment?.kind !== 'Deployment' || metadata?.name !== name || metadata.namespace !== scope.namespace
    || typeof metadata.uid !== 'string' || !metadata.uid || metadata.deletionTimestamp
    || typeof metadata.resourceVersion !== 'string' || !metadata.resourceVersion
    || !Number.isSafeInteger(metadata.generation) || metadata.generation < 1
    || !Number.isSafeInteger(spec?.replicas) || spec.replicas < 0
    || spec.selector?.matchLabels?.[appLabel] !== name || spec.selector.matchExpressions?.length
    || !Array.isArray(spec.template?.spec?.containers) || spec.template.spec.containers.length !== 1
    || spec.template.spec.containers[0].name !== 'dsh' || spec.template.spec.containers[0].image !== scope.appImage) {
    refuse(`Cannot verify backup ${role} Deployment`)
  }
  return deployment
}
function withoutReplicas(spec) { const copy = structuredClone(spec); delete copy.replicas; return copy }
function matchesRecord(deployment, entry, scope) {
  validateDeployment(deployment, entry.role, scope)
  if (deployment.metadata.uid !== entry.uid
    || !isDeepStrictEqual(withoutReplicas(deployment.spec), withoutReplicas(entry.spec))) {
    refuse(`Backup ${entry.role} Deployment identity or spec changed`)
  }
}
function validateRecord(record) {
  validateScope(record?.scope)
  if (record.format !== 1 || !['prepared', 'stopping', 'stopped', 'restoring', 'restored'].includes(record.phase)
    || !Array.isArray(record.deployments) || record.deployments.length !== 2) refuse('Invalid Deployment backup fence')
  for (const [index, entry] of record.deployments.entries()) {
    if (entry?.role !== roles[index] || entry.name !== `power-evolve-${entry.role}` || typeof entry.uid !== 'string'
      || !entry.uid || !Number.isSafeInteger(entry.replicas) || entry.replicas < 0
      || entry.spec?.replicas !== entry.replicas) refuse('Invalid Deployment backup fence')
    validateDeployment({ kind: 'Deployment', metadata: { name: entry.name, namespace: record.scope.namespace,
      uid: entry.uid, resourceVersion: 'recorded', generation: 1 }, spec: entry.spec }, entry.role, record.scope)
  }
}
async function requireNoAutoscaler(scope, io) {
  const items = await io.getAutoscalers(scope.namespace)
  if (!Array.isArray(items) || items.some(item => !item?.spec?.scaleTargetRef)) {
    refuse('Cannot verify backup autoscalers')
  }
  if (items.some(item => item.spec.scaleTargetRef.kind === 'Deployment'
    && roles.some(role => item.spec.scaleTargetRef.name === `power-evolve-${role}`))) {
    refuse('Disable application autoscaling before Deployment backup')
  }
}

/** Capture immutable UIDs/specs and persist the fence before the first scale request.
 * @param scope Explicit context, three namespaces and the expected common image digest.
 * @param io Context-bound Kubernetes reads/patches and an atomic, durable saveFence implementation.
 * @returns The original replica counts and exact specs; no Deployment is changed here.
 */
export async function captureDeploymentBackupFence(scope, io) {
  validateScope(scope)
  await requireNoAutoscaler(scope, io)
  const deployments = []
  for (const role of roles) {
    const deployment = validateDeployment(await io.getDeployment(scope.namespace, `power-evolve-${role}`), role, scope)
    deployments.push({ role, name: deployment.metadata.name, uid: deployment.metadata.uid,
      replicas: deployment.spec.replicas, spec: structuredClone(deployment.spec), intent: null })
  }
  const record = { format: 1, scope: structuredClone(scope), phase: 'prepared', deployments }
  await io.saveFence(record)
  return record
}

async function changeReplicas(record, entry, target, io) {
  const actual = await io.getDeployment(record.scope.namespace, entry.name)
  matchesRecord(actual, entry, record.scope)
  if (![0, entry.replicas].includes(actual.spec.replicas)) refuse(`Backup ${entry.role} replica count changed`)
  requireReplicaIntent(actual, entry, target)
  if (actual.spec.replicas !== target) {
    entry.intent = { from: actual.spec.replicas, to: target, resourceVersion: actual.metadata.resourceVersion,
      state: 'pending' }
    await io.saveFence(record)
    // UID, RV and full spec tests fence replacement, concurrent scaling and rollout changes.
    const patch = [{ op: 'test', path: '/metadata/uid', value: entry.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: actual.metadata.resourceVersion },
      { op: 'test', path: '/spec', value: actual.spec },
      { op: 'replace', path: '/spec/replicas', value: target }]
    try { await io.patchDeployment(record.scope.namespace, entry.name, patch) }
    catch (_patchError) { /* Read back an ambiguous request; this invocation never blindly submits it again. */ }
    const observed = await io.getDeployment(record.scope.namespace, entry.name)
    matchesRecord(observed, entry, record.scope)
    if (observed.spec.replicas !== target) refuse(`Backup ${entry.role} replica change is unconfirmed; reconcile before retry`)
  }
  entry.intent = { ...(entry.intent ?? {}), to: target, state: 'confirmed' }
  await io.saveFence(record)
}
function requireReplicaIntent(actual, entry, target) {
  if (entry.replicas === 0) return
  const intent = entry.intent
  const stopping = target === 0
  const acceptedTarget = intent?.to === target && ['pending', 'confirmed'].includes(intent.state)
  const acceptedSource = stopping ? !intent || intent.to === 0 && intent.state === 'pending'
    : intent?.to === 0 && intent.state === 'confirmed' || intent?.to === target && intent.state === 'pending'
  if (!(actual.spec.replicas === target ? acceptedTarget : acceptedSource)) {
    refuse(`Backup ${entry.role} replica count changed without its saved intent`)
  }
}
function podMatches(pod, entry) {
  return Object.entries(entry.spec.selector.matchLabels).every(([key, value]) => pod?.metadata?.labels?.[key] === value)
}
async function roleStopped(record, entry, io) {
  const actual = await io.getDeployment(record.scope.namespace, entry.name)
  matchesRecord(actual, entry, record.scope)
  const pods = await io.getPods(record.scope.namespace)
  if (!Array.isArray(pods) || pods.some(pod => typeof pod?.metadata?.name !== 'string')) {
    refuse('Cannot verify application Pod absence')
  }
  return actual.spec.replicas === 0 && (actual.status?.observedGeneration ?? 0) >= actual.metadata.generation
    && (actual.status?.replicas ?? 0) === 0 && !pods.some(pod => podMatches(pod, entry))
}
async function waitStopped(record, entry, io, { timeoutMs = 180000, intervalMs = 1000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    refuse('Invalid Deployment backup wait')
  }
  const deadline = Date.now() + timeoutMs
  while (!await roleStopped(record, entry, io)) {
    if (Date.now() >= deadline) refuse(`Backup ${entry.role} Pods have not stopped`)
    await (io.delay ?? delay)(Math.min(intervalMs, Math.max(1, deadline - Date.now())))
  }
}

/** Close Host admission first, then stop Platform; terminating Pods still block a snapshot.
 * @param record The saved fence; rerunning reconciles exact current state after an interruption.
 * @param io The same context-bound transport and durable fence writer used for capture.
 * @param options Bounded stop wait, shared by each application role.
 * @returns The saved stopped fence. Failure preserves intent and never automatically resumes writers.
 */
export async function stopDeploymentBackupWriters(record, io, options) {
  validateRecord(record)
  if (!['prepared', 'stopping', 'stopped'].includes(record.phase)) refuse('Backup fence cannot stop after restoration')
  await requireNoAutoscaler(record.scope, io)
  record.phase = 'stopping'; await io.saveFence(record)
  for (const entry of record.deployments) {
    await changeReplicas(record, entry, 0, io)
    await waitStopped(record, entry, io, options)
  }
  await requireDeploymentBackupStopped(record, io)
  record.phase = 'stopped'; await io.saveFence(record)
  return record
}

/** Verify the same stopped application identities and absence of cloud/connector execution writers.
 * @param record The saved source fence, checked before and after the snapshot.
 * @param io Context-bound reads; API errors fail closed.
 * @returns Resolves only when both roles and their execution namespaces are clear.
 */
export async function requireDeploymentBackupStopped(record, io) {
  validateRecord(record)
  if (!['stopping', 'stopped'].includes(record.phase)) refuse('Application has no stopped backup fence')
  await requireNoAutoscaler(record.scope, io)
  for (const entry of record.deployments) {
    if (!await roleStopped(record, entry, io)) refuse(`Backup ${entry.role} Deployment is not stopped`)
  }
  const sandboxes = await io.getSandboxes(record.scope.runnerNamespace)
  const runners = await io.getPods(record.scope.runnerNamespace)
  const connectors = await io.getPods(record.scope.connectorNamespace)
  if (![sandboxes, runners, connectors].every(Array.isArray)) refuse('Cannot verify execution writer absence')
  if (sandboxes.length || runners.length) refuse('Cloud execution resources remain during backup')
  // Only the fixed, unmounted, read-only HTTP denial probe may remain in this namespace.
  if (connectors.some(pod => !isDenialProbe(pod))) {
    refuse('Connector execution Pods remain during backup')
  }
}
function isDenialProbe(pod) {
  if (typeof pod?.metadata?.name !== 'string'
    || !/^power-evolve-forbidden-listener-[a-z0-9]+-[a-z0-9]+$/u.test(pod.metadata.name)
    || pod.metadata.labels?.[appLabel] !== 'power-evolve-forbidden-listener'
    || pod.spec?.automountServiceAccountToken !== false || (pod.spec.volumes ?? []).length
    || (pod.spec.initContainers ?? []).length || (pod.spec.ephemeralContainers ?? []).length
    || pod.spec.containers?.length !== 1 || !isDeepStrictEqual(pod.spec.securityContext, listener.securityContext)) return false
  const actual = pod.spec.containers[0], expected = listener.containers[0]
  return actual.name === expected.name && !actual.env?.length && !actual.envFrom?.length && !actual.volumeMounts?.length
    && /^\S+@sha256:[a-f0-9]{64}$/u.test(actual.image)
    && ['command', 'args', 'securityContext'].every(key => isDeepStrictEqual(actual[key], expected[key]))
}

/** Resume only the original Deployment UIDs/specs, Platform before Host.
 * @param record The durable source fence, including an interrupted restoration intent.
 * @param io Context-bound patches and durable fence writer; readiness is the caller's deployment gate.
 * @returns The saved restored replica counts; no public readiness is claimed by this operation.
 */
export async function restoreDeploymentBackupWriters(record, io) {
  validateRecord(record)
  if (!['stopping', 'stopped', 'restoring', 'restored'].includes(record.phase)) refuse('Backup writers were not confirmed stopped')
  await requireNoAutoscaler(record.scope, io)
  if (record.phase === 'restored') {
    for (const entry of record.deployments) {
      const actual = await io.getDeployment(record.scope.namespace, entry.name)
      matchesRecord(actual, entry, record.scope)
      if (actual.spec.replicas !== entry.replicas) refuse(`Backup ${entry.role} replica count changed after restoration`)
    }
    return record
  }
  if (record.phase === 'stopping') {
    // An explicit abort can resume an incomplete snapshot only after both application roles stopped.
    for (const entry of record.deployments) {
      if (!await roleStopped(record, entry, io)) refuse('Backup writers were not confirmed stopped')
      if (entry.replicas && entry.intent?.to !== 0) refuse('Backup stop lacks saved intent')
      entry.intent = { ...(entry.intent ?? {}), to: 0, state: 'confirmed' }
    }
    await io.saveFence(record)
  }
  // Verify both before resuming either, so a replaced Host cannot leave an unrelated Platform running.
  for (const entry of record.deployments) {
    const actual = await io.getDeployment(record.scope.namespace, entry.name)
    matchesRecord(actual, entry, record.scope)
    if (![0, entry.replicas].includes(actual.spec.replicas)) refuse(`Backup ${entry.role} replica count changed`)
    requireReplicaIntent(actual, entry, entry.replicas)
  }
  record.phase = 'restoring'; await io.saveFence(record)
  for (const entry of [...record.deployments].reverse()) await changeReplicas(record, entry, entry.replicas, io)
  record.phase = 'restored'; await io.saveFence(record)
  return record
}
