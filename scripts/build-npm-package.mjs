import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");

const directoriesToStage = ["extensions", "skills", "examples", "img"];
const filesToStage = ["package.json", "LICENSE", "CHANGELOG.md", "scripts/setup-gate-auto-approver.mjs", "scripts/eval-gate-auto-approver.mjs", "scripts/smoke-gate-auto-soft-block.mjs"];
const npmReadmePath = path.join(rootDir, "README.npm.md");

function removeDistPath(relativePath) {
	const target = path.join(distDir, relativePath);
	if (!target.startsWith(`${distDir}${path.sep}`)) {
		throw new Error(`Refusing to remove path outside dist: ${target}`);
	}
	fs.rmSync(target, { recursive: true, force: true });
}

function copyDirectory(relativePath) {
	const source = path.join(rootDir, relativePath);
	const target = path.join(distDir, relativePath);
	fs.cpSync(source, target, { recursive: true });
}

function copyFile(sourceRelativePath, targetRelativePath = sourceRelativePath) {
	const target = path.join(distDir, targetRelativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(path.join(rootDir, sourceRelativePath), target);
}

if (!fs.existsSync(npmReadmePath)) {
	throw new Error("Missing README.npm.md; cannot build npm staging package.");
}

fs.mkdirSync(distDir, { recursive: true });

for (const relativePath of [...directoriesToStage, ...filesToStage, "README.md"]) {
	removeDistPath(relativePath);
}

for (const relativePath of directoriesToStage) {
	copyDirectory(relativePath);
}

for (const relativePath of filesToStage) {
	copyFile(relativePath);
}

copyFile("README.npm.md", "README.md");

console.log(`Built npm staging package in ${path.relative(rootDir, distDir) || "."}`);
