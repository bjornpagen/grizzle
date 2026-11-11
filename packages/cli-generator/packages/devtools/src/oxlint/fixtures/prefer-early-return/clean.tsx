export const total = (values: ReadonlyArray<number>, enabled: boolean): number => {
	if (!enabled) {
		return 0
	}
	const doubled = values.length * 2
	const halved = doubled / 2
	return halved
}
export const kept = (a: boolean, f: () => void, g: () => void, h: () => void): void => {
	if (a) {
		f()
		g()
		h()
	} else {
		g()
	}
}
