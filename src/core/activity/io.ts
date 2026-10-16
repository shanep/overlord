// Disk and network byte counters per process. Every source gives running
// totals, so the monitor turns two samples into a rate.
//
// Disk: macOS keeps per process disk bytes in proc_pid_rusage, which only C
// can call, so a short python3 script reads it through ctypes. Linux has
// /proc/<pid>/io.
//
// Network: macOS `nettop` lists bytes per process. Linux has no per process
// counter, so `ss` gives bytes per TCP socket and the socket's owner.

/** Running totals: bytes read and written, or received and sent. */
export interface Counter {
  readonly read: number;
  readonly write: number;
}

/** A counter and the process it belongs to, keyed by whatever the source counts (a pid or a socket). */
export interface OwnedCounter extends Counter {
  readonly pid: number;
}

/**
 * Prints "pid read written" for each pid given. rusage_info_v2 starts with a
 * 16 byte uuid, then 64 bit fields; disk bytes read and written are the 17th
 * and 18th. Flavor 2 is RUSAGE_INFO_V2.
 */
export const DARWIN_DISK_SCRIPT = [
  'import ctypes, sys',
  "lib = ctypes.CDLL('/usr/lib/libproc.dylib')",
  'class R(ctypes.Structure):',
  "    _fields_ = [('uuid', ctypes.c_uint8 * 16), ('v', ctypes.c_uint64 * 18)]",
  'for arg in sys.argv[1:]:',
  '    r = R()',
  '    if lib.proc_pid_rusage(int(arg), 2, ctypes.byref(r)) == 0:',
  '        print(arg, r.v[16], r.v[17])',
].join('\n');

/** Lines of three numbers: pid, then two counters. Anything else is skipped. */
export function parseTriples(stdout: string): Map<number, Counter> {
  const out = new Map<number, Counter>();
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\s+(\d+)\s+(\d+)$/u.exec(line.trim());
    if (match !== null) {
      const [, pid = '', read = '', write = ''] = match;
      out.set(Number(pid), { read: Number(read), write: Number(write) });
    }
  }
  return out;
}

/** read_bytes and write_bytes from /proc/<pid>/io, the bytes that reached the disk. */
export function parseProcIo(text: string): Counter | null {
  const read = /^read_bytes:\s*(\d+)$/mu.exec(text)?.[1];
  const write = /^write_bytes:\s*(\d+)$/mu.exec(text)?.[1];
  if (read === undefined || write === undefined) {
    return null;
  }
  return { read: Number(read), write: Number(write) };
}

/** Arguments for one `nettop` sample of every process, without name lookups (which take seconds). */
export const NETTOP_ARGS = ['-P', '-n', '-L', '1', '-x', '-J', 'bytes_in,bytes_out'];

/** `nettop -P -L 1 -x -J bytes_in,bytes_out` CSV, keyed by pid. Rows are "name.pid,in,out,". */
export function parseNettop(stdout: string): Map<string, OwnedCounter> {
  const out = new Map<string, OwnedCounter>();
  for (const line of stdout.split('\n')) {
    const [label = '', received = '', sent = ''] = line.split(',');
    const pid = label.slice(label.lastIndexOf('.') + 1);
    if (!/^\d+$/u.test(pid) || !/^\d+$/u.test(received) || !/^\d+$/u.test(sent)) {
      continue;
    }
    out.set(pid, { pid: Number(pid), read: Number(received), write: Number(sent) });
  }
  return out;
}

/** Arguments for `ss`: TCP sockets, numeric, with process and byte counts, no header. */
export const SS_ARGS = ['-t', '-n', '-i', '-p', '-H'];

function countOf(match: RegExpExecArray | null): number {
  return match === null ? 0 : Number(match[1]);
}

/** State, two queue sizes, then the local and peer addresses. */
const SOCKET_LINE = /^\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)/u;

/**
 * `ss -tnipH` output, keyed by the socket's two addresses. Each socket line
 * names its owners as users:(("name",pid=1,fd=3)), and the indented line after
 * it holds bytes_acked (sent) and bytes_received. A socket shared by several
 * processes counts for the first.
 */
export function parseSs(stdout: string): Map<string, OwnedCounter> {
  const out = new Map<string, OwnedCounter>();
  let pending: { readonly key: string; readonly pid: number } | null = null;
  for (const line of stdout.split('\n')) {
    if (/^\s/u.test(line)) {
      if (pending !== null) {
        out.set(pending.key, {
          pid: pending.pid,
          read: countOf(/\bbytes_received:(\d+)/u.exec(line)),
          write: countOf(/\bbytes_acked:(\d+)/u.exec(line)),
        });
      }
      pending = null;
      continue;
    }
    const socket = SOCKET_LINE.exec(line);
    const pid = /pid=(\d+)/u.exec(line)?.[1];
    pending =
      socket === null || pid === undefined
        ? null
        : { key: `${String(socket[1])} ${String(socket[2])}`, pid: Number(pid) };
  }
  return out;
}

/** Bytes per second between two samples, for keys present in both. A counter that went down counts as 0. */
export function rateByPid(
  before: ReadonlyMap<string, OwnedCounter>,
  after: ReadonlyMap<string, OwnedCounter>,
  seconds: number,
): Map<number, Counter> {
  const out = new Map<number, Counter>();
  for (const [key, now] of after) {
    const then = before.get(key);
    if (then === undefined) {
      continue;
    }
    const sum = out.get(now.pid) ?? { read: 0, write: 0 };
    out.set(now.pid, {
      read: sum.read + Math.max(0, now.read - then.read) / seconds,
      write: sum.write + Math.max(0, now.write - then.write) / seconds,
    });
  }
  return out;
}

/** Disk counters keyed by pid as a string, so rateByPid handles them the same way. */
export function ownedByPid(counters: ReadonlyMap<number, Counter>): Map<string, OwnedCounter> {
  return new Map(
    [...counters].map(([pid, counter]) => [String(pid), { pid, ...counter }] as const),
  );
}
