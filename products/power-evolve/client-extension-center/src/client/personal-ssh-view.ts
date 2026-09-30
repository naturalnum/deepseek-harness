/** Original personal SSH form, adapted to explicit retention and direct credential upload. */
import { normalizeSshFingerprint, validSshCreate, validSshUpdate, type PersonalSshConnection,
  type SshConfigurationInput, type SshCreateInput, type SshCredentialUpload, type SshUpdateInput } from './ssh-api.ts'

/** Write-only editor fields; opening an existing record never populates a secret. */
export interface PersonalSshFormValue {
  readonly displayName: string
  readonly host: string
  readonly port: string
  readonly username: string
  readonly authenticationKind: 'password' | 'private_key'
  readonly password: string
  readonly privateKey: string
  readonly passphrase: string
  readonly clearPassphrase: boolean
  readonly workingDirectory: string
  readonly hostKeySha256: string
  readonly enabled: boolean
}

/** Start the original password form without a default enabled connection.
 * @returns blank editor fields.
 */
export function emptyPersonalSshForm(): PersonalSshFormValue {
  return { displayName: '', host: '', port: '22', username: '', authenticationKind: 'password',
    password: '', privateKey: '', passphrase: '', clearPassphrase: false, workingDirectory: '', hostKeySha256: '', enabled: false }
}

/** Populate public metadata only, preserving saved secrets through explicit instructions.
 * @param connection - saved public record.
 * @returns editor values with all secret inputs blank.
 */
export function personalSshFormFromConnection(connection: PersonalSshConnection): PersonalSshFormValue {
  return { displayName: connection.displayName, host: connection.host, port: String(connection.port),
    username: connection.username, authenticationKind: connection.authentication,
    password: '', privateKey: '', passphrase: '', clearPassphrase: false,
    workingDirectory: connection.workingDirectory ?? '', hostKeySha256: connection.hostKeySha256, enabled: connection.enabled }
}

function write(form: PersonalSshFormValue, current?: PersonalSshConnection): {
  configuration: SshConfigurationInput; credentials?: SshCredentialUpload
} {
  const sameKind = current?.authentication === form.authenticationKind
  const auth: SshConfigurationInput['authentication'] = form.authenticationKind === 'password'
    ? { kind: 'password', password: form.password === '' ? 'retain' : 'replace' }
    : { kind: 'private_key', privateKey: form.privateKey === '' ? 'retain' : 'replace',
      passphrase: form.clearPassphrase ? 'clear' : form.passphrase !== '' ? 'replace' : sameKind ? 'retain' : 'clear' }
  const fields = form.authenticationKind === 'password'
    ? form.password === '' ? {} : { password: form.password }
    : { ...(form.privateKey === '' ? {} : { privateKey: form.privateKey }),
      ...(form.clearPassphrase || form.passphrase === '' ? {} : { passphrase: form.passphrase }) }
  return { configuration: { displayName: form.displayName.trim(), host: form.host.trim().replace(/^\[([^\]]+)\]$/u, '$1'),
    port: Number(form.port), username: form.username.trim(), authentication: auth,
    workingDirectory: form.workingDirectory.trim() === '' ? null : form.workingDirectory.trim(),
    hostKeySha256: normalizeSshFingerprint(form.hostKeySha256), enabled: form.enabled },
    ...(Object.keys(fields).length === 0 ? {} : { credentials: { formatVersion: 2, ...fields } }) }
}

/** Build a new connection using only replacement credentials.
 * @param form - validated editor fields.
 * @param requestId - stable mutation identity.
 * @returns browser-local creation input.
 */
export function buildPersonalSshCreate(form: PersonalSshFormValue, requestId: string): SshCreateInput {
  const value = write(form)
  return { requestId, configuration: value.configuration, credentials: value.credentials ?? { formatVersion: 2 } }
}

/** Build an edit against the record originally opened by the editor.
 * @param form - validated editor fields.
 * @param current - saved revision captured when opening the editor.
 * @param requestId - stable mutation identity.
 * @returns browser-local update input with exact replacement fields.
 */
export function buildPersonalSshUpdate(form: PersonalSshFormValue, current: PersonalSshConnection, requestId: string): SshUpdateInput {
  return { requestId, connectionId: current.connectionId, baseRevision: current.revision, ...write(form, current) }
}

/** Preserve the old form's remote path and PEM validation, with the fixed DTO byte budgets.
 * @param form - current editor fields.
 * @param current - saved metadata when editing, otherwise absent.
 * @returns whether submission is valid; a changed authentication kind requires a new secret.
 */
export function validPersonalSshForm(form: PersonalSshFormValue, current?: PersonalSshConnection): boolean {
  const directory = form.workingDirectory.trim()
  if (directory !== '' && !/^(?:\/|~(?:\/|$))/u.test(directory)) return false
  const secret = form.authenticationKind === 'password' ? form.password : form.privateKey
  if (secret === '' && !(current?.authentication === form.authenticationKind && current.secretConfigured)) return false
  if (form.authenticationKind === 'private_key' && form.privateKey !== ''
    && !/^-----BEGIN (OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]+-----END \1PRIVATE KEY-----\s*$/u.test(form.privateKey)) return false
  const requestId = '00000000-0000-4000-8000-000000000000'
  return current ? validSshUpdate(buildPersonalSshUpdate(form, current, requestId)) : validSshCreate(buildPersonalSshCreate(form, requestId))
}
