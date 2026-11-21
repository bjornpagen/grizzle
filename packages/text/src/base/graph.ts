import { defined } from "#text/base/invariant.ts"
import type { NonEmptyReadonlyArray } from "#text/base/nonempty.ts"

/**
 * The walks the engine orders a directed graph by, each once: a graph is the vertices `roots` reach through a function
 * of each vertex's successors (its inputs, its reads, its references), walked depth first from each root in order and
 * through each vertex's successors in their order. Every walk keeps its frames on the heap, so a chain of any depth
 * walks, and a vertex is a value the walk tells apart by SameValueZero, as a Set does.
 */

/**
 * The vertices `roots` reach through `inputs`, in topological order: every vertex after its inputs, depth-first from
 * each root in order and through each vertex's inputs in their order, each vertex once (a vertex met again, on a path
 * or off it, is not entered again, so the walk ends over any graph). Its frames are on the heap: a chain of any depth
 * walks.
 */
export const postorder = <V>(
	roots: ReadonlyArray<V>,
	inputs: (vertex: V) => ReadonlyArray<V>
): ReadonlyArray<V> => {
	const order: Array<V> = []
	const seen = new Set<V>()
	for (const root of roots) {
		if (seen.has(root)) {
			continue
		}
		seen.add(root)
		const stack: Array<{ readonly vertex: V; readonly inputs: ReadonlyArray<V>; next: number }> = [
			{ vertex: root, inputs: inputs(root), next: 0 }
		]
		for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
			const input = frame.inputs[frame.next]
			if (input === undefined) {
				stack.pop()
				order.push(frame.vertex)
				continue
			}
			frame.next++
			if (!seen.has(input)) {
				seen.add(input)
				stack.push({ vertex: input, inputs: inputs(input), next: 0 })
			}
		}
	}
	return order
}

/**
 * A vertex on Tarjan's walk: its successors and how many it has walked, its discovery index, its low link, which the
 * walk lowers, and its depth on the walk's stack of open vertices, where its component starts if it is its root.
 */
interface Frame<V> {
	readonly vertex: V
	readonly successors: ReadonlyArray<V>
	next: number
	readonly index: number
	low: number
	readonly depth: number
}

/**
 * The component whose root is `root`, taken off the walk's stack of open vertices `stack`: the vertices from the top down
 * to the root, the one entered last first and the root, the first entered, last.
 */
const closed = <V>(stack: Array<V>, root: V): NonEmptyReadonlyArray<V> => {
	const top = defined(stack.pop(), "a closed component's root is on the stack")
	const component: [V, ...Array<V>] = [top]
	for (let vertex = top; vertex !== root;) {
		vertex = defined(stack.pop(), "a closed component's root is on the stack")
		component.push(vertex)
	}
	return component
}

/**
 * The strongly connected components of the graph `roots` reach through `next` (Tarjan's algorithm), in the order the
 * walk closes them: a component after every component it reaches, so a reader that takes each in turn finds every
 * vertex a component reaches outside it already taken. A component's vertices are in the order the walk's stack gives
 * them back, the one entered last first and the component's root, the first entered, last. The walk is depth first from
 * each root in order and through each vertex's successors in their order, each vertex entered once.
 */
export const stronglyConnected = <V>(
	roots: ReadonlyArray<V>,
	next: (vertex: V) => ReadonlyArray<V>
): ReadonlyArray<NonEmptyReadonlyArray<V>> => {
	const components: Array<NonEmptyReadonlyArray<V>> = []
	/** Each entered vertex's discovery index, while it is open: entered, and its component not yet closed. */
	const open = new Map<V, number>()
	const entered = new Set<V>()
	const stack: Array<V> = []
	const enter = (vertex: V): Frame<V> => {
		const index = entered.size
		entered.add(vertex)
		open.set(vertex, index)
		const frame = {
			vertex,
			successors: next(vertex),
			next: 0,
			index,
			low: index,
			depth: stack.length
		}
		stack.push(vertex)
		return frame
	}
	for (const root of roots) {
		if (entered.has(root)) {
			continue
		}
		const walk: Array<Frame<V>> = [enter(root)]
		for (let frame = walk.at(-1); frame !== undefined; frame = walk.at(-1)) {
			const successor = frame.successors[frame.next]
			if (successor !== undefined) {
				frame.next++
				const index = open.get(successor)
				if (!entered.has(successor)) {
					walk.push(enter(successor))
				} else if (index !== undefined) {
					frame.low = Math.min(frame.low, index)
				}
				continue
			}
			walk.pop()
			const parent = walk.at(-1)
			if (parent !== undefined) {
				parent.low = Math.min(parent.low, frame.low)
			}
			if (frame.low === frame.index) {
				const component = closed(stack, frame.vertex)
				for (const vertex of component) {
					open.delete(vertex)
				}
				components.push(component)
			}
		}
	}
	return components
}
