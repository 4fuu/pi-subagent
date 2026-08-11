import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Role } from "./types.ts";

const NAMES = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KNOWN = new Set(["name", "description", "tools", "model", "thinking", "maxTurns"]);

export function parseRole(text: string, source: string): Role {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) {
		throw new Error("role must start with a YAML frontmatter delimiter (`---`) on its own line");
	}
	if (!normalized.includes("\n---\n")) {
		throw new Error("role YAML frontmatter must end with a delimiter (`---`) on its own line before the body");
	}
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
	if (raw.maxTurns !== undefined && (!Number.isInteger(raw.maxTurns) || (raw.maxTurns as number) < 1 || (raw.maxTurns as number) > 500)) {
		throw new Error("maxTurns must be an integer from 1 to 500");
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
		maxTurns: (raw.maxTurns as number | undefined) ?? 256,
		body,
		source,
	};
}

export interface RoleDiscoveryOptions {
	packageDir?: string;
	userDir?: string;
}

export interface RoleDiscovery {
	roles: Map<string, Role>;
	diagnostics: string[];
	invalidRoles: Map<string, string>;
}

export function discoverRoles(cwd: string, options: RoleDiscoveryOptions = {}): RoleDiscovery {
	const packageDir = options.packageDir ?? fileURLToPath(new URL("../roles", import.meta.url));
	const userDir = options.userDir ?? join(getAgentDir(), "subagents");
	const roles = new Map<string, Role>();
	const diagnostics: string[] = [];
	const invalidRoles = new Map<string, string>();
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
			const stem = basename(file, ".md");
			try {
				const role = parseRole(readFileSync(path, "utf8"), path);
				roles.set(role.name, role);
				invalidRoles.delete(role.name);
			} catch (error) {
				const diagnostic = `${path}: ${error instanceof Error ? error.message : String(error)}`;
				diagnostics.push(diagnostic);
				if (NAMES.test(stem)) {
					roles.delete(stem);
					invalidRoles.set(stem, diagnostic);
				}
			}
		}
	}
	return { roles, diagnostics, invalidRoles };
}

export const ROLE_PROMPT_BEGIN = "<pi_subagent_roles>";
export const ROLE_PROMPT_END = "</pi_subagent_roles>";

export function rolePrompt(discovery: RoleDiscovery): string {
	const rows = [...discovery.roles.values()].map((role) => `- ${role.name}: ${role.description}`);
	return [
		ROLE_PROMPT_BEGIN,
		"Available subagent roles:",
		...(rows.length > 0 ? rows : ["- none"]),
		ROLE_PROMPT_END,
	].join("\n");
}

export function appendRolePrompt(systemPrompt: string, catalog: string): string {
	const begin = systemPrompt.indexOf(ROLE_PROMPT_BEGIN);
	const end = systemPrompt.indexOf(ROLE_PROMPT_END);
	const base = begin >= 0 && end >= begin
		? `${systemPrompt.slice(0, begin)}${systemPrompt.slice(end + ROLE_PROMPT_END.length)}`.trimEnd()
		: systemPrompt.trimEnd();
	return `${base}\n\n${catalog}`;
}

export function resolveRoleForLaunch(discovery: RoleDiscovery, name: string): Role {
	const diagnostic = discovery.invalidRoles.get(name);
	if (diagnostic) {
		throw new Error(`role ${JSON.stringify(name)} is invalid: ${diagnostic}\nFix the Markdown frontmatter and retry; role files are reloaded on every launch.`);
	}
	const role = discovery.roles.get(name);
	if (!role) {
		throw new Error(`unknown role ${JSON.stringify(name)}; available: ${[...discovery.roles.keys()].join(", ") || "none"}`);
	}
	return role;
}
