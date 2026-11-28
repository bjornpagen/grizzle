import type { AnyNode, Context, CreateRule, NodeOf, Plugin } from "@bjornpagen/devtools/oxlint/rule"
import { Option, Record, String as Str } from "effect"

/**
 * The oxlint plugin star-imports.ts runs after the dev tools' grizzle-star-imports fix has read every name a module takes
 * from a grizzle entry off the entry's namespace: one rule, `rename`, that rewrites each name grizzle's PostgreSQL naming
 * gave another to the name it has, wherever a module reads it off a namespace of an entry (`g.x`, `gRuntime.x`, `g.X` in a
 * type). PostgreSQL's plain types are read off the root by their pg_type names (`g.pg.integer` is `g.int4`,
 * `g.pg["double precision"]` `g.float8`); bytea, range and bit are the bytes, span and bits descriptors and Range, Bit and
 * Numeric their companions; domain is contract, PostgreSQL's DOMAIN, with Domain, AnyDomain and domainParser; Text's float8 and numeric parses are parseFloat8 and parseNumeric; and a type's SQL tag, a
 * string literal among a namespace type's arguments (`g.Term<D, unknown, O, "bigint">`), is its typname. A read of the
 * old pg namespace that names no member of it (`g.pg` alone) is reported and left as it is, for its author to rewrite.
 */

/** The names of the entries' exports grizzle's naming gave another, each by the one it has. */
const NAMES: Readonly<Record<string, string>> = {
	bytes: "bytea",
	BytesField: "ByteaField",
	bytesMaxLength: "byteaMaxLength",
	span: "range",
	Span: "Range",
	SpanField: "RangeField",
	SpanEndpointLike: "RangeEndpointLike",
	SpanWidthOf: "RangeWidthOf",
	bits: "bit",
	Bits: "Bit",
	BitsField: "BitField",
	Decimal: "Numeric",
	decimalText: "numericText",
	decimalTextMaxBytes: "numericTextMaxBytes",
	doubleText: "float8Text",
	contract: "domain",
	Contract: "Domain",
	AnyContract: "AnyDomain",
	contractParser: "domainParser",
	ContractParser: "DomainParser",
	ContractRefused: "DomainParseRefused"
}

/** The members of the old pg namespace, each by the root export that is it now. */
const PG: Readonly<Record<string, string>> = {
	smallint: "int2",
	integer: "int4",
	bigint: "int8",
	numeric: "numeric",
	real: "float4",
	"double precision": "float8",
	money: "money",
	boolean: "bool",
	inet: "inet",
	cidr: "cidr",
	smallserial: "smallserial",
	serial: "serial",
	bigserial: "bigserial",
	uuidv7: "uuidv7",
	vector: "vector",
	tsvector: "tsvector"
}

/** The members of a namespace export grizzle's naming gave another, by the export, then by the member. */
const MEMBERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	Text: { parseDouble: "parseFloat8", parseDecimal: "parseNumeric" }
}

/** The SQL tags, each by the typname it is now; a tag string literal among a namespace type's arguments is one. */
const TAGS: Readonly<Record<string, string>> = {
	smallint: "int2",
	integer: "int4",
	bigint: "int8",
	real: "float4",
	"double precision": "float8",
	boolean: "bool",
	bits: "bit"
}

const MESSAGE =
	"grizzle names PostgreSQL's types by their pg_type names and its own by PostgreSQL's words; this name has another now (oxlint --fix rewrites it)"

const LEFT_ALONE =
	"grizzle has no pg namespace: each of its members is read off the root by its pg_type name (g.int4, g.float8, g.numeric(p, s)); rewrite this read by hand"

/** The package whose root and entries the rule reads, as the dev tools' grizzle-star-imports rule reads them. */
const PACKAGE = "@bjornpagen/grizzle"

const isEntry = (source: string): boolean =>
	source === PACKAGE || Str.startsWith(`${PACKAGE}/`)(source)

/** A member's name where a member expression reads one by a name: `x.name`, or `x["name"]` by a string literal. */
const memberName = (node: AnyNode): Option.Option<string> => {
	if (node.type !== "MemberExpression") {
		return Option.none()
	}
	const { property } = node
	if (!node.computed && property.type === "Identifier") {
		return Option.some(property.name)
	}
	return property.type === "Literal" && typeof property.value === "string"
		? Option.some(property.value)
		: Option.none()
}

/** The text that reads `name` off the namespace `alias`: `g.name`. */
const readOf = (alias: string, name: string): string => `${alias}.${name}`

/** What one read of a namespace calls for: a node's text replaced, or a read of the old pg namespace left to its author. */
type Edit =
	| Readonly<{ kind: "rename"; node: AnyNode; text: string }>
	| Readonly<{ kind: "unread"; node: AnyNode }>

/** The string literal types a type argument holds: itself, or each member of a union of them. */
const literalsOf = (type: AnyNode): ReadonlyArray<NodeOf<"TSLiteralType">> => {
	if (type.type === "TSUnionType") {
		const members: Array<NodeOf<"TSLiteralType">> = []
		for (const member of type.types) {
			for (const literal of literalsOf(member)) {
				members.push(literal)
			}
		}
		return members
	}
	return type.type === "TSLiteralType" ? [type] : []
}

/** The fixes of a namespace type's tag arguments: each string literal type among them, or among a union of them, a tag. */
const tagEdits = (context: Context, reference: AnyNode): ReadonlyArray<Edit> => {
	if (reference.type !== "TSTypeReference" || reference.typeArguments === null) {
		return []
	}
	const edits: Array<Edit> = []
	for (const argument of reference.typeArguments.params) {
		for (const { literal } of literalsOf(argument)) {
			if (literal.type === "Literal" && typeof literal.value === "string") {
				const quote = Str.slice(0, 1)(context.sourceCode.getText(literal))
				for (const now of Option.toArray(Record.get(TAGS, literal.value))) {
					edits.push({ kind: "rename", node: literal, text: `${quote}${now}${quote}` })
				}
			}
		}
	}
	return edits
}

/** A node's parent, none at the program. */
const parentOf = (node: AnyNode): Option.Option<AnyNode> => Option.fromNullOr(node.parent)

/** The edits of a value read off the namespace, `g.name` at `read`: the pg namespace's member, a renamed export, or a
 * renamed member of a namespace export. */
const valueEdits = (alias: string, read: AnyNode, name: string): ReadonlyArray<Edit> => {
	const outer = parentOf(read)
	const outerMember = Option.flatMap(outer, memberName)
	if (name === "pg") {
		return Option.match(
			Option.flatMap(outer, (node) =>
				Option.map(
					Option.flatMap(memberName(node), (member) => Record.get(PG, member)),
					(now) => ({ node, now })
				)
			),
			{
				onNone: (): ReadonlyArray<Edit> => [{ kind: "unread", node: read }],
				onSome: ({ node, now }): ReadonlyArray<Edit> => [
					{ kind: "rename", node, text: readOf(alias, now) }
				]
			}
		)
	}
	const renamed = Option.map(Record.get(NAMES, name), (now): Edit => ({
		kind: "rename",
		node: read,
		text: readOf(alias, now)
	}))
	const member = Option.flatMap(Record.get(MEMBERS, name), (table) =>
		Option.flatMap(Option.all([outer, outerMember]), ([node, old]) =>
			Option.map(Record.get(table, old), (now): Edit => ({
				kind: "rename",
				node,
				text: `${readOf(alias, name)}.${now}`
			}))
		)
	)
	return [...Option.toArray(renamed), ...Option.toArray(member)]
}

/** The edits of a type read off the namespace, `g.Name` at `read`: the pg namespace's member in a type query, a renamed
 * export, and the tag arguments of the type it names. */
const typeEdits = (
	context: Context,
	alias: string,
	read: NodeOf<"TSQualifiedName">
): ReadonlyArray<Edit> => {
	const outer = parentOf(read)
	if (read.right.name === "pg") {
		return Option.match(
			Option.flatMap(outer, (node) =>
				node.type === "TSQualifiedName"
					? Option.map(Record.get(PG, node.right.name), (now) => ({ node, now }))
					: Option.none()
			),
			{
				onNone: (): ReadonlyArray<Edit> => [{ kind: "unread", node: read }],
				onSome: ({ node, now }): ReadonlyArray<Edit> => [
					{ kind: "rename", node, text: readOf(alias, now) }
				]
			}
		)
	}
	const renamed = Option.map(Record.get(NAMES, read.right.name), (now): Edit => ({
		kind: "rename",
		node: read,
		text: readOf(alias, now)
	}))
	return [
		...Option.toArray(renamed),
		...Option.match(outer, { onNone: () => [], onSome: (node) => tagEdits(context, node) })
	]
}

/** The edits one read of a namespace calls for, at the identifier that reads it. */
const readEdits = (context: Context, alias: string, id: AnyNode): ReadonlyArray<Edit> =>
	Option.match(parentOf(id), {
		onNone: () => [],
		onSome: (parent) => {
			if (parent.type === "MemberExpression" && parent.object === id) {
				return Option.match(memberName(parent), {
					onNone: () => [],
					onSome: (name) => valueEdits(alias, parent, name)
				})
			}
			return parent.type === "TSQualifiedName" && parent.left === id
				? typeEdits(context, alias, parent)
				: []
		}
	})

const rename: CreateRule = {
	meta: { type: "problem", fixable: "code" },
	create: (context: Context) => ({
		ImportDeclaration: (node) => {
			if (!isEntry(node.source.value)) {
				return
			}
			for (const specifier of node.specifiers) {
				if (specifier.type !== "ImportNamespaceSpecifier") {
					continue
				}
				const alias = specifier.local.name
				for (const variable of context.sourceCode.getDeclaredVariables(specifier)) {
					for (const reference of variable.references) {
						for (const edit of readEdits(context, alias, reference.identifier)) {
							switch (edit.kind) {
								case "unread":
									context.report({ node: edit.node, message: LEFT_ALONE })
									break
								case "rename":
									context.report({
										node: edit.node,
										message: MESSAGE,
										fix: (fixer) => fixer.replaceText(edit.node, edit.text)
									})
									break
							}
						}
					}
				}
			}
		}
	})
}

const plugin: Plugin = { meta: { name: "grizzle-names" }, rules: { rename } }

export default plugin
