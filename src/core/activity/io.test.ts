import { describe, expect, it } from 'vitest';

import {
  DARWIN_DISK_SCRIPT,
  ownedByPid,
  parseNettop,
  parseProcIo,
  parseSs,
  parseTriples,
  rateByPid,
} from './io.js';

describe('disk counters', () => {
  it('reads the python script output and skips other lines', () => {
    expect([...parseTriples('12 100 200\n\nTraceback\n13 0 5\n')]).toStrictEqual([
      [12, { read: 100, write: 200 }],
      [13, { read: 0, write: 5 }],
    ]);
  });

  it('asks proc_pid_rusage for flavor 2 and prints the disk fields', () => {
    expect(DARWIN_DISK_SCRIPT).toContain('proc_pid_rusage(int(arg), 2');
    expect(DARWIN_DISK_SCRIPT).toContain('r.v[16], r.v[17]');
  });

  it('reads /proc/<pid>/io', () => {
    const text =
      'rchar: 9\nwchar: 9\nread_bytes: 4096\nwrite_bytes: 8192\ncancelled_write_bytes: 0\n';
    expect(parseProcIo(text)).toStrictEqual({ read: 4096, write: 8192 });
    expect(parseProcIo('rchar: 1\n')).toBeNull();
  });

  it('keys counters by pid as text', () => {
    expect([...ownedByPid(new Map([[7, { read: 1, write: 2 }]]))]).toStrictEqual([
      ['7', { pid: 7, read: 1, write: 2 }],
    ]);
  });
});

describe('parseNettop', () => {
  it('reads name.pid rows, including names with dots', () => {
    const out = [
      ',bytes_in,bytes_out,',
      'launchd.1,0,0,',
      'com.apple.WebKit.88,10,20,',
      'odd,1,2,',
      'node.5,x,2,',
      'node.6,1,y,',
    ].join('\n');
    expect([...parseNettop(out)]).toStrictEqual([
      ['1', { pid: 1, read: 0, write: 0 }],
      ['88', { pid: 88, read: 10, write: 20 }],
    ]);
  });
});

describe('parseSs', () => {
  it('reads bytes per socket and the first owner', () => {
    const out = [
      'ESTAB 0 0 10.0.0.1:22 10.0.0.2:5555 users:(("sshd",pid=12,fd=4),("sshd",pid=13,fd=4))',
      '\t cubic wscale:7,7 bytes_sent:900 bytes_acked:800 bytes_received:300 segs_out:9',
      'ESTAB 0 0 10.0.0.1:80 10.0.0.3:6000',
      '\t cubic bytes_acked:5',
      'ESTAB 0 0 10.0.0.1:81 10.0.0.4:6001 users:(("node",pid=20,fd=9))',
      '\t cubic rto:200',
      '\t orphan info line',
      'short pid=3',
      'a b c pid=4',
      '',
    ].join('\n');
    expect([...parseSs(out)]).toStrictEqual([
      ['10.0.0.1:22 10.0.0.2:5555', { pid: 12, read: 300, write: 800 }],
      ['10.0.0.1:81 10.0.0.4:6001', { pid: 20, read: 0, write: 0 }],
    ]);
  });
});

describe('rateByPid', () => {
  it('sums per pid over keys in both samples and floors drops at 0', () => {
    const before = new Map([
      ['a', { pid: 1, read: 100, write: 100 }],
      ['b', { pid: 1, read: 0, write: 50 }],
      ['c', { pid: 2, read: 500, write: 500 }],
    ]);
    const after = new Map([
      ['a', { pid: 1, read: 300, write: 100 }],
      ['b', { pid: 1, read: 100, write: 10 }],
      ['c', { pid: 2, read: 100, write: 900 }],
      ['new', { pid: 3, read: 1000, write: 1000 }],
    ]);
    expect([...rateByPid(before, after, 2)]).toStrictEqual([
      [1, { read: 150, write: 0 }],
      [2, { read: 0, write: 200 }],
    ]);
  });
});
