export const read = (): number => {
	try { // violation
		return 1
	} catch {
		return 0
	}
}
export const cleaned = (): void => {
	try { // violation
		read()
	} finally {
		read()
	}
}
