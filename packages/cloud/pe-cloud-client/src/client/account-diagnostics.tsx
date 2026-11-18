/** Allocation history inside the original scoped account settings panel. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import css from './account-management.module.css'

/** Exact bounded request fields sent by the existing account transport. */
export interface DiagnosticQuery {
  readonly accountId: string
  readonly sessionId: string
  readonly fromMs: number
  readonly toMs: number
  readonly limit: number
}
interface DiagnosticRow {
  readonly allocationId: string
  readonly observedAt: string
  readonly state: string
  readonly reasonCode: string | null
  readonly stage: string | null
}

/** Latest scoped query and sanitized display state. */
export type Diagnosis = { readonly phase: 'idle' | 'pending' | 'denied' | 'failed' | 'invalid' }
  | { readonly phase: 'ready'; readonly entries: readonly DiagnosticRow[]; readonly more: boolean }

/** Decode a bounded result within the exact original query.
 * @param input Untrusted JSON response.
 * @param target Original query from this view.
 * @returns Only fields the scoped settings table may show.
 */
export function readDiagnosis(input: unknown, target: DiagnosticQuery): Diagnosis {
  if (input === null || typeof input !== 'object') throw new TypeError('Invalid diagnostic response')
  const entries: unknown = Reflect.get(input, 'entries'), more: unknown = Reflect.get(input, 'more')
  if (!Array.isArray(entries) || entries.length > target.limit || typeof more !== 'boolean') throw new TypeError('Invalid diagnostic response')
  const projection = entries.map((entry: unknown): DiagnosticRow => {
    if (entry === null || typeof entry !== 'object') throw new TypeError('Invalid diagnostic row')
    const { accountId, sessionId, allocationId, observedAt, state, reasonCode, stage } = entry as Record<string, unknown>
    const at = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN
    if (accountId !== target.accountId || sessionId !== target.sessionId || typeof allocationId !== 'string' || allocationId.length > 256
      || typeof observedAt !== 'string' || !Number.isFinite(at) || at < target.fromMs || at >= target.toMs
      || typeof state !== 'string' || state.length > 32
      || (reasonCode !== null && (typeof reasonCode !== 'string' || reasonCode.length > 64))
      || (stage !== null && (typeof stage !== 'string' || stage.length > 64))) throw new TypeError('Invalid diagnostic row')
    return { allocationId, observedAt, state, reasonCode, stage }
  })
  return { phase: 'ready', entries: projection, more }
}

/** Render the exact lookup and the last scoped response.
 * @param props Current settings locale, lookup callback and diagnostic state.
 * @returns The account settings diagnostic form.
 */
export function AccountDiagnostics({ t, diagnosis, query }: PropsLocale<'cloud-account-management'> & {
  diagnosis: Diagnosis
  query: (request: DiagnosticQuery) => void
}) {
  return <form className={css.card} onSubmit={(event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const text = (key: string): string => String(data.get(key) ?? '').trim()
    query({ accountId: text('accountId'), sessionId: text('sessionId'),
      fromMs: Date.parse(text('from') + 'Z'), toMs: Date.parse(text('to') + 'Z'), limit: 10 })
  }}>
    <h2>{t('diagnosticTitle')}</h2>
    <div className={css.diagnosticsGrid}>
      <label className={css.field}>{t('diagnosticAccount')}<Input required name="accountId" maxLength={256}/></label>
      <label className={css.field}>{t('diagnosticSession')}<Input required name="sessionId" maxLength={256}/></label>
      <label className={css.field}>{t('diagnosticFrom')}<Input className={clsx(css.control)} required name="from" type="datetime-local" step="0.001"/></label>
      <label className={css.field}>{t('diagnosticTo')}<Input className={clsx(css.control)} required name="to" type="datetime-local" step="0.001"/></label>
    </div>
    <div><Button type="submit" variant="outline" disabled={diagnosis.phase === 'pending'}>{t('diagnosticRun')}</Button></div>
    {diagnosis.phase === 'pending' && <p role="status">{t('pending')}</p>}
    {diagnosis.phase === 'denied' && <p role="alert" className={css.error}>{t('diagnosticDenied')}</p>}
    {diagnosis.phase === 'failed' && <p role="alert" className={css.error}>{t('diagnosticFailed')}</p>}
    {diagnosis.phase === 'invalid' && <p role="alert" className={css.error}>{t('diagnosticInvalid')}</p>}
    {diagnosis.phase === 'ready' && (diagnosis.entries.length === 0
      ? <p role="status">{t('diagnosticEmpty')}</p>
      : <div className={css.diagnosticsTable}><table><thead><tr>
        <th scope="col">{t('diagnosticObserved')}</th><th scope="col">{t('diagnosticAllocation')}</th>
        <th scope="col">{t('diagnosticState')}</th><th scope="col">{t('diagnosticReason')}</th><th scope="col">{t('diagnosticStage')}</th>
      </tr></thead><tbody>{diagnosis.entries.map(row => <tr key={row.allocationId}>
        <td><time dateTime={row.observedAt}>{row.observedAt}</time></td><td>{row.allocationId}</td><td>{row.state}</td>
        <td>{row.reasonCode ?? '—'}</td><td>{row.stage ?? '—'}</td>
      </tr>)}</tbody></table></div>)}
    {diagnosis.phase === 'ready' && diagnosis.more && <p role="status">{t('diagnosticMore')}</p>}
  </form>
}
