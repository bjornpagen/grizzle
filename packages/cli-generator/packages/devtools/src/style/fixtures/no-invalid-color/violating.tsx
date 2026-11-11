export function PaletteFixture() {
	return (
		<div
			className="bg-blue-500" // violation
		>
			<span
				className="hover:text-gray-700/50" // violation
			/>
			<span className="bg-primary text-blue" />
		</div>
	)
}
