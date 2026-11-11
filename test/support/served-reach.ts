import { Array as Arr, Order, Record as Rec, String as Str } from "effect"
import type { DecoderForm } from "#compiler/core/decoder.ts"
import { type DeclaredName, identifierOf } from "#compiler/core/identity.ts"
import type {
	ColumnIdent,
	EntryName,
	RelationIdent,
	StoredRelationName
} from "#compiler/core/ids.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import type {
	ServedMember,
	ServedRoleForm,
	ServedVariants,
	ServedChange
} from "#compiler/served/forms.ts"

/**
 * What a login's code can reach, computed from its compiled program and its installation and never through the
 * compiler's own cut (program/schema.ts raisableOf, program/served.ts servedRosters): the oracle of a served file's reach
 * (test/unit/served/reach.test.ts) and of its classifier's cut (test/unit/served/refusals.test.ts).
 *
 * A role meets a roster where a value of it crosses the wire: a column its decoders read as a closed id or a set, a
 * parameter or a context claim its codecs encode, a page's cursor value, and every column of a relation its writes
 * write, whose stored codes a refusal's key decodes and whose domains PostgreSQL may report.
 *
 * A role that writes can raise, of its installation, exactly: each table constraint and rule trigger on a written
 * relation's table; each foreign key into a written relation, which a delete or a key's update there meets; each
 * domain's CHECK a cast value meets, whole, and every other domain's on the columns it types in the written tables,
 * those columns alone, since a statement coerces to a domain only the columns it writes and the values it casts; each
 * law of the theory reading a written relation, which a write statement's refusal raises; each generated column of a
 * written table, whose NOT NULL its generation expression breaks; and the domains of the rosters its written columns
 * and its cast values hold; and a fact outside each query entry it writes through into a written relation, which the
 * entry's precheck refuses. A cast value is every claim of a context the role reads, which each of its write
 * statements casts to its type, and every scalar parameter its writes declare; it meets each contract domain of its
 * type's contract chain, outermost first, and its pattern's text domain. A role that writes nothing raises nothing.
 */

/** The roster a type's values are codes of: a closed id's or a set's, none for any other carrier. */
export const typeRosters = (type: ScalarType): ReadonlyArray<DeclaredName> => {
	switch (type.carrier) {
		case "code":
		case "bits":
			return [type.roster.closed]
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return []
	}
}

/** The rosters a heading's columns hold. */
const headingRosters = (heading: Heading): ReadonlyArray<string> =>
	Arr.flatMap(heading, (column) => typeRosters(column.type))

/** The rosters a parameter's codec encodes: a scalar's type's, a relation parameter's columns'. */
const paramRosters = (param: ParamDecl): ReadonlyArray<string> =>
	param.kind === "relation" ? headingRosters(param.heading) : typeRosters(param.type)

/** The rosters a decoder's columns read, a closed id's and a set's, through its attachments, arms and unions. */
export const decoderRosters = (form: DecoderForm): ReadonlyArray<string> => {
	switch (form.kind) {
		case "record":
			return Arr.flatMap(form.fields, ([, field]) => {
				switch (field.kind) {
					case "column":
						return field.column.kind === "code" || field.column.kind === "bits"
							? [field.column.roster]
							: []
					case "attachment":
					case "some":
					case "none":
						return decoderRosters(field.child)
				}
			})
		case "merge":
		case "oneOf":
			return [...decoderRosters(form.first), ...decoderRosters(form.second)]
		case "arm":
			return [...decoderRosters(form.parent), ...decoderRosters(form.child)]
		case "refused":
			return []
	}
}

/** Each change of a ChangeSet's variants, every set of its fill contexts'. */
const changesOf = (variants: ServedVariants): ReadonlyArray<ServedChange> =>
	variants.kind === "change"
		? [variants.change]
		: [...changesOf(variants.holding), ...changesOf(variants.lacking)]

/** The relations a role's ChangeSets write, every variant's (runtime/write/flight.ts ServedWrite written). */
export const writtenBy = (role: ServedRoleForm): ReadonlySet<StoredRelationName> =>
	new Set(
		Arr.flatMap(role.members, (member) =>
			member.kind === "change"
				? Arr.flatMap(changesOf(member.variants), (change) =>
						Arr.map(change.program.written, (w) => w.relation)
					)
				: []
		)
	)

/** The rosters one member's decoders and codecs meet: its rows', its parameters', its page cursor's. */
const memberRosters = (member: ServedMember): ReadonlyArray<string> => {
	switch (member.kind) {
		case "read":
		case "key":
			return [
				...decoderRosters(member.read.decoder),
				...Arr.flatMap(member.read.params, paramRosters)
			]
		case "paged":
			return [
				...decoderRosters(member.read.decoder),
				...Arr.flatMap(member.read.params, paramRosters),
				...Arr.flatMap(member.page.comparators, (c) => typeRosters(c.type))
			]
		case "change":
			return Arr.flatMap(changesOf(member.variants), (change) => [
				...decoderRosters(change.decoder),
				...Arr.flatMap(change.program.params, paramRosters)
			])
		case "refresh":
			return []
	}
}

/** The relations of an installation by their declared names, each with its fields. */
const relationsOf = (artifacts: Pick<SchemaArtifacts, "derived">, names: ReadonlySet<string>) =>
	Arr.filter([...artifacts.derived.schema.relations.values()], (r) => names.has(r.name))

/**
 * The rosters a served role meets (see the header): its members' decoders and codecs, its contexts' claims, and every
 * column of the relations its writes write, read off its installation.
 */
export const roleRosters = (
	role: ServedRoleForm,
	artifacts: Pick<SchemaArtifacts, "derived">
): ReadonlySet<string> =>
	new Set([
		...Arr.flatMap(role.members, memberRosters),
		...Arr.flatMap(role.contexts, (c) => headingRosters(c.fields)),
		...Arr.flatMap(relationsOf(artifacts, writtenBy(role)), (r) =>
			Arr.flatMap(r.fields, (f) => typeRosters(f.type))
		)
	])

/**
 * The rosters a served file's JSON value names a Roster of (served/json.ts `~roster:`), each a type a form holds:
 * every one is rebuilt at load from the file's codes for it.
 */
export const heldRosters = (json: unknown): ReadonlySet<string> => {
	const out = new Set<string>()
	const pending: Array<unknown> = [json]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (typeof next === "string") {
			const [tag, roster] = Str.split(":")(next)
			if (tag === "~roster" && roster !== undefined) {
				out.add(roster)
			}
		} else if (isList(next)) {
			pending.push(...next)
		} else if (isRecord(next)) {
			pending.push(...Rec.values(next))
		}
	}
	return out
}

/** What a role's writes can raise of its installation (see the header): the cut a served role's classifier holds. */
export interface Raised {
	readonly relations: ReadonlySet<StoredRelationName>
	readonly constraints: ReadonlyArray<ConstraintLaw>
	readonly theoryLaws: ReadonlyArray<DescribedLaw>
	readonly rosters: ReadonlySet<DeclaredName>
	readonly generated: ReadonlyArray<{ readonly table: RelationIdent; readonly column: ColumnIdent }>
	/** Each query entry the role writes through into a written relation, by its target. */
	readonly entries: ReadonlyMap<StoredRelationName, EntryName>
}

/** Nothing raised: a role whose members write nothing. */
export const raisedNothing: Raised = {
	relations: new Set(),
	constraints: [],
	theoryLaws: [],
	rosters: new Set(),
	generated: [],
	entries: new Map()
}

/** The types of the values a role's writes cast (see the header): its contexts' claims and its writes' scalar parameters. */
export const castBy = (role: ServedRoleForm): ReadonlyArray<ScalarType> => [
	...Arr.flatMap(role.contexts, (c) => Arr.map(c.fields, (f) => f.type)),
	...Arr.flatMap(role.members, (member) =>
		member.kind === "change"
			? Arr.flatMap(changesOf(member.variants), (change) =>
					Arr.flatMap(change.program.params, (p) => (p.kind === "scalar" ? [p.type] : []))
				)
			: []
	)
]

/** The contracts of a type's chain, outermost first: its own, then its base's, down to a type of no contract. */
const contractsOf = (type: ScalarType): ReadonlyArray<DeclaredName> => {
	const contract = contractOf(type)
	return contract === undefined ? [] : [contract.name, ...contractsOf(contract.base)]
}

/** The domains a value cast to `type` meets (see the header): its contract chain's, and its pattern's. */
const castDomains = (names: SchemaArtifacts["names"], type: ScalarType): ReadonlyArray<string> => {
	const text = textOf(type)
	const pattern =
		text === undefined || text.regex === "wildcard" ? undefined : names.textDomain(text.regex)
	return [
		...Arr.map(contractsOf(type), (contract) => names.contractDomain(contract).name),
		...(pattern === undefined ? [] : [pattern.name])
	]
}

/** What writes of the relations `written`, casting values of the types `cast`, can raise of `artifacts` (Raised). */
export const raisedBy = (
	artifacts: Pick<
		SchemaArtifacts,
		"derived" | "names" | "laws" | "constraintLaws" | "theoryLaws" | "world"
	>,
	written: ReadonlySet<string>,
	cast: ReadonlyArray<ScalarType>
): Raised => {
	if (written.size === 0) {
		return raisedNothing
	}
	const met = new Set(Arr.flatMap(cast, (type) => castDomains(artifacts.names, type)))
	const relations = relationsOf(artifacts, written)
	const tables = new Set<string>(Arr.map(relations, (r) => artifacts.names.relation(r.name).name))
	const into = Arr.flatMap(artifacts.laws.natives, (n) =>
		n.namespace === "constraint" &&
		(n.object.kind === "ForeignKey" || n.object.kind === "PeriodForeignKey") &&
		written.has(n.object.target.name)
			? [{ owner: n.owner, name: identifierOf(n.named) }]
			: []
	)
	const meets = (owner: string, name: string): boolean =>
		tables.has(owner) || Arr.some(into, (fk) => fk.owner === owner && fk.name === name)
	const constraints = Arr.flatMap(artifacts.constraintLaws, (c): ReadonlyArray<ConstraintLaw> => {
		switch (c.kind) {
			case "constraint":
			case "trigger":
				return meets(c.owner, c.name) ? [c] : []
			case "domainConstraint": {
				if (met.has(c.owner)) {
					return [c]
				}
				const [first, ...rest] = Arr.filter(c.uses, (u) => tables.has(u.table))
				return first === undefined ? [] : [{ ...c, uses: [first, ...rest] }]
			}
			case "unstoredDomainConstraint":
				return met.has(c.owner) ? [c] : []
		}
	})
	const reading = new Set(
		Arr.flatMap(artifacts.laws.theory.laws, (l) =>
			Arr.some(l.reads, (r) => written.has(r)) ? [l.id] : []
		)
	)
	return {
		relations: new Set(Arr.map(relations, (r) => r.name)),
		constraints,
		theoryLaws: Arr.filter(artifacts.theoryLaws, (l) => reading.has(l.law)),
		rosters: new Set([
			...Arr.flatMap(relations, (r) => Arr.flatMap(r.fields, (f) => typeRosters(f.type))),
			...Arr.flatMap(cast, typeRosters)
		]),
		generated: Arr.flatMap(relations, (r) =>
			Arr.flatMap(r.fields, (f) =>
				f.writing.kind === "generated"
					? [{ table: artifacts.names.relation(r.name).name, column: f.column }]
					: []
			)
		),
		entries: new Map(
			artifacts.world.kind === "role"
				? Arr.flatMap([...artifacts.world.checked.world.writes.values()], (e) =>
						e.kind === "rows" && written.has(e.writable.target.name)
							? [[e.writable.target.name, e.writable.entry] as const]
							: []
					)
				: []
		)
	}
}

/** An installed constraint as text, which two cuts compare by: its kind, owner and name, and its laws or uses. */
export const constraintText = (c: ConstraintLaw): string => {
	switch (c.kind) {
		case "constraint":
		case "trigger":
		case "unstoredDomainConstraint":
			return `${c.kind} ${c.owner} ${c.name}: ${Arr.join(
				Arr.map(c.laws, (l) => l.law),
				" "
			)}`
		case "domainConstraint":
			return `${c.kind} ${c.owner} ${c.name}: ${Arr.join(
				Arr.map(c.uses, (u) => `${u.table}.${u.column}=${u.law.law}`),
				" "
			)}`
	}
}

/** Two sets of texts as what the first lacks of the second and holds beyond it, each in code-unit order. */
export const partedTexts = (
	held: Iterable<string>,
	reach: Iterable<string>
): { readonly missing: ReadonlyArray<string>; readonly extra: ReadonlyArray<string> } => {
	const has = new Set(held)
	const reached = new Set(reach)
	return {
		missing: Arr.sort(
			Arr.filter([...reached], (t) => !has.has(t)),
			Order.String
		),
		extra: Arr.sort(
			Arr.filter([...has], (t) => !reached.has(t)),
			Order.String
		)
	}
}
