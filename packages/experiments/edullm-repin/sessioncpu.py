# The publisher session's statements in a server log, each with its duration and its CPU (log_statement_stats), named by
# the served file's statement index where the served file names it; totals before COMMIT and COMMIT's own.
# Usage: python3 -I sessioncpu.py <server log[,log...]> <served publisher_app.json> [user filter, default ledger__publisher_app] [pid]
import json, re, sys
log, served = sys.argv[1], sys.argv[2]
who = sys.argv[3] if len(sys.argv) > 3 else 'ledger__publisher_app'
pid = sys.argv[4] if len(sys.argv) > 4 else None
d = json.load(open(served))
st = d['roles']['~a'][0]['members']['~a'][0]['variants']['change']['program']['statements']['~a']
index = {}
def walk(x, i, path):
    if isinstance(x, dict):
        if isinstance(x.get('name'), str) and isinstance(x.get('sql'), str):
            index[x['name']] = f'{i}{path}'
        for k, v in x.items(): walk(v, i, path + '/' + k)
    elif isinstance(x, list):
        for j, v in enumerate(x): walk(v, i, path + '/' + str(j))
for i, s in enumerate(st): walk(s, i, '')
lines = [l for f in log.split(',') for l in open(f, errors='replace').read().split('\n')]
rows = []
pending = None
for k, l in enumerate(lines):
    if who + '@' not in l or (pid is not None and f':[{pid}]:' not in l): continue
    m = re.search(r'duration: ([0-9.]+) ms  (?:execute (grizzle_[a-z0-9]+)|statement: (.*))', l)
    if m:
        pending = [m.group(2) or (m.group(3) or '')[:40], float(m.group(1)), None]
        rows.append(pending)
        continue
    if 'MESSAGE STATISTICS' in l or 'QUERY STATISTICS' in l:
        for j in range(k, k + 6):
            s = re.search(r'!\s+([0-9.]+) s user, ([0-9.]+) s system, ([0-9.]+) s elapsed', lines[j])
            if s and pending is not None and pending[2] is None:
                pending[2] = (float(s.group(1)), float(s.group(2)))
                break
before = 0.0; commit = None; per = {}
for name, ms, cpu in rows:
    c = (cpu[0] + cpu[1]) if cpu else 0.0
    if name.strip().upper().startswith('COMMIT'):
        commit = (ms / 1000, c, cpu); break
    before += c
    key = index.get(name, name)
    per[key] = per.get(key, 0.0) + c
print(f'statements before COMMIT: {len(rows) - 1}, CPU {before:.1f} s; COMMIT: wall {commit[0]:.1f} s, CPU {commit[1]:.1f} s {commit[2]}' if commit else f'no COMMIT found; CPU so far {before:.1f} s')
for key, c in sorted(per.items(), key=lambda t: -t[1])[:15]:
    print(f'  {c:9.2f} s  {key}')
