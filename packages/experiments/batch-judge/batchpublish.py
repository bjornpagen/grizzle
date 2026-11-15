"""batch-judge: a batched publish in an edullm tree, written as edullm would write it, by rewriting its own sources
in place (never committed; the tree is a scratch clone):

- pantry's src/qti/logins.ts gains `replaceBatchWrite`: `replaceWrite` with every `r.eq(<term>, r.param("package",
  PackageName))` read as a match of the relation parameter `packages` ({ name }) at that term, so each delete selects
  the stored rows of every package the call names, and the inserts take every package's facts.
- qti-database's src/publisher.ts gains `publishBatch`: `publish` over `replaceBatchWrite`, its published keys'
  queries each matching `packages` where they read the parameter `package`, and the read-backs as they are; the
  publisher's workload holds both.
- qti-database's src/publication.ts gains `publishPackages`: every package's rows (importRowsOf) concatenated by
  relation, written by `publishBatch` with `packages` the names.
- data-infrastructure's scripts/importpar-batch.ts: importpar-publish.ts for a list of packages, one write.

Usage: python3 -I batchpublish.py <edullm tree>"""
import os, re, sys
tree = sys.argv[1]
pantry = os.path.join(tree, "packages/qti-pie/packages/pantry/src/qti/logins.ts")
publisher = os.path.join(tree, "packages/data/qti-database/src/publisher.ts")
publication = os.path.join(tree, "packages/data/qti-database/src/publication.ts")
driver = os.path.join(tree, "packages/platform/data-infrastructure/scripts/importpar-publish.ts")

s = open(pantry).read()
start = s.index("export const replaceWrite = deletingEvery(")
end = s.index("\n);\n", start) + 4
body = s[start:end].replace("export const replaceWrite =", "export const replaceBatchWrite =")
body, n = re.subn(r'\.where\(r\.eq\(([^,()]+), r\.param\("package", PackageName\)\)\)',
                  r'.match(r.relation("packages", { name: PackageName }), { name: \1 })', body)
assert 'r.param(' not in body, "a parameter left in replaceBatchWrite"
s = s[:end] + "\n/** `replaceWrite` over the packages the call names, its relation parameter `packages`. */\n" + body + s[end:]
open(pantry, "w").write(s)
print(f"replaceBatchWrite: {n} deletes over packages")

p = open(publisher).read()
p = p.replace('import { authorWrites, replaceWrite } from "@qti-pie/pantry/qti/logins.ts"',
              'import { authorWrites, replaceBatchWrite, replaceWrite } from "@qti-pie/pantry/qti/logins.ts"')
ks = p.index("const namesOf = (declared")
ke = p.index("/**\n * One package's publication, one transaction")
keys = p[ks:ke]
keys = keys.replace("const namesOf = (declared", "const namesOfBatch = (declared")
keys = keys.replace("const writeKeys = ChangeSet", "const writeBatchKeys = ChangeSet")
keys = keys.replace("namesOf(ResponseName)", "namesOfBatch(ResponseName)").replace("namesOf(OutcomeName)", "namesOfBatch(OutcomeName)")
keys, m = re.subn(r'const pkg = r\.param\("package", PackageName\)\n(\t+)', lambda mm:
                  f'const batch = r.relation("packages", {{ name: PackageName }})\n{mm.group(1)}const {{ name: pkg }} = v(batch, "batch")\n{mm.group(1)}', keys)
keys, m2 = re.subn(r'return r\n(\t+)\.match\(', lambda mm: f'return r\n{mm.group(1)}.match(batch, {{ name: pkg }})\n{mm.group(1)}.match(', keys)
keys, m3 = re.subn(r'return r\.match\((\w+), \{ package: pkg', lambda mm: f'return r.match(batch, {{ name: pkg }}).match({mm.group(1)}, {{ package: pkg', keys)
assert 'r.param(' not in keys, "a parameter left in the batch keys"
pe = p.index("/** The publisher's login")
pub = p[p.index("const publish = ChangeSet.sequence"):pe]
pub = pub.replace("const publish = ChangeSet.sequence(ChangeSet.union(replaceWrite, writePolicy), writeKeys)",
                  "const publishBatch = ChangeSet.sequence(ChangeSet.union(replaceBatchWrite, writePolicy), writeBatchKeys)")
p = p[:pe] + keys + pub + p[pe:]
p = p.replace("workload: [workload(Publisher, { publish })]", "workload: [workload(Publisher, { publish, publishBatch })]")
open(publisher, "w").write(p)
print(f"publishBatch: {m} key queries over packages, {m2 + m3} matches")

q = open(publication).read()
q += '''
/** Publishes every package of `pkgs` in one write (`publishBatch`): their rows concatenated by relation, `packages` their
 * names. */
export const publishPackages = Effect.fn("qti.publish.batch")(function* (pkgs: ReadonlyArray<QtiPackage>) {
\tconst rows = yield* Effect.forEach(pkgs, (pkg) => importRowsOf(pkg))
\tconst [first, ...rest] = rows
\tif (first === undefined) {
\t\treturn yield* Effect.die(new Error("no package"))
\t}
\tconst insert = Rec.map(first.insert, (facts, relation) => [
\t\t...facts,
\t\t...rest.flatMap((r) => r.insert[relation])
\t])
\tconst outcome = yield* Effect.scoped(
\t\tEffect.flatMap(Db.open(ServedPublisher.roles.publisher, {}), (db) =>
\t\t\tdb.workload.publishBatch.once({
\t\t\t\tparams: { packages: Arr.map(rows, (r) => ({ name: r.package })), types: policyTypes },
\t\t\t\tfacts: { insert }
\t\t\t})
\t\t)
\t)
\treturn { packages: Arr.map(rows, (r) => r.package), outcome }
})
'''
open(publication, "w").write(q)

d = open(driver).read()
d = d.replace('import { publisherDbLayer, publishPackage } from "@edullm/qti-database/publication"',
              'import { publisherDbLayer, publishPackages } from "@edullm/qti-database/publication"')
a = d.index("const [dir, name] = process.argv.slice(2)")
d = d[:a] + '''const [list] = process.argv.slice(2)
if (list === undefined) {
\tthrow new Error("usage: importpar-batch.ts <list of package dir and name, tab-separated>")
}
const entries = readFileSync(list, "utf8").split("\\n").filter((l) => l !== "").map((l) => l.split("\\t"))

const program = Effect.gen(function* () {
\tconst t0 = performance.now()
\tconst pkgs = yield* Effect.forEach(entries, ([dir, name]) => readPackage(dir ?? "", name ?? ""))
\tconst t1 = performance.now()
\tconst { packages, outcome } = yield* publishPackages(pkgs).pipe(
\t\tEffect.catchIf(
\t\t\t(error) => "kind" in error && error.kind === "refused",
\t\t\t(error) => refusalOf(error.refused, error.witness)
\t\t)
\t)
\tconst t2 = performance.now()
\tyield* Console.log(
\t\tJSON.stringify({ packages: packages.length, outcome: outcome.kind, readMs: Math.round(t1 - t0), publishMs: Math.round(t2 - t1) })
\t)
})

NodeRuntime.runMain(program.pipe(Effect.provide([publisherDbLayer(connectionAs), NodeServices.layer])))
'''
open(os.path.join(os.path.dirname(driver), "importpar-batch.ts"), "w").write(d)
print("importpar-batch.ts written")
