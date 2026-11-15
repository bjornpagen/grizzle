"""batch-judge (edullm-repin's sessioncpu.py, filtered by database): a publisher session's statements in a server log
written with log_min_duration_statement = 0 and log_statement_stats = on, each with its duration and its backend CPU,
summed before each COMMIT and each COMMIT's own, the costliest by prepared statement name.

Usage: python3 -I sessioncpu.py <server log[,log...]> <user@database>"""
import re, sys
logs, who = sys.argv[1], sys.argv[2]
lines = [l for f in logs.split(',') for l in open(f, errors='replace').read().split('\n')]
rows, pending = [], None
for k, l in enumerate(lines):
    if f':{who}:' not in l:
        continue
    m = re.search(r'duration: ([0-9.]+) ms  (?:execute (grizzle_[a-z0-9]+)|statement: (.*))', l)
    if m:
        pending = [m.group(2) or (m.group(3) or '')[:40], float(m.group(1)), None]
        rows.append(pending)
        continue
    if 'MESSAGE STATISTICS' in l or 'QUERY STATISTICS' in l:
        for j in range(k, min(k + 6, len(lines))):
            s = re.search(r'!\s+([0-9.]+) s user, ([0-9.]+) s system, ([0-9.]+) s elapsed', lines[j])
            if s and pending is not None and pending[2] is None:
                pending[2] = (float(s.group(1)), float(s.group(2)))
                break
before, per, n = 0.0, {}, 0
for name, ms, cpu in rows:
    c = (cpu[0] + cpu[1]) if cpu else 0.0
    if name.strip().upper().startswith('COMMIT'):
        print(f'publish {n}: statements before COMMIT: {len(per)} distinct, CPU {before:.1f} s; COMMIT: wall {ms / 1000:.1f} s, CPU {c:.1f} s')
        for key, t in sorted(per.items(), key=lambda kv: -kv[1])[:6]:
            print(f'  {t:9.2f} s  {key}')
        before, per, n = 0.0, {}, n + 1
        continue
    before += c
    per[name] = per.get(name, 0.0) + c
if per:
    print(f'no COMMIT after the last {len(per)} statements; CPU {before:.1f} s')
