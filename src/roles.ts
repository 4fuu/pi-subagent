import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Role } from "./types.ts";

const NAMES = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KNOWN = new Set(["name", "description", "tools", "model", "thinking", "maxTurns"]);

export function parseRole(text: string, source: string): Role {
	const { frontmatter: raw, body: rawBody } = parseFrontmatter<Record<string, unknown>>(text);
	for (const key of Object.keys(raw)) {
		if (!KNOWN.has(key)) throw new Error(`unknown field ${key}`);
	}

	const stem = basename(source, ".md");
	if (typeof raw.name !== "string" || !NAMES.test(raw.name) || raw.name !== stem) {
		throw new Error("name must equal filename stem and match [a-z0-9][a-z0-9-]{0,63}");
	}
	const description = typeof raw.description === "string" ? raw.description.trim() : "";
	if (!description || description.includes("\n") || description.length > 160) {
		throw new Error("description must be a non-empty single line of at most 160 characters");
	}

	let tools: string[];
	if (typeof raw.tools === "string") tools = raw.tools.split(",").map((value) => value.trim()).filter(Boolean);
	else if (Array.isArray(raw.tools) && raw.tools.every((value) => typeof value === "string")) {
		tools = raw.tools.map((value) => value.trim()).filter(Boolean);
	} else throw new Error("tools is required and must be a comma-separated string or string array");
	if (tools.some((tool) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(tool))) {
		throw new Error("tools contains an invalid tool name");
	}

	const body = rawBody.trim();
	if (!body || Buffer.byteLength(body) > 32768) throw new Error("body must be non-empty and at most 32 KiB");
	if (raw.maxTurns !== undefined && (!Number.isInteger(raw.maxTurns) || (raw.maxTurns as number) < 1 || (raw.maxTurns as number) > 100)) {
		throw new Error("maxTurns must be an integer from 1 to 100");
	}
	if (raw.model !== undefined && (typeof raw.model !== "string" || !/^[^/\s]+\/\S+$/.test(raw.model))) {
		throw new Error("model must be provider/model");
	}
	if (raw.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(raw.thinking))) {
		throw new Error("invalid thinking level");
	}

	return {
		name: raw.name,
		description,
		tools: [...new Set(tools.filter((tool) => tool !== "subagent"))],
		model: raw.model as string | undefined,
		thinking: raw.thinking as string | undefined,
		maxTurns: (raw.maxTurns as number | undefined) ?? 30,
		body,
		source,
	};
}

export interface RoleDiscoveryOptions {
	packageDir?: string;
	userDir?: string;
}

export function discoverRoles(cwd: string, options: RoleDiscoveryOptions = {}): { roles: Map<string, Role>; diagnostics: string[] } {
	const packageDir = options.packageDir ?? fileURLToPath(new URL("../roles", import.meta.url));
	const userDir = options.userDir ?? join(getAgentDir(), "subagents");
	const roles = new Map<string, Role>();
	const diagnostics: string[] = [];
	for (const dir of [packageDir, userDir, join(cwd, ".pi", "subagents")]) {
		let files: string[];
		try {
			files = readdirSync(dir, { withFileTypes: true })
				.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
				.map((entry) => entry.name)
				.sort();
		} catch {
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				const role = parseRole(readFileSync(path, "utf8"), path);
				roles.set(role.name, role);
			} catch (error) {
				diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return { roles, diagnostics };
}

export const ROLE_PROMPT_BEGIN = "<pi_subagent_roles>";
export const ROLE_PROMPT_END = "</pi_subagent_roles>";

export function rolePrompt(cwd: string, options?: RoleDiscoveryOptions): string {
	const { roles } = discoverRoles(cwd, options);
	const rows = [...roles.values()].map((role) => `- ${role.name}: ${role.description}`);
	return [
		ROLE_PROMPT_BEGIN,
		"Available subagent roles:",
		...(rows.length > 0 ? rows : ["- none"]),
		ROLE_PROMPT_END,
	].join("\n");
}

export function appendCurrentRolePrompt(systemPrompt: string, cwd: string, options?: RoleDiscoveryOptions): string {
	const begin = systemPrompt.indexOf(ROLE_PROMPT_BEGIN);
	const end = systemPrompt.indexOf(ROLE_PROMPT_END);
	const base = begin >= 0 && end >= begin
		? `${systemPrompt.slice(0, begin)}${systemPrompt.slice(end + ROLE_PROMPT_END.length)}`.trimEnd()
		: systemPrompt.trimEnd();
	return `${base}\n\n${rolePrompt(cwd, options)}`;
}
