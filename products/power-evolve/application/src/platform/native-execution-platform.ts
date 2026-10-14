/** Production Platform assembly and joined teardown for the original-Agent native execution broker. */
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { Pool } from 'pg'
import type { ManagedCloudStorage } from './managed-storage.ts'
import { NativeExecutionAuthorityStore, type NativeExecutionPolicyReader,
  type NativeExecutionTaskAuthority } from './native-execution-authority-store.ts'
import { NativeExecutionBroker } from './native-execution-broker.ts'
import { NativeExecutionPods } from './native-execution-pods.ts'
import { NativeExecutionRoutes } from './native-execution-routes.ts'
import { loadNativeExecutionConfig } from './native-execution-config.ts'
import { KubernetesClient } from './kubernetes.ts'

/** Installed Platform services and retained uncertain recovery identities. */
export interface NativeExecutionPlatform {
  readonly routes: NativeExecutionRoutes
  readonly broker: NativeExecutionBroker
  readonly pods: NativeExecutionPods
  readonly uncertainProcessIds: readonly string[]
  /** Join route, broker and transport disposal before the Platform PG pool is released. */
  close(): Promise<void>
}

/** Install the trusted transport, reconcile original ranges, and publish joined native execution routes.
 * Run once per owned execution namespace before accepting requests; concurrent controllers are not supported.
 * @param ctx Platform plugin lifetime owner.
 * @param pool Platform-owned PG pool using the current adjacent schema.
 * @param tasks Original operation and native execution-cohort authority.
 * @param storage Server-owned cloud storage resolver.
 * @param policyReader Current native Session permission projection under the Session lock.
 * @param configFile Private deployment JSON path, never passed to a payload.
 * @returns Installed providers after native transport initialization and exact-name recovery.
 */
export async function installNativeExecutionPlatform(ctx: Context, pool: Pool, tasks: NativeExecutionTaskAuthority,
  storage: ManagedCloudStorage, policyReader: NativeExecutionPolicyReader, configFile: string): Promise<NativeExecutionPlatform> {
  const transport = new Context()
  const ready = Promise.withResolvers<void>()
  let disposed = false, broker: NativeExecutionBroker | undefined, routes: NativeExecutionRoutes | undefined
  let closing: Promise<void> | undefined
  const isDisposed = (): boolean => disposed
  const close = () => closing ??= (async () => {
    disposed = true; await ready.promise
    const failures: unknown[] = []
    for (const dispose of [() => routes?.dispose(), () => broker?.dispose(), () => transport.fiber.dispose()]) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Native execution Platform disposal failed')
  })()
  ctx.effect(() => close, 'Platform native execution ownership')
  try {
    const config = await loadNativeExecutionConfig(configFile)
    await transport.plugin(LocalSubprocessRuntime)
    if (isDisposed()) throw new Error('native_execution_platform_disposed')
    const kube = await KubernetesClient.fromFile(config.broker.kubeconfigPath)
    const { nodeName, ...podConfig } = config.pods
    const pods = new NativeExecutionPods(pool, kube, { ...podConfig, ...(nodeName === undefined ? {} : { nodeName }) })
    const uncertainProcessIds = await pods.recover(config.pods.maxRecoveryRows)
    if (isDisposed()) throw new Error('native_execution_platform_disposed')
    const authority = new NativeExecutionAuthorityStore(pool, tasks, storage, policyReader)
    broker = new NativeExecutionBroker(authority, pods, transport.subprocess, config.broker)
    routes = new NativeExecutionRoutes(broker, config.routes)
    return { broker, routes, pods, uncertainProcessIds, close }
  } catch (error) {
    await transport.fiber.dispose()
    throw error
  } finally { ready.resolve() }
}
