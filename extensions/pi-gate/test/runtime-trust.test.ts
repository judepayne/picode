import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRuntimeFamilyApprovalKey, classifyRuntimeCommand, extractRuntimeTrustFamilyNames, runtimeCandidateOwnsComplexity } from "../runtime-trust.ts";

const roots: string[] = [];
function workspace() { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-trust-"))); roots.push(root); fs.writeFileSync(path.join(root, "app.py"), ""); fs.writeFileSync(path.join(root, "app.js"), ""); fs.writeFileSync(path.join(root, "run.sh"), ""); return root; }
test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

test("recognizes initial launcher families and aliases", () => {
	const cwd = workspace();
	for (const name of ["python", "python3", "python3.12"]) assert.equal(classifyRuntimeCommand(`${name} -c x`, cwd)?.family, "python");
	assert.equal(classifyRuntimeCommand("py -3 -c x", cwd)?.family, "python");
	for (const name of ["node", "nodejs"]) assert.equal(classifyRuntimeCommand(`${name} -e x`, cwd)?.family, "node");
	for (const name of ["bun", "tsx", "tsx-esm", "ts-node", "ts-node-esm"]) assert.equal(classifyRuntimeCommand(`${name} -e x`, cwd)?.family, "javascript-typescript");
	for (const name of ["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"]) assert.equal(classifyRuntimeCommand(`${name} -c echo`, cwd)?.family, "shell");
});

test("classifies execution forms and contains explicit scripts", () => {
	const cwd = workspace();
	for (const [command, syntax] of [["python app.py", "script"], ["python -m http.server", "module"], ["python -c pass", "inline"], ["python -", "stdin"], ["node app.js", "script"], ["node --test", "runner"], ["deno task check", "runner"], ["bun run test", "runner"], ["bash run.sh", "script"]]) assert.equal(classifyRuntimeCommand(command, cwd)?.syntax, syntax, command);
	assert.ok(classifyRuntimeCommand("env FOO=bar -- python -m pip", cwd));
	assert.equal(classifyRuntimeCommand("python missing.py", cwd), undefined);
	const outside = path.join(os.tmpdir(), `outside-${Date.now()}.py`);
	const outsideJs = path.join(os.tmpdir(), `outside-${Date.now()}.js`);
	fs.writeFileSync(outside, "");
	fs.writeFileSync(outsideJs, "");
	try {
		assert.equal(classifyRuntimeCommand(`python ${outside}`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`node --test ${outsideJs}`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`node --test app.js ${outsideJs}`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`node --require ${outsideJs} -e x`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`node -r=${outsideJs} -e x`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`node --loader=${outsideJs} app.js`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`node --experimental-loader=${outsideJs} app.js`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`node --import=${outsideJs}`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`python -m pytest ${outside}`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`deno test ${outsideJs}`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`bun run ${outsideJs}`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`bun test app.js ${outsideJs}`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`bun --preload=${outsideJs} app.js`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`bun -r ${outsideJs} app.js`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`tsx --require=${outsideJs} app.js`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`deno --config=${outsideJs} test`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`bash ${outside} -c echo`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`bash --rcfile=${outside} -i -c true`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`bash --init-file ${outside} -i -c true`, cwd), undefined);
		assert.equal(classifyRuntimeCommand(`fish --init-command=source\\ ${outside} -c true`, cwd), undefined);
		assert.equal(classifyRuntimeCommand("bash --login -c true", cwd), undefined);
		assert.equal(classifyRuntimeCommand("zsh -l -c true", cwd), undefined);
		assert.equal(classifyRuntimeCommand("fish -i -c true", cwd), undefined);
		assert.equal(classifyRuntimeCommand("pwsh -Login -Command true", cwd), undefined);
		assert.equal(classifyRuntimeCommand(`pwsh -File ${outside}`, cwd), undefined);
	} finally {
		fs.rmSync(outside);
		fs.rmSync(outsideJs);
	}
	try { fs.symlinkSync(os.tmpdir(), path.join(cwd, "escape"), "dir"); assert.equal(classifyRuntimeCommand("python escape/nope.py", cwd), undefined); } catch (error: any) { if (error.code !== "EPERM") throw error; }
});

test("rejects wrappers, excluded launchers, controls, paths, and malformed input", () => {
	const cwd = workspace();
	for (const command of ["echo python -c x", "/usr/bin/python -c x", "env PATH=/tmp python -c x", "env Path=/tmp python -c x", "env BASH_ENV=x bash -c x", "env LD_PRELOAD=/tmp/x.so python -c x", "env DYLD_INSERT_LIBRARIES=/tmp/x.dylib node -e x", "env NODE_OPTIONS=--require=/tmp/x node -e x", "env NODE_PATH=/tmp node -e x", "env PYTHONPATH=/tmp python -c x", "env -C /tmp python -c x", "env -S python -c x", "env -i python -c x", "env -u FOO python -c x", "npx tsx app.js", "bunx app.js", "pnpm dlx tsx app.js", "yarn dlx tsx app.js", "uvx python", "python 'unterminated", "python $(echo app.py)", "python -c x && echo y"]) assert.equal(classifyRuntimeCommand(command, cwd), undefined, command);
});

test("strict heredocs are opaque and reject malformed or trailing controls", () => {
	const cwd = workspace();
	const value = classifyRuntimeCommand("python <<'PY'\nprint('a | b')\nPY", cwd);
	assert.equal(value?.syntax, "heredoc"); assert.equal(runtimeCandidateOwnsComplexity(value!), true);
	for (const command of ["python <<PY\nx\nPY", "python <<PY\nx\nNO", "python <<PY\nx\nPY\necho x", "python app.py <<PY\nx\nPY", "python <<PY && echo x\nx\nPY"]) assert.equal(classifyRuntimeCommand(command, cwd), undefined);
});

test("approval keys and status extraction are stable", () => {
	const cwd = workspace();
	assert.equal(buildRuntimeFamilyApprovalKey("python", cwd), `runtime-family:python:project:${cwd}`);
	assert.deepEqual(extractRuntimeTrustFamilyNames([`profiles:a:runtime-family:shell:project:${cwd}`, `profiles:a:runtime-family:python:project:${cwd}`, "bash:x"]), ["Python", "Shell"]);
});
