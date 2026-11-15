"""REPIN: the two arms compared. Per import step, each table's md5 (over the columns both arms hold) in the base and the
repin arm, and every table whose row count or md5 differs; then each publish's wall time and the CPU of its session's
statements before COMMIT and of COMMIT itself, from the server log (sessioncpu.py's reading).
Usage: python3 -I compare.py <arms out dir> <clusters dir> <base tree> <port tree>"""
import collections, glob, os, re, subprocess, sys

out, clusters, base_tree, port_tree = sys.argv[1:5]
here = os.path.dirname(os.path.abspath(__file__))
read = lambda p: {l.split('\t')[0]: l.rstrip('\n').split('\t')[1:] for l in open(p) if '\t' in l} if os.path.exists(p) else {}

print('== md5 per table, base arm against repin arm (the columns both hold)')
for step in ('empty', 'g3t15', 'both'):
    b = read(f'{out}/md5-{step}-base.tsv') or read(f'{out}/base/md5-{step}.tsv')
    r = read(f'{out}/md5-{step}-repin.tsv') or read(f'{out}/repin/md5-{step}.tsv')
    if not b or not r:
        print(f'{step}: missing ({len(b)} base, {len(r)} repin tables)')
        continue
    differ = [t for t in sorted(set(b) | set(r)) if b.get(t) != r.get(t)]
    rows = sum(int(v[0]) for v in b.values())
    print(f'{step}: {len(b)} tables, {rows:,} rows in the base arm; {len(set(b) & set(r)) - len(differ)} identical; '
          f'{len(differ)} differ')
    for t in differ:
        print(f'   {t}: base {b.get(t)} repin {r.get(t)}')

print('\n== publishes')
for arm, tree in (('base', base_tree), ('repin', port_tree)):
    served = f'{tree}/packages/data/qti-database/install/migrations/qti/served/publisher_app.json'
    logs = ','.join(sorted(glob.glob(f'{clusters}/{arm}/log/postgresql-*.log')))
    for name in ('alphascience-g3-v2-scroll-pilot-g3t15', 'g3-science-shadow-g3-15'):
        d = f'{out}/{arm}/{name}'
        if not os.path.exists(f'{d}/publish.log'):
            print(f'{arm} {name}: no publish')
            continue
        publish = open(f'{d}/publish.log').read()
        wall = re.search(r'wall ([0-9.]+) s, user ([0-9.]+) s, sys ([0-9.]+) s, maxrss (\d+)', publish)
        ms = re.search(r'"publishMs":(\d+)', publish)
        outcome = re.search(r'"outcome":"(\w+)"', publish)
        pids = collections.Counter()
        if os.path.exists(f'{d}/activity.tsv'):
            for line in open(f'{d}/activity.tsv'):
                p = line.split('\t')
                if len(p) > 3 and p[3] == 'ledger__publisher_app':
                    pids[p[1]] += 1
        pid = pids.most_common(1)[0][0] if pids else None
        cpu = subprocess.run(['python3', '-I', f'{here}/sessioncpu.py', logs, served, 'ledger__publisher_app'] +
                             ([pid] if pid else []), capture_output=True, text=True).stdout.strip()
        when = open(f'{d}/when.txt').read().split('\n')
        print(f'{arm} {name}: outcome {outcome.group(1) if outcome else "?"}, publish {int(ms.group(1)) / 1000 if ms else "?"} s, '
              f'process wall {wall.group(1) if wall else "?"} s (client user {wall.group(2) if wall else "?"} s, '
              f'sys {wall.group(3) if wall else "?"} s, maxrss {int(wall.group(4)) // 1024 if wall else "?"} MiB); '
              f'{when[1] if len(when) > 1 else ""}')
        for line in cpu.split('\n'):
            print(f'   {line}')
