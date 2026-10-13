/** Render the exact POSIX SSH command before recording approval, digest and ciphertext. */
import { PlatformError } from '../contracts.ts'

const MAX_COMMAND_BYTES = 16_384
const MAX_DIRECTORY_CHARACTERS = 1024
const DIRECTORY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

function losslessUtf8(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Preserve the command and quote its remote working directory without further expansion.
 * Empty directory strings are invalid; callers normalize absent directories to null. Directory
 * length uses the management DTO's JavaScript string length, and directory bytes are not trimmed.
 * Relative paths, `~` and `~/…` require a nonempty remote HOME. A failed cd exits the shell before
 * any part of the original command, including an OR branch, can run.
 * @param command - nonempty, NUL-free, lossless UTF-8 command; its shell syntax stays unchanged.
 * @param workingDirectory - literal absolute path or remote HOME-relative path, otherwise null.
 * @returns the complete command to freeze into approval, digest and ciphertext, at most 16384 UTF-8 bytes.
 * @throws PlatformError with a sanitized command or directory validation code.
 */
export function renderSshCommand(command: string, workingDirectory: string | null): string {
  if (command === '' || command.includes('\0') || !losslessUtf8(command)
    || Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    throw new PlatformError(400, 'ssh_command_invalid')
  }
  if (workingDirectory === null) return command
  if (workingDirectory === '' || workingDirectory.length > MAX_DIRECTORY_CHARACTERS
    || DIRECTORY_CONTROL.test(workingDirectory) || !losslessUtf8(workingDirectory)) {
    throw new PlatformError(400, 'ssh_working_directory_invalid')
  }
  const destination = workingDirectory.startsWith('/') ? literal(workingDirectory)
    : workingDirectory === '~' ? '"${HOME:?}"'
      : `"\${HOME:?}"/${literal(workingDirectory.startsWith('~/') ? workingDirectory.slice(2) : workingDirectory)}`
  const rendered = `CDPATH=; export CDPATH\ncd -- ${destination} || exit\n${command}`
  if (Buffer.byteLength(rendered, 'utf8') > MAX_COMMAND_BYTES) {
    throw new PlatformError(400, 'ssh_command_invalid')
  }
  return rendered
}
