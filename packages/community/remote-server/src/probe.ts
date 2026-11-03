/**
 * The facts probe: one POSIX shell script collecting every basic fact in a
 * single round trip, and the parser for its output.
 *
 * The script only reads — `uname`, `/proc`, `sysctl`, `df`, `date`. It writes
 * nothing and changes nothing on the target. Every field falls back
 * independently and prints empty when unavailable, so a BusyBox or macOS target
 * missing one source still yields the rest.
 * @module dsh-remote-server/probe
 */

import type { ServerFacts } from './types.ts'

/**
 * The probe script, handed to the remote login shell as one command.
 *
 * `/etc/os-release` is parsed with `sed` rather than sourced: reading a file is
 * a read, sourcing it executes whatever it contains.
 */
export const PROBE_SCRIPT = [
  'p() { printf \'%s=%s\\n\' "$1" "$2"; }',
  'h=$(hostname 2>/dev/null) || h=$(uname -n 2>/dev/null) || h=',
  'p hostname "$h"',
  'os=$(sed -n \'s/^PRETTY_NAME=[\\"]\\{0,1\\}\\([^\\"]*\\)[\\"]\\{0,1\\}$/\\1/p\' /etc/os-release 2>/dev/null | head -1)',
  '[ -n "$os" ] || os=$(uname -s 2>/dev/null)',
  'p os "$os"',
  'p kernel "$(uname -r 2>/dev/null)"',
  'p arch "$(uname -m 2>/dev/null)"',
  'cpu=$(sed -n \'s/^model name[[:space:]]*: *//p\' /proc/cpuinfo 2>/dev/null | head -1)',
  '[ -n "$cpu" ] || cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)',
  '[ -n "$cpu" ] || cpu=$(sed -n \'s/^Model[[:space:]]*: *//p\' /proc/cpuinfo 2>/dev/null | head -1)',
  'p cpu_model "$cpu"',
  'cores=$(nproc 2>/dev/null) || cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || cores=$(sysctl -n hw.ncpu 2>/dev/null) || cores=',
  'p cpu_cores "$cores"',
  'mt=$(sed -n \'s/^MemTotal:[[:space:]]*\\([0-9]*\\).*/\\1/p\' /proc/meminfo 2>/dev/null | head -1)',
  'ma=$(sed -n \'s/^MemAvailable:[[:space:]]*\\([0-9]*\\).*/\\1/p\' /proc/meminfo 2>/dev/null | head -1)',
  'if [ -z "$mt" ]; then b=$(sysctl -n hw.memsize 2>/dev/null); [ -n "$b" ] && mt=$((b/1024)); fi',
  'p mem_total_kb "$mt"',
  'p mem_available_kb "$ma"',
  'd=$(df -Pk / 2>/dev/null | tail -1)',
  'dt=$(echo "$d" | awk \'{print $2}\' 2>/dev/null)',
  'da=$(echo "$d" | awk \'{print $4}\' 2>/dev/null)',
  'p disk_total_kb "$dt"',
  'p disk_available_kb "$da"',
  'up=$(cut -d\' \' -f1 /proc/uptime 2>/dev/null)',
  'if [ -z "$up" ]; then bt=$(sysctl -n kern.boottime 2>/dev/null | sed -n \'s/.*sec *= *\\([0-9]*\\).*/\\1/p\'); now=$(date +%s 2>/dev/null); if [ -n "$bt" ] && [ -n "$now" ]; then up=$((now-bt)); fi; fi',
  'p uptime_seconds "$up"',
].join('\n')

/** A trimmed non-empty field, or null. */
function text(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const value = raw.trim()
  return value.length === 0 ? null : value
}

/** A finite non-negative number, or null. */
function number(raw: string | undefined): number | null {
  const value = text(raw)
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

/**
 * Parse probe stdout into a facts snapshot.
 *
 * Unknown keys are ignored and absent keys become null, so a probe run against
 * a target that could not answer some fields still yields a usable snapshot.
 * @param stdout - the probe's standard output.
 * @param collectedAt - ISO-8601 instant to stamp the snapshot with.
 * @returns the parsed snapshot.
 */
export function parseProbe(stdout: string, collectedAt: string): ServerFacts {
  const fields = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1))
  }
  return {
    hostname: text(fields.get('hostname')),
    os: text(fields.get('os')),
    kernel: text(fields.get('kernel')),
    arch: text(fields.get('arch')),
    cpuModel: text(fields.get('cpu_model')),
    cpuCores: number(fields.get('cpu_cores')),
    memTotalKb: number(fields.get('mem_total_kb')),
    memAvailableKb: number(fields.get('mem_available_kb')),
    diskTotalKb: number(fields.get('disk_total_kb')),
    diskAvailableKb: number(fields.get('disk_available_kb')),
    uptimeSeconds: number(fields.get('uptime_seconds')),
    collectedAt,
  }
}

/** True when the probe answered nothing usable — treated as a failed collection, not an empty snapshot. */
export function isEmptyProbe(facts: ServerFacts): boolean {
  return facts.hostname === null
    && facts.os === null
    && facts.kernel === null
    && facts.arch === null
    && facts.cpuModel === null
    && facts.cpuCores === null
    && facts.memTotalKb === null
    && facts.diskTotalKb === null
    && facts.uptimeSeconds === null
}
