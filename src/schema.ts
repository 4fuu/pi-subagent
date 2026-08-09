export interface Params {
	role?: string;
	task?: string;
	notifyOn?: string;
	taskId?: string;
	wait?: number;
	stop?: boolean;
	message?: string;
}

const TASK_ID = /^sa_[a-f0-9]{20}$/;
const ROLE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateParams(p: Params): "launch" | "query" {
	const launch = p.role !== undefined || p.task !== undefined;
	const query = p.taskId !== undefined;
	if (launch === query) throw new Error("exactly one of role+task or taskId is required");
	if (launch && (!p.role || !p.task)) throw new Error("launch requires both role and task");
	if (launch && !ROLE_NAME.test(p.role!)) throw new Error("role must match [a-z0-9][a-z0-9-]{0,63}");
	if (launch && Buffer.byteLength(p.task!) > 65536) throw new Error("task must be at most 64 KiB");
	if (launch && (p.stop !== undefined || p.message !== undefined)) throw new Error("stop and message are taskId-only");
	if (query && !TASK_ID.test(p.taskId!)) throw new Error("taskId must be a valid sa_ task ID");
	if (query && p.notifyOn !== undefined) throw new Error("notifyOn is launch-only");
	if (p.stop !== undefined && p.message !== undefined) throw new Error("stop and message are mutually exclusive");
	if (p.stop && p.wait !== undefined) throw new Error("wait is not accepted when stop=true");
	if (p.wait !== undefined && (!Number.isFinite(p.wait) || p.wait < 0 || p.wait > 300)) {
		throw new Error("wait must be 0..300 seconds");
	}
	if (p.notifyOn !== undefined && (Buffer.byteLength(p.notifyOn) < 1 || Buffer.byteLength(p.notifyOn) > 256)) {
		throw new Error("notifyOn must be 1..256 UTF-8 bytes");
	}
	if (p.message !== undefined && (!p.message || Buffer.byteLength(p.message) > 32768)) {
		throw new Error("message must be 1..32768 UTF-8 bytes");
	}
	return launch ? "launch" : "query";
}
