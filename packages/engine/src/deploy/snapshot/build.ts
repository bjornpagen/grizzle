import {
	catchRefusal,
	type EncodeOptions,
	everyProperty,
	type Json,
	Refusal,
	toJson,
	writeCanonicalJson
} from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { digest, ownedDigest } from "#compiler/core/fingerprint.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SchemaFingerprint as toSchemaFingerprint } from "#compiler/core/ids.ts"
import { type Lines, textOf } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Comparator, compareStrings, mapInput } from "#compiler/core/order.ts"
import { maxStringLength } from "#compiler/core/policy.ts"
import { isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import {
	ledgerGuardObject,
	ledgerObject,
	ledgerPrivilegesObject
} from "#compiler/deploy/ledger/ledger.ts"
import type { ManifestObject } from "#compiler/deploy/snapshot/objects.ts"
import { residualDigests } from "#compiler/deploy/snapshot/residual.ts"
import type {
	DeploySnapshot,
	SnapshotContent,
	SnapshotField,
	SnapshotLaw,
	SnapshotRelation,
	SnapshotTheory
} from "#compiler/deploy/snapshot/types.ts"
import type { ResidualLaw, TheoryRelation } from "#compiler/ir/law.ts"
import {
	type AccessIndexRequest,
	type InstallationManifest,
	indexOpclassText,
	type PhysicalObject,
	type PhysicalReason,
	type ProgramAccess,
	type StoredIndexRequest,
	type WorkloadAccess
} from "#compiler/ir/products.ts"
import { isolationFunctionIdent } from "#compiler/physical/ddl/isolation.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { namedIdent } from "#compiler/physical/obligations/graph.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"

/** Entries in the code-unit order of their keys. */
const byKey: Comparator<readonly [string, unknown]> = mapInput(
	compareStrings,
	(entry: readonly [string, unknown]) => entry[0]
)

/** Every property but the snapshot's own fingerprint. */
const withoutFingerprint: EncodeOptions = {
	omit: (...[key, , path]) => path.length === 0 && key === "fingerprint"
}

/**
 * The fingerprint of a snapshot's JSON value: the digest of every property but its own fingerprint. It is the content
 * fingerprint a finished snapshot records, and the integrity check of a read one, computed over the value JSON gave
 * before anything reads it as a snapshot: the digest is total over any value, so an edited or corrupted snapshot.json is
 * refused by its fingerprint and never reaches typed code (the shell's boundary/snapshot.ts).
 */
export const snapshotFingerprint = (
	value: unknown
): Result.Result<SchemaFingerprint, CompileError> =>
	Result.map(digest("snapshot", value, withoutFingerprint), toSchemaFingerprint)

/** The fingerprint of a schema's empty snapshot, which a database holds before its first migration: the source of that
 * migration and the latest target of a database without the schema's ledger. It depends on the installed schema
 * identifier alone, so a compiler change never orphans a first migration. */
export const emptyFingerprint = (schema: string): SchemaFingerprint => {
	return toSchemaFingerprint(ownedDigest("empty-snapshot", { schema }, everyProperty))
}

/** The empty snapshot of a schema: no object. Its fingerprint is emptyFingerprint, not the digest of its content. */
export const emptySnapshot = (input: {
	readonly schemaName: string
	readonly schema: string
}): DeploySnapshot => ({
	fingerprint: emptyFingerprint(input.schema),
	schemaName: input.schemaName,
	schema: input.schema,
	theory: { schema: emptyFingerprint(input.schema), relations: {}, laws: {} },
	manifest: { objects: [], edges: [], roleDefaults: [], publicRevokes: [], comments: [] },
	constraintToLaw: { tables: {}, domains: {} },
	workload: {},
	accessPaths: []
})

/** A workload access request as the snapshot records it. */
const storedRequest = (r: AccessIndexRequest): StoredIndexRequest => ({
	...r,
	keys: r.keys.map((k) => ({ expr: k.expr, dir: k.dir, opclass: indexOpclassText(k.opclass) }))
})

export const isEmptySnapshot = (s: DeploySnapshot): boolean =>
	s.fingerprint === emptyFingerprint(s.schema)

const theoryOf = (installation: Installation): SnapshotTheory => {
	const owned = installation.owned
	const theory = installation.laws.theory
	/** A stored or closed relation's heading as the snapshot records it, from its handle. */
	const heading = (t: TheoryRelation) => ({
		ident: t.ident,
		mutable: t.mutable,
		level: t.level,
		fields: t.fields.map((f) => ({
			name: f.name,
			column: f.column,
			type: canonicalDigest(f.type),
			serial: "serial" in f.type
		})),
		primaryKey: t.primaryKey
	})
	const entries: ReadonlyArray<readonly [string, SnapshotRelation]> = [
		...Object.values(owned.relations).flatMap(
			(o): ReadonlyArray<readonly [string, SnapshotRelation]> =>
				o.kind === "derived"
					? [[o.name, { kind: "derived", ident: o.ident, mutable: o.mutable, level: o.desc.level }]]
					: []
		),
		...Object.values(theory.relations).flatMap(
			(t): ReadonlyArray<readonly [string, SnapshotRelation]> =>
				t.kind === "relation" ? [[t.name, { kind: "relation", ...heading(t) }]] : []
		),
		...Object.values(installation.closedTemplates).map((c): readonly [string, SnapshotRelation] => [
			c.relation.name,
			{ kind: "closed", ...heading(c.relation), template: c.fingerprint }
		])
	]
	const relations: Record<string, SnapshotRelation> = {}
	for (const [name, relation] of entries.toSorted(byKey)) {
		relations[name] = relation
	}
	const laws: Record<string, SnapshotLaw> = {}
	const residuals = new Map<string, ResidualLaw>(
		installation.laws.residuals.map((r) => [r.lawId, r] as const)
	)
	for (const law of theory.laws.toSorted(
		mapInput(compareStrings, (l: { readonly id: string }) => l.id)
	)) {
		const r = residuals.get(law.id)
		laws[law.id] =
			r === undefined
				? { kind: "native", shape: law.shape }
				: {
						kind: "residual",
						shape: law.shape,
						residual: {
							family: r.family,
							...residualDigests(r),
							participants: r.participants.map((p) => p.relation.name)
						}
					}
	}
	return { schema: owned.fingerprint, relations, laws }
}

const canonicalDigest = (value: unknown): string => {
	const d = digest("scalar-type", value, everyProperty)
	if (!d.ok) {
		throw new Refusal(d.error)
	}
	return d.value
}

/** The roles of the installation's logins, in login name order, which Db.open's admission reads the ledger as. */
const installationLogins = (installation: Installation): ReadonlyArray<string> =>
	installation.worlds.map((l) => l.role)

/** A draft's workload: each login's programs' access, and the access requests they and the roles' write filters make. */
export interface DraftWorkload {
	readonly access: WorkloadAccess
	readonly accessPaths: ReadonlyArray<AccessIndexRequest>
}

/** The workload of a schema without one. */
export const noWorkload: DraftWorkload = { access: {}, accessPaths: [] }

interface TargetInput {
	readonly installation: Installation
	readonly workload: DraftWorkload
}

/** The target snapshot's content, built from the compiled installation of the current schema and workload, with the
 * migrations ledger's objects added to its manifest: the ledger table and its SERIALIZABLE guard trigger in Setup,
 * after the guard's function, and every login's SELECT on it in Publish. */
export const targetState = (input: TargetInput): Result.Result<SnapshotContent, CompileError> =>
	catchRefusal(() => {
		const { installation } = input
		const schema = installation.names.schema
		const objects: Array<ManifestObject> = []
		/** The ledger and its guard follow the isolation function the guard runs, so the first Setup file creates the
		 * function before the ledger. */
		const ledger = ledgerObject(schema)
		const guard = ledgerGuardObject(schema)
		for (const o of installation.manifest.objects) {
			objects.push(o)
			if (o.kind === "isolationFunction") {
				objects.push(ledger, guard)
			}
		}
		const privileges = ledgerPrivilegesObject(schema, installationLogins(installation))
		if (privileges !== undefined) {
			objects.push(privileges)
		}
		/** The installation's edges, in its order (by the identities its objects' names were minted from), then the
		 * ledger's. */
		const edges = [
			...installation.manifest.edges,
			{ from: namedIdent("schema", schema), to: ledger.ident },
			{ from: isolationFunctionIdent(schema), to: guard.ident },
			{ from: ledger.ident, to: guard.ident }
		]
		return {
			schemaName: installation.owned.name,
			schema,
			theory: theoryOf(installation),
			manifest: { ...installation.manifest, objects, edges },
			constraintToLaw: {
				tables: sortedOwners(installation.constraintToLaw.tables),
				domains: sortedOwners(installation.constraintToLaw.domains)
			},
			workload: input.workload.access,
			accessPaths: input.workload.accessPaths.map((r) => storedRequest(r))
		}
	})

const sortedRecord = <V>(record: Readonly<Record<string, V>>): Readonly<Record<string, V>> =>
	Object.fromEntries(Object.entries(record).toSorted(byKey))

/** One kind of owner's constraint laws, its owners and each owner's constraint names in key order. */
const sortedOwners = <V>(
	owners: Readonly<Record<string, Readonly<Record<string, V>>>>
): Readonly<Record<string, Readonly<Record<string, V>>>> =>
	sortedRecord(
		Object.fromEntries(
			Object.entries(owners).map(([owner, named]) => [owner, sortedRecord(named)] as const)
		)
	)

/** The form of a snapshot, before the canonical tags: what its fingerprint digests and what snapshot.json writes. Each
 * record of the documented form holds exactly its documented fields, and each installed statement is the statement
 * itself, every clause stated. A key whose value is absent is left out, as an undefined clause of a statement and the
 * type's default operator class of an access path's key are. The shell reads exactly this value back as the snapshot,
 * once its fingerprint holds (boundary/snapshot.ts). */
type SnapshotForm = RecordOf<never>

/** An installed statement as snapshot.json lays it out: compact, on one line of its own. The statement is the unit the
 * diff compares and a review reads, so a changed statement is one changed line. */
class StatementLine {
	readonly statement: SqlStatement
	constructor(statement: SqlStatement) {
		this.statement = statement
	}
}

/** A value of the snapshot's form whose installed statements are `S`: the statements themselves, which the fingerprint
 * digests, or their StatementLines, which snapshot.json is written from. */
type FormOf<S> =
	| string
	| number
	| boolean
	| bigint
	| S
	| ReadonlyArray<FormOf<S>>
	| { readonly [key: string]: FormOf<S> }

/** A record of the snapshot's form whose installed statements are `S`. */
type RecordOf<S> = { readonly [key: string]: FormOf<S> }

/** How a form holds an installed statement. */
type Statement<S> = (s: SqlStatement) => S

/** Each statement as itself. */
const asStatement: Statement<SqlStatement> = (s) => s

/** Each statement as its line of snapshot.json. */
const asLine: Statement<StatementLine> = (s) => new StatementLine(s)

const fieldForm = (f: SnapshotField): SnapshotForm => ({
	name: f.name,
	column: f.column,
	type: f.type,
	serial: f.serial
})

const relationForm = (r: SnapshotRelation): SnapshotForm => {
	const of = { kind: r.kind, ident: r.ident, mutable: r.mutable, level: r.level }
	switch (r.kind) {
		case "derived":
			return of
		case "relation":
			return { ...of, fields: r.fields.map(fieldForm), primaryKey: r.primaryKey }
		case "closed":
			return {
				...of,
				fields: r.fields.map(fieldForm),
				primaryKey: r.primaryKey,
				template: r.template
			}
	}
}

const lawForm = (l: SnapshotLaw): SnapshotForm => {
	switch (l.kind) {
		case "native":
			return { kind: l.kind, shape: l.shape }
		case "residual":
			return {
				kind: l.kind,
				shape: l.shape,
				residual: {
					family: l.residual.family,
					digest: l.residual.digest,
					withoutUpdates: l.residual.withoutUpdates,
					participants: l.residual.participants
				}
			}
	}
}

const valuesForm = <V>(
	record: Readonly<Record<string, V>>,
	form: (v: V) => SnapshotForm
): SnapshotForm =>
	Object.fromEntries(Object.entries(record).map(([key, value]) => [key, form(value)] as const))

const theoryForm = (t: SnapshotTheory): SnapshotForm => ({
	schema: t.schema,
	relations: valuesForm(t.relations, relationForm),
	laws: valuesForm(t.laws, lawForm)
})

const reasonForm = (r: PhysicalReason): SnapshotForm => {
	switch (r.kind) {
		case "law":
			return { kind: r.kind, law: r.law }
		case "access":
			return { kind: r.kind }
		case "enforcement":
			return { kind: r.kind, of: r.of }
		case "proof":
			return { kind: r.kind, premises: r.premises }
	}
}

const objectForm = <S>(o: PhysicalObject<SqlStatement>, statement: Statement<S>): RecordOf<S> => ({
	kind: o.kind,
	ident: o.ident,
	ddl: o.ddl.map(statement),
	reasons: o.reasons.map(reasonForm),
	state: o.state,
	phase: o.phase
})

const manifestForm = <S>(
	m: InstallationManifest<SqlStatement>,
	statement: Statement<S>
): RecordOf<S> => ({
	objects: m.objects.map((o) => objectForm(o, statement)),
	edges: m.edges.map((e) => ({ from: e.from, to: e.to })),
	roleDefaults: m.roleDefaults.map(statement),
	publicRevokes: m.publicRevokes.map(statement),
	comments: m.comments.map(statement)
})

const requestForm = (r: StoredIndexRequest): SnapshotForm => ({
	relation: r.relation,
	keys: r.keys.map((k): SnapshotForm =>
		k.opclass === undefined
			? { expr: k.expr, dir: k.dir }
			: { expr: k.expr, dir: k.dir, opclass: k.opclass }
	),
	method: r.method,
	role: r.role,
	use: r.use
})

/** The JSON form of a program's access: its paths and statistics, each in its canonical order. */
const accessForm = (a: ProgramAccess): SnapshotForm => ({
	paths: a.paths.map((p): SnapshotForm => ({
		relation: p.relation,
		derived: p.derived,
		method: p.method,
		keys: p.keys.map((k): SnapshotForm => ({ field: k.field, dir: k.dir })),
		use: p.use
	})),
	statistics: a.statistics.map((st): SnapshotForm => ({
		relation: st.relation,
		columns: st.columns,
		use: st.use
	}))
})

/** The JSON form of a snapshot's content: every field of the snapshot but its fingerprint. */
const contentForm = <S>(c: SnapshotContent, statement: Statement<S>): RecordOf<S> => ({
	schemaName: c.schemaName,
	schema: c.schema,
	theory: theoryForm(c.theory),
	manifest: manifestForm(c.manifest, statement),
	constraintToLaw: c.constraintToLaw,
	workload: valuesForm(c.workload, (programs) => valuesForm(programs, accessForm)),
	accessPaths: c.accessPaths.map(requestForm)
})

/** The JSON form of a snapshot: its content's, with its fingerprint. */
const snapshotForm = <S>(s: DeploySnapshot, statement: Statement<S>): RecordOf<S> => ({
	...contentForm(s, statement),
	fingerprint: s.fingerprint
})

/** The finished snapshot: the target state, fingerprinted. */
export const finishSnapshot = (
	state: SnapshotContent
): Result.Result<DeploySnapshot, CompileError> =>
	Result.map(snapshotFingerprint(contentForm(state, asStatement)), (fingerprint) => ({
		...state,
		fingerprint
	}))

/**
 * A JSON form value written with tabs, `head` before its first line and `tail` after its last: object keys in code
 * point order (RFC 8785's order, as the canonical text), one member or item per line, a member's key in its head and
 * its separating comma in its tail.
 */
const jsonValue = (out: Lines, head: string, value: Json, tail: string): void => {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return out.line(`${head}${JSON.stringify(value)}${tail}`)
	}
	if (isList(value)) {
		if (value.length === 0) {
			return out.line(`${head}[]${tail}`)
		}
		out.line(`${head}[`)
		const items = out.nested()
		for (const [i, item] of value.entries()) {
			jsonValue(items, "", item, i === value.length - 1 ? "" : ",")
		}
		return out.line(`]${tail}`)
	}
	const entries = Object.entries(value).toSorted(([a], [b]) => compareStrings(a, b))
	if (entries.length === 0) {
		return out.line(`${head}{}${tail}`)
	}
	out.line(`${head}{`)
	const members = out.nested()
	for (const [i, [key, member]] of entries.entries()) {
		jsonValue(members, `${JSON.stringify(key)}: `, member, i === entries.length - 1 ? "" : ",")
	}
	return out.line(`}${tail}`)
}

const jsonTextLoc = SourceLoc("JSON text", [])

/** The reviewable text of a canonical value: its JSON form, keys in code point order, indented by tabs, ending in a
 * newline. Equal values are equal bytes. A text past V8's longest string is refused as ResourceBound (stringLength),
 * and a kernel Refusal its writer throws is its failure. */
export const writeJsonText = (value: unknown): Result.Result<string, CompileError> =>
	Result.flatMap(toJson(value, everyProperty), (json) =>
		Result.flatMap(
			catchRefusal(() =>
				textOf(maxStringLength, "\t", jsonTextLoc, (out) => {
					jsonValue(out, "", json, "")
					out.line("")
				})
			),
			(text) => text
		)
	)

/** A kernel result's value, or its failure thrown as a Refusal for the writer's door to return. */
const valueOf = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/**
 * snapshot.json's text of a form value, `head` before its first line and `tail` after its last: an installed statement
 * on one line, its compact canonical JSON; a scalar as its canonical JSON; a list or a record one item or member per
 * line, a record's keys in code point order.
 */
const formValue = (out: Lines, head: string, value: FormOf<StatementLine>, tail: string): void => {
	if (value instanceof StatementLine) {
		const compact = valueOf(writeCanonicalJson(valueOf(toJson(value.statement, everyProperty))))
		return out.line(`${head}${compact}${tail}`)
	}
	if (typeof value !== "object") {
		return jsonValue(out, head, valueOf(toJson(value, everyProperty)), tail)
	}
	if (isList(value)) {
		if (value.length === 0) {
			return out.line(`${head}[]${tail}`)
		}
		out.line(`${head}[`)
		const items = out.nested()
		for (const [i, item] of value.entries()) {
			formValue(items, "", item, i === value.length - 1 ? "" : ",")
		}
		return out.line(`]${tail}`)
	}
	const entries = Object.entries(value).toSorted(([a], [b]) => compareStrings(a, b))
	if (entries.length === 0) {
		return out.line(`${head}{}${tail}`)
	}
	out.line(`${head}{`)
	const members = out.nested()
	for (const [i, [key, member]] of entries.entries()) {
		formValue(members, `${JSON.stringify(key)}: `, member, i === entries.length - 1 ? "" : ",")
	}
	return out.line(`}${tail}`)
}

/** The text of snapshot.json. The file `migrations/<schema>/snapshot.json` is the snapshot's canonical JSON form,
 * written with object keys in code point order and indented by tabs for review, each installed statement compact on a
 * line of its own, so a changed statement is one changed line and the same snapshot is the same bytes on every machine.
 * The layout is the writer's: the fingerprint digests the form's canonical text, which no layout changes. */
export const writeSnapshot = (snapshot: DeploySnapshot): Result.Result<string, CompileError> =>
	catchRefusal(() =>
		valueOf(
			textOf(maxStringLength, "\t", jsonTextLoc, (out) => {
				formValue(out, "", snapshotForm(snapshot, asLine), "")
				out.line("")
			})
		)
	)
