"""REPIN: where a local `grizzle migrate` of the draft spent its time, from the server log (log_min_duration_statement = 0,
log_statement_stats): every statement qti_admin ran on qti, attributed to the draft file whose statement it is (by its
text), to the drift check's scratch replay (grizzle_admission_* schemas, rolled back), or to grizzle's own bookkeeping
(the ledger, catalog reads); per part its statement count, summed duration and summed CPU (user + system); each draft
file's span on the server, from its first statement's start to its last one's end; and the draft's slowest statements.
Usage: python3 -I migratecost.py <server log[,log...]> <draft folder> [<from UTC timestamp>]"""
import collections, datetime, json, os, re, sys

logs, folder = sys.argv[1], sys.argv[2]
since = sys.argv[3] if len(sys.argv) > 3 else ''
meta = json.load(open(os.path.join(folder, 'meta.json')))['meta']
norm = lambda t: ' '.join(re.sub(r'^(\s*--[^\n]*\n)+', '', t).split())[:200]
owner = {}
for f in meta['files']:
    for s in f['steps']:
        if s['kind'] == 'statement':
            text = re.sub(r'(?<!:):"DBNAME"', '"qti"', s['statement'])
            owner.setdefault(norm(re.sub(r'(?<!:):"(\w+)"', r'"\1"', text)), f['name'])
lines = [l for p in logs.split(',') for l in open(p, errors='replace').read().split('\n')]
head = re.compile(r'(\S+ \S+) UTC:[^:]*:qti_admin@qti:\[(\d+)\]:\w*: LOG:  duration: ([0-9.]+) ms  (?:statement|execute [^:]*): ?(.*)')
rows = []
i = 0
while i < len(lines):
    m = head.match(lines[i])
    if m and m.group(1) >= since:
        text = [m.group(4)]
        j = i + 1
        while j < len(lines) and not re.match(r'\d{4}-\d\d-\d\d \d', lines[j]):
            text.append(lines[j])
            j += 1
        cpu = None
        for k in range(j, min(j + 12, len(lines))):
            s = re.search(r'!\s+([0-9.]+) s user, ([0-9.]+) s system, ([0-9.]+) s elapsed', lines[k])
            if s:
                cpu = float(s.group(1)) + float(s.group(2))
                break
        rows.append((m.group(1), float(m.group(3)), cpu or 0.0, '\n'.join(text)))
        i = j
    else:
        i += 1
parts = collections.defaultdict(lambda: [0, 0.0, 0.0])
spans = {}
draft = []
for ts, ms, cpu, text in rows:
    n = norm(text)
    if n in owner:
        part = owner[n]
        draft.append((ms, cpu, part, n[:150]))
    elif 'grizzle_admission_' in text:
        part = 'drift check: scratch replay (rolled back)'
    else:
        part = 'grizzle bookkeeping (ledger, locks, catalog reads)'
    parts[part][0] += 1
    parts[part][1] += ms
    parts[part][2] += cpu
    if part.endswith('.sql'):
        end = datetime.datetime.strptime(ts, '%Y-%m-%d %H:%M:%S.%f')
        start = end - datetime.timedelta(milliseconds=ms)
        first, last = spans.get(part, (start, end))
        spans[part] = (min(first, start), max(last, end))
print(f'{len(rows)} statements by qti_admin on qti, {rows[0][0] if rows else "-"} to {rows[-1][0] if rows else "-"}')
for part, (n, ms, cpu) in sorted(parts.items()):
    print(f'  {part:52s} {n:6d} statements  {ms / 1000:8.1f} s  CPU {cpu:7.1f} s')
print('each draft file from the start of its first statement to the end of its last, on the server (the transaction')
print('files are sent in one flight, so this is the window their locks are held, less BEGIN, the ledger rows and COMMIT):')
for part, (first, last) in sorted(spans.items()):
    print(f'  {part:16s} {first.time()} to {last.time()}: {(last - first).total_seconds():8.3f} s')
print('slowest draft statements:')
for ms, cpu, part, n in sorted(draft, reverse=True)[:15]:
    print(f'  {ms:9.1f} ms  CPU {cpu:6.2f} s  {part}  {n}')
