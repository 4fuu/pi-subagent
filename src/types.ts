export type Status = "queued" | "starting" | "running" | "finishing" | "completed" | "failed" | "cancelled" | "orphaned";

export function terminal(status: Status): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "orphaned";
}

export interface Role {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	thinking?: string;
	maxTurns: number;
	body: string;
	source: string;
}

export interface Launch {
	id: string;
	parentSessionId: string;
	role: string;
	roleSource: string;
	roleBody: string;
	task: string;
	cwd: string;
	createdAt: number;
	model?: string;
	thinking?: string;
	maxTurns: number;
	tools: string[];
	notifyOn?: string;
}

export interface Activity {
	at: number;
	kind: string;
	text: string;
}

export interface State {
	status: Status;
	updatedAt: number;
	startedAt?: number;
	endedAt?: number;
	pid?: number;
	ready?: boolean;
	result?: string;
	error?: string;
	failureKind?: "infrastructure";
	turn: number;
	tokens?: number;
	messageAcceptedAt?: number;
	activity: Activity[];
}

export type TaskRecord = Launch & State;

export interface Control {
	seq: string;
	kind: "stop" | "message";
	text?: string;
	at: number;
}

export interface ClaimedControl {
	path: string;
	originalPath: string;
	value: Control;
}

export interface Snapshot {
	taskId: string;
	status: Status;
	role: string;
	ready?: true;
	result?: string;
	error?: string;
	messageQueuedAt?: number;
	messageAcceptedAt?: number;
	activity?: Array<Pick<Activity, "kind" | "text">>;
	diagnosticsPath?: string;
}
