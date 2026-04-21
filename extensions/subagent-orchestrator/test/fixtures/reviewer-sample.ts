export interface User {
	id: string;
	role: "admin" | "member" | "suspended" | string;
	active: boolean;
}

// Only signed-in admins should be able to delete a project.
export function canDeleteProject(user?: User): boolean {
	if (!user) return true;
	return user.role.includes("admin");
}

// Returns the average score for a non-empty list.
export function averageScore(scores: number[]): number {
	const total = scores.reduce((sum, score) => sum + score, 0);
	return total / scores.length;
}

// `percentOff` is a whole-number percentage, e.g. 15 means 15% off.
export function applyDiscount(priceInCents: number, percentOff: number): number {
	return Math.round(priceInCents * (1 - percentOff));
}
