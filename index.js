import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "tool-task";
export const inject = ["tools", "jobs"];

/** Pi parity: MAX_WAIT_SECONDS in packages/agent/src/managed-executions.ts. */
const MAX_WAIT_SECONDS = 1800;

function requireId(args) {
	if (typeof args.id !== "string" || args.id.length === 0)
		throw new Error(`action "${args.action}" requires argument "id".`);
	return args.id;
}

function requireTimeoutSeconds(args) {
	if (args.timeoutSeconds === undefined)
		throw new Error(`action "wait" requires argument "timeoutSeconds" (number > 0 and <= ${MAX_WAIT_SECONDS}).`);
	const t = args.timeoutSeconds;
	if (!Number.isFinite(t) || t <= 0 || t > MAX_WAIT_SECONDS)
		throw new Error(`timeoutSeconds must be a positive finite number no greater than ${MAX_WAIT_SECONDS}`);
	return t;
}

/** `<id> <status> <kind> (<label>)` — the Pi `formatTask` shape with DSH job fields. */
function formatTask(job) {
	return `${job.id} ${job.status} ${job.kind} (${job.label})`;
}

function statusLine(job) {
	return job.detail !== undefined ? `[status: ${job.status}, ${job.detail}]` : `[status: ${job.status}]`;
}

/** Render ring chunks like the shell tools do: stdout in order, then one [stderr] section; log chunks stay observer-only. */
function ringDelta(chunks) {
	const out = chunks.filter((c) => c.channel !== "stderr" && c.channel !== "log").map((c) => c.text).join("");
	const err = chunks.filter((c) => c.channel === "stderr").map((c) => c.text).join("");
	const sep = out.length > 0 && !out.endsWith("\n") ? "\n" : "";
	return out + (err.length > 0 ? `${sep}[stderr]\n${err}` : "");
}

function unknownAsPiError(error, id) {
	const message = error instanceof Error ? error.message : String(error);
	if (/unknown job|not visible|foreign/.test(message)) return new Error(`Unknown managed tool execution: ${id}`);
	return error instanceof Error ? error : new Error(message);
}

export function apply(ctx) {
	const jobs = ctx.jobs;
	ctx.tools.register(defineTool({
		name: "tool_task",
		description:
			"List, inspect, wait for, or request cancellation of managed background tool executions. Actions: list (no other arguments), info/cancel (also requires id), wait (also requires id and timeoutSeconds).",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ["list", "info", "wait", "cancel"],
				description: "list: all managed executions; info: one by id; wait: block until settlement or timeoutSeconds; cancel: request cancellation by id.",
			},
			id: { type: "string", description: "Managed execution id (required by info, wait, cancel)." },
			timeoutSeconds: {
				type: "number",
				description: `Wait bound in seconds for action "wait" (> 0 and <= ${MAX_WAIT_SECONDS}).`,
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string", required: true } },
			},
			render: (_args, value) => [{ type: "text", text: value.text }],
		},
		async execute(args, exec) {
			const owner = exec.agent?.id;
			switch (args.action) {
				case "list": {
					const tasks = jobs.list(owner);
					return { text: tasks.length > 0 ? tasks.map(formatTask).join("\n") : "No managed tool executions." };
				}
				case "info": {
					const id = requireId(args);
					let task;
					try {
						task = jobs.get(id, owner);
					} catch (error) {
						throw unknownAsPiError(error, id);
					}
					return { text: `${formatTask(task)} ${statusLine(task)}` };
				}
				case "wait": {
					const id = requireId(args);
					const timeoutSeconds = requireTimeoutSeconds(args);
					let view;
					try {
						view = await jobs.wait(id, timeoutSeconds * 1000, owner, exec.signal);
					} catch (error) {
						throw unknownAsPiError(error, id);
					}
					if (view.status === "running" || view.status === "stopping")
						return { text: `Managed tool execution ${id} did not complete within ${timeoutSeconds} seconds ${statusLine(view)}` };
					// Consuming read, exactly like job_output: the model collects the settled output once.
					const read = jobs.read(id, owner);
					const delta = ringDelta(read.chunks);
					const loss = read.lossy
						? `[some output was dropped from memory; full output: ${read.job.output?.spillPaths?.join(", ") || "(unavailable)"}]\n`
						: "";
					const body = delta.length > 0 ? `${loss}${delta}${delta.endsWith("\n") ? "" : "\n"}` : loss;
					return { text: `${body}${statusLine(view)}` };
				}
				case "cancel": {
					const id = requireId(args);
					let disposition;
					try {
						disposition = jobs.kill(id, owner, "cancel requested via tool_task");
					} catch (error) {
						throw unknownAsPiError(error, id);
					}
					return {
						text:
							disposition === "requested"
								? `Cancellation requested for managed tool execution ${id}.`
								: `Managed tool execution ${id} is already finished; no cancellation request was sent.`,
					};
				}
				default:
					throw new Error(`unknown action: ${String(args.action)}`);
			}
		},
	}));
}
