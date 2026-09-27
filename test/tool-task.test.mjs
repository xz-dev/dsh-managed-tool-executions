import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "../index.js";

function jobView(over = {}) {
	return {
		id: "bash-1",
		kind: "bash",
		label: "sleep 1",
		owner: "session-1",
		status: "running",
		startedAt: 1,
		...over,
	};
}

function fakeRegistry() {
	const calls = [];
	const jobs = new Map();
	const reg = {
		calls,
		jobs,
		// test hooks
		waitView: undefined,
		waitError: undefined,
		killResult: "requested",
		readResult: { chunks: [], lossy: false, job: { output: {} } },
		list(owner) {
			calls.push(["list", owner]);
			return [...jobs.values()];
		},
		get(id, owner) {
			calls.push(["get", id, owner]);
			const job = jobs.get(id);
			if (job === undefined) throw new Error(`unknown job ${id}`);
			return job;
		},
		async wait(id, timeoutMs, owner, signal) {
			calls.push(["wait", id, timeoutMs, owner, signal !== undefined]);
			if (reg.waitError) throw reg.waitError;
			return reg.waitView;
		},
		read(id, owner) {
			calls.push(["read", id, owner]);
			return reg.readResult;
		},
		kill(id, owner, reason) {
			calls.push(["kill", id, owner, reason]);
			const job = jobs.get(id);
			if (job === undefined) throw new Error(`unknown job ${id}`);
			return reg.killResult;
		},
	};
	return reg;
}

function setup() {
	const registry = fakeRegistry();
	let definition;
	const ctx = {
		jobs: registry,
		tools: {
			register(def) {
				definition = def;
			},
		},
	};
	apply(ctx);
	assert.ok(definition, "tool registered");
	return { registry, def: definition };
}

const exec = { agent: { id: "session-1" }, signal: new AbortController().signal };

test("registers a tool named tool_task with the four Pi actions", () => {
	const { def } = setup();
	assert.equal(def.name, "tool_task");
	assert.deepEqual(def.parameters.properties.action.enum, ["list", "info", "wait", "cancel"]);
	// no declared timeoutMs: the timeout-policy wrapper must not arm a deadline
	// under the 1800s bounded wait.
	assert.equal(def.timeoutMs, undefined);
});

test("list: empty roster matches Pi text", async () => {
	const { def } = setup();
	const value = await def.execute({ action: "list" }, exec);
	assert.equal(value.text, "No managed tool executions.");
});

test("list: formats id status kind (label), one per line, owner-scoped", async () => {
	const { registry, def } = setup();
	registry.jobs.set("bash-1", jobView());
	registry.jobs.set("bash-2", jobView({ id: "bash-2", status: "completed", label: "make build" }));
	const value = await def.execute({ action: "list" }, exec);
	assert.equal(value.text, "bash-1 running bash (sleep 1)\nbash-2 completed bash (make build)");
	assert.deepEqual(registry.calls[0], ["list", "session-1"]);
});

test("info: returns the task line with status; unknown id throws the Pi error", async () => {
	const { registry, def } = setup();
	registry.jobs.set("bash-1", jobView({ status: "completed", detail: "exit code: 0" }));
	const value = await def.execute({ action: "info", id: "bash-1" }, exec);
	assert.equal(value.text, "bash-1 completed bash (sleep 1) [status: completed, exit code: 0]");
	await assert.rejects(() => def.execute({ action: "info", id: "nope" }, exec), /^Error: Unknown managed tool execution: nope$/);
});

test("info and cancel require id", async () => {
	const { def } = setup();
	await assert.rejects(() => def.execute({ action: "info" }, exec), /requires argument "id"/);
	await assert.rejects(() => def.execute({ action: "cancel" }, exec), /requires argument "id"/);
});

test("wait: requires timeoutSeconds and bounds it to (0, 1800]", async () => {
	const { registry, def } = setup();
	registry.jobs.set("bash-1", jobView());
	await assert.rejects(() => def.execute({ action: "wait", id: "bash-1" }, exec), /requires argument "timeoutSeconds"/);
	// NaN/Infinity are rejected by the defineTool schema layer before execute.
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
		await assert.rejects(
			() => def.execute({ action: "wait", id: "bash-1", timeoutSeconds: bad }, exec),
			/finite JSON number/,
		);
	}
	for (const bad of [0, -1, 1801]) {
		await assert.rejects(
			() => def.execute({ action: "wait", id: "bash-1", timeoutSeconds: bad }, exec),
			/positive finite number no greater than 1800/,
		);
	}
	// 1800 exactly is accepted and converted to ms for the registry.
	registry.waitView = jobView({ status: "completed" });
	await def.execute({ action: "wait", id: "bash-1", timeoutSeconds: 1800 }, exec);
	assert.equal(registry.calls.at(-2)[0], "wait");
	assert.equal(registry.calls.at(-2)[2], 1800 * 1000);
});

test("wait: settled job returns the consuming output read plus status line", async () => {
	const { registry, def } = setup();
	registry.jobs.set("bash-1", jobView());
	registry.waitView = jobView({ status: "completed", detail: "exit code: 0" });
	registry.readResult = {
		chunks: [
			{ at: 0, text: "hello\n", channel: "stdout" },
			{ at: 6, text: "oops\n", channel: "stderr" },
			{ at: 0, text: "narration", channel: "log" },
		],
		lossy: false,
		job: { output: {} },
	};
	const value = await def.execute({ action: "wait", id: "bash-1", timeoutSeconds: 5 }, exec);
	assert.equal(value.text, "hello\n[stderr]\noops\n[status: completed, exit code: 0]");
	// owner and caller signal forwarded to the registry wait
	const waitCall = registry.calls.find((c) => c[0] === "wait");
	assert.equal(waitCall[3], "session-1");
	assert.equal(waitCall[4], true);
});

test("wait: still running reports the elapsed bound, no output read", async () => {
	const { registry, def } = setup();
	registry.jobs.set("bash-1", jobView());
	registry.waitView = jobView({ status: "running" });
	const value = await def.execute({ action: "wait", id: "bash-1", timeoutSeconds: 3 }, exec);
	assert.equal(value.text, "Managed tool execution bash-1 did not complete within 3 seconds [status: running]");
	assert.equal(registry.calls.some((c) => c[0] === "read"), false);
});

test("wait: lossy read names the spill files", async () => {
	const { registry, def } = setup();
	registry.jobs.set("bash-1", jobView());
	registry.waitView = jobView({ status: "completed", detail: "exit code: 0" });
	registry.readResult = {
		chunks: [{ at: 100, text: "tail\n", channel: "stdout" }],
		lossy: true,
		job: { output: { spillPaths: ["/tmp/spill-1"] } },
	};
	const value = await def.execute({ action: "wait", id: "bash-1", timeoutSeconds: 5 }, exec);
	assert.equal(
		value.text,
		"[some output was dropped from memory; full output: /tmp/spill-1]\ntail\n[status: completed, exit code: 0]",
	);
});

test("wait: unknown id maps to the Pi error", async () => {
	const { registry, def } = setup();
	registry.jobs.set("bash-1", jobView());
	registry.waitError = new Error("unknown job bash-9");
	await assert.rejects(
		() => def.execute({ action: "wait", id: "bash-9", timeoutSeconds: 5 }, exec),
		/Unknown managed tool execution: bash-9/,
	);
});

test("cancel: requested vs already-finished wording; unknown id throws", async () => {
	const { registry, def } = setup();
	registry.jobs.set("bash-1", jobView());
	registry.killResult = "requested";
	let value = await def.execute({ action: "cancel", id: "bash-1" }, exec);
	assert.equal(value.text, "Cancellation requested for managed tool execution bash-1.");
	const killCall = registry.calls.find((c) => c[0] === "kill");
	assert.equal(killCall[2], "session-1");
	registry.killResult = "already-finished";
	value = await def.execute({ action: "cancel", id: "bash-1" }, exec);
	assert.equal(value.text, "Managed tool execution bash-1 is already finished; no cancellation request was sent.");
	await assert.rejects(() => def.execute({ action: "cancel", id: "nope" }, exec), /Unknown managed tool execution: nope/);
});

test("unknown action is rejected by schema validation", async () => {
	const { def } = setup();
	await assert.rejects(() => def.execute({ action: "bogus" }, exec), /must be one of/);
});

test("cordis.patch.yml pins the 600s/1200s detach mapping and the plugin row", async () => {
	const { readFileSync } = await import("node:fs");
	const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
	// min(requested ?? 600000, 600000): no timeout -> 600s detach; timeout > 1200s -> 600s detach.
	assert.match(patch, /- id: bash-sandbox\n  config:\n    timeoutMs: 600000\n    maxTimeoutMs: 600000/);
	assert.match(patch, /- id: tool-task\n      name: dsh-managed-tool-executions/);
});
