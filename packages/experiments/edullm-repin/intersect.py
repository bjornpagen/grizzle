"""REPIN: the columns two arms' tables share, for table-md5.sh, and the tables and columns only one arm holds.
Usage: python3 -I intersect.py <base columns.tsv> <repin columns.tsv> <out columns file>"""
import sys
read = lambda p: {l.split('\t')[0]: l.rstrip('\n').split('\t')[1].split(',') for l in open(p) if '\t' in l}
a, b = read(sys.argv[1]), read(sys.argv[2])
with open(sys.argv[3], 'w') as out:
    for t in sorted(set(a) & set(b)):
        shared = [c for c in a[t] if c in set(b[t])]
        out.write(f'{t}\t{",".join(shared)}\n')
        if set(a[t]) != set(b[t]):
            print(f'{t}: base only {sorted(set(a[t]) - set(b[t]))}, repin only {sorted(set(b[t]) - set(a[t]))}')
for t in sorted(set(a) - set(b)):
    print(f'{t}: base only')
for t in sorted(set(b) - set(a)):
    print(f'{t}: repin only')
