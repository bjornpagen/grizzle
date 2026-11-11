import { Array as Arr, Schema } from "effect"
import { type AnyNode, configured, isFileAt } from "#oxlint/rule.ts"
import { isIdentifierIn, isStringLiteral } from "#oxlint/syntax.ts"

/**
 * A module, or some of its exports, that only its doors import: a door is a file, by its path from the repository root,
 * and every other file reaches the module through one.
 */
const Door = Schema.Struct({
	module: Schema.String,
	guards: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("module") }),
		Schema.Struct({ kind: Schema.Literal("exports"), names: Schema.Array(Schema.String) })
	]),
	doors: Schema.Array(Schema.String),
	message: Schema.String
})

type Door = typeof Door.Type

const Options = Schema.Struct({ doors: Schema.Array(Door) })

/** What a specifier reaches of its module: every export (a namespace import, `export *`), or the one its name spells. */
type Reach = Readonly<{
	node: AnyNode
	reaches: Readonly<{ kind: "every" }> | Readonly<{ kind: "named"; name: AnyNode }>
}>

/** One import of a guarded module past its doors: the node to report, and the door's message. */
type Breach = Readonly<{ node: AnyNode; message: string }>

/** A specifier's name, an identifier or a string literal, that spells one of `names`. */
const spellsOneOf = (name: AnyNode, names: ReadonlyArray<string>): boolean =>
	isIdentifierIn(name, names) || isStringLiteral(name, (value) => Arr.contains(names, value))

/**
 * The breaches one door finds in an import or a re-export of its module: the whole declaration when the door guards the
 * module, else each specifier that reaches a guarded export.
 */
const breachesAt = (
	door: Door,
	declaration: AnyNode,
	reaches: ReadonlyArray<Reach>
): ReadonlyArray<Breach> => {
	if (door.guards.kind === "module") {
		return [{ node: declaration, message: door.message }]
	}
	const { names } = door.guards
	const reached = Arr.filter(
		reaches,
		(reach) => reach.reaches.kind === "every" || spellsOneOf(reach.reaches.name, names)
	)
	return Arr.map(reached, (reach) => ({ node: reach.node, message: door.message }))
}

/** What an import specifier reaches: a named import its export, a namespace import every export, a default import none. */
const reachesOfImport = (specifier: AnyNode): ReadonlyArray<Reach> => {
	if (specifier.type === "ImportSpecifier") {
		return [{ node: specifier, reaches: { kind: "named", name: specifier.imported } }]
	}
	if (specifier.type === "ImportNamespaceSpecifier") {
		return [{ node: specifier, reaches: { kind: "every" } }]
	}
	return []
}

/**
 * An import or a re-export of a guarded module, or of a guarded export of it, outside the module's doors: an import
 * declaration, `export { x } from` and `export * from`, type-only ones included.
 */
export const importDoors = configured(Options, (context, options) => {
	const breachesOf = (
		module: string,
		declaration: AnyNode,
		reaches: ReadonlyArray<Reach>
	): ReadonlyArray<Breach> => {
		const guarding: ReadonlyArray<Door> = Arr.filter(
			options.doors,
			(door: Door): boolean =>
				door.module === module && !Arr.some(door.doors, (file) => isFileAt(context.filename, file))
		)
		return Arr.flatMap(guarding, (door) => breachesAt(door, declaration, reaches))
	}
	const report = (breaches: ReadonlyArray<Breach>): void => {
		for (const breach of breaches) {
			context.report({ node: breach.node, message: breach.message })
		}
	}
	return {
		ImportDeclaration: (node) => {
			report(breachesOf(node.source.value, node, Arr.flatMap(node.specifiers, reachesOfImport)))
		},
		ExportNamedDeclaration: (node) => {
			if (node.source !== null) {
				report(
					breachesOf(
						node.source.value,
						node,
						Arr.map(node.specifiers, (specifier): Reach => ({
							node: specifier,
							reaches: { kind: "named", name: specifier.local }
						}))
					)
				)
			}
		},
		ExportAllDeclaration: (node) => {
			report(breachesOf(node.source.value, node, [{ node, reaches: { kind: "every" } }]))
		}
	}
})
