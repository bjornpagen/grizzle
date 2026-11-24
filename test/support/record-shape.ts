/**
 * The shape of each file grizzle reads back, as core/format.ts recordShapes states it: the SHA-256 digest of the
 * structure of the type the file holds (a committed snapshot's, deploy/snapshot/build.ts SealedRecord, the record its
 * seal holds; a served file's, served/forms.ts ServedFile), resolved by the TypeScript compiler's checker
 * (typescript/sync) over the engine's project.
 *
 * The type is read as a graph: each type the file reaches is a node, labelled by its kind (a literal by its text, a
 * primitive by its name, a union, an intersection, a tuple by its readonliness and element flags, a collection by its
 * name, an object by its call signatures' count), its edges each member's type by the member's name, an optional member
 * marked `?`, each index signature's value by its key, each tuple element and type argument by its position, and each
 * union's and intersection's members unordered. The graph is minimized by partition refinement, so two types of one
 * structure are one class whatever their names, their comments and their declarations' order, and a recursive type is
 * finite; the digest is that of the root's class and every class's label and edges, sorted. So any change of a member,
 * its type or its optionality anywhere the file reaches changes it, and nothing else does.
 */

import { Array as Arr, Option, Order, String as Str } from "effect"
import { API, SymbolFlags, type Type, TypeFlags } from "typescript/sync"
import type { FormattedFile } from "#compiler/core/format.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"

/** A node of a file's type graph: its label, whether its edges' order is its own, and its edges. */
interface ShapeNode {
	readonly label: string
	readonly ordered: boolean
	readonly edges: ReadonlyArray<readonly [label: string, to: number]>
}

/** Each formatted file's type: the module that declares it, within the engine's sources, and its name. */
const rootOf: {
	readonly [F in FormattedFile]: { readonly module: string; readonly name: string }
} = {
	snapshot: { module: "deploy/snapshot/build.ts", name: "SealedRecord" },
	served: { module: "served/forms.ts", name: "ServedFile" }
}

/** The flags of a type printed by its intrinsic name. */
const primitive =
	TypeFlags.Any |
	TypeFlags.Unknown |
	TypeFlags.String |
	TypeFlags.Number |
	TypeFlags.Boolean |
	TypeFlags.BigInt |
	TypeFlags.ESSymbol |
	TypeFlags.Void |
	TypeFlags.Undefined |
	TypeFlags.Null |
	TypeFlags.Never |
	TypeFlags.NonPrimitive

/** The flags of a type printed by its text. */
const literal =
	TypeFlags.StringLiteral |
	TypeFlags.NumberLiteral |
	TypeFlags.BigIntLiteral |
	TypeFlags.BooleanLiteral |
	TypeFlags.UniqueESSymbol |
	TypeFlags.EnumLiteral

/** The collections a type argument types, by their names. */
const collections: ReadonlySet<string> = new Set([
	"Array",
	"ReadonlyArray",
	"Map",
	"ReadonlyMap",
	"Set",
	"ReadonlySet"
])

/** Whether `type` carries any of `flags`. */
const carries = (type: Type, flags: number): boolean => (type.flags & flags) !== 0

/**
 * A symbol's name with the checker's per-run number left out: a unique symbol's key's (`__@name@<n>`) and a private
 * field's (`__#<n>@#name`).
 */
const stableName = (name: string): string => {
	if (Str.startsWith("__#")(name)) {
		return Option.match(Str.indexOf("@")(name), {
			onNone: () => name,
			onSome: (at) => `__#${Str.slice(at)(name)}`
		})
	}
	return Str.startsWith("__@")(name)
		? Option.match(Str.lastIndexOf("@")(name), {
				onNone: () => name,
				onSome: (at) => (at > 2 ? Str.slice(0, at)(name) : name)
			})
		: name
}

/** The SHA-256 digest of a text, as lowercase hex. */
const digestOf = (text: string): string => sha256Hex(new TextEncoder().encode(text))

/** Texts in code-unit order. */
const sortedTexts = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(texts, Order.String)

/**
 * The shape of `file` as the engine at `engine` (its package directory) declares it: the digest of its type's graph,
 * minimized (see the module's doc).
 */
export const recordShapeOf = (engine: string, file: FormattedFile): string => {
	const { module, name } = rootOf[file]
	const api = new API({ cwd: engine })
	const project = api
		.createSnapshot({ openProjects: [`${engine}/tsconfig.json`] })
		.getConfiguredProject(`${engine}/tsconfig.json`)
	if (project === undefined) {
		throw new Error(`no project at ${engine}/tsconfig.json`)
	}
	const checker = project.checker
	const source = project.program.getSourceFile(`${engine}/src/${module}`)
	const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source)
	const declared =
		moduleSymbol === undefined
			? undefined
			: Option.getOrUndefined(
					Arr.findFirst(checker.getExportsOfModule(moduleSymbol), (s) => s.name === name)
				)
	if (declared === undefined) {
		throw new Error(`${module} exports no ${name}`)
	}
	const root = checker.getDeclaredTypeOfSymbol(declared)
	const nodes = new Map<number, ShapeNode>()
	const pending: Array<Type> = [root]
	/** The node of `type`, pending until it is read. */
	const to = (type: Type | undefined): number => {
		if (type === undefined) {
			throw new Error(`a member ${name} reaches has no type the checker gives`)
		}
		if (!nodes.has(type.id)) {
			pending.push(type)
		}
		return type.id
	}
	/** The elements of a tuple or the type arguments of a collection, by position. */
	const positional = (args: ReadonlyArray<Type>) =>
		Arr.map(args, (a, i) => [String(i), to(a)] as const)
	/** The node `type` is (see the module's doc). */
	const nodeOf = (type: Type): ShapeNode => {
		if (carries(type, literal)) {
			return {
				label: `literal ${stableName(checker.typeToString(type))}`,
				ordered: true,
				edges: []
			}
		}
		if (carries(type, primitive)) {
			return { label: `primitive ${checker.typeToString(type)}`, ordered: true, edges: [] }
		}
		if (type.isUnionType() || type.isIntersectionType()) {
			const mark = type.isUnionType() ? "|" : "&"
			return {
				label: type.isUnionType() ? "union" : "intersection",
				ordered: false,
				edges: Arr.map(type.getTypes(), (member) => [mark, to(member)] as const)
			}
		}
		if (type.isTypeParameter()) {
			return { label: "type parameter", ordered: true, edges: [] }
		}
		if (type.isTypeReference()) {
			const target = type.getTarget()
			const collection = target.getSymbol()?.name ?? ""
			if (target.isTupleTypeTarget()) {
				return {
					label: `tuple ${target.readonly ? "readonly" : "mutable"} ${Arr.join(Arr.map(target.elementFlags, String), ",")}`,
					ordered: true,
					edges: positional(checker.getTypeArguments(type))
				}
			}
			if (collections.has(collection)) {
				return {
					label: `collection ${collection}`,
					ordered: true,
					edges: positional(checker.getTypeArguments(type))
				}
			}
		}
		if (type.isObjectType()) {
			const members = Arr.map(
				checker.getPropertiesOfType(type),
				(p) =>
					[
						`${stableName(p.name)}${(p.flags & SymbolFlags.Optional) === 0 ? "" : "?"}`,
						to(checker.getTypeOfSymbol(p))
					] as const
			)
			const indexes = Arr.map(
				checker.getIndexInfosOfType(type),
				(i) => [`[${checker.typeToString(i.keyType)}]`, to(i.valueType)] as const
			)
			return {
				label: `object, ${checker.getSignaturesOfType(type, 0).length} call signatures`,
				ordered: true,
				edges: Arr.sort(
					[...members, ...indexes],
					Order.mapInput(Order.String, (edge: readonly [string, number]) => edge[0])
				)
			}
		}
		return { label: `other ${stableName(checker.typeToString(type))}`, ordered: true, edges: [] }
	}
	for (let type = pending.pop(); type !== undefined; type = pending.pop()) {
		if (!nodes.has(type.id)) {
			nodes.set(type.id, nodeOf(type))
		}
	}
	api.close()
	/** A node's signature under `classOf`: its label and its edges' classes, unordered where its edges are. */
	const signature = (node: ShapeNode, classOf: ReadonlyMap<number, string>): string => {
		const edges = Arr.map(node.edges, ([label, at]) => `${label}=${classOf.get(at) ?? ""}`)
		return `${node.label}(${Arr.join(node.ordered ? edges : sortedTexts(edges), ",")})`
	}
	let classOf: ReadonlyMap<number, string> = new Map(
		Arr.map([...nodes], ([id, node]) => [id, digestOf(node.label)] as const)
	)
	let classes = new Set(classOf.values()).size
	for (const _ of nodes) {
		const refined: ReadonlyMap<number, string> = new Map(
			Arr.map([...nodes], ([id, node]) => [id, digestOf(signature(node, classOf))] as const)
		)
		const count = new Set(refined.values()).size
		classOf = refined
		if (count === classes) {
			break
		}
		classes = count
	}
	const quotient = new Set(
		Arr.map([...nodes], ([id, node]) => `${classOf.get(id) ?? ""}:${signature(node, classOf)}`)
	)
	return digestOf(`${classOf.get(root.id) ?? ""}\n${Arr.join(sortedTexts([...quotient]), "\n")}`)
}
