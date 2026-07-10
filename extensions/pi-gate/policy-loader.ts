import * as fs from "node:fs";
import * as path from "node:path";

import { BASE_PROFILE_NAME, type JsonSchemaNode, type LoadedPolicy, type PermissionConfig, type RawPolicy } from "./policy-types.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeProfileName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed === "base" ? BASE_PROFILE_NAME : trimmed;
}

function isEnvEnabled(value: string | undefined): boolean {
	if (!value) return false;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

function resolveSchemaRef(root: JsonSchemaNode, ref: string): JsonSchemaNode {
	if (!ref.startsWith("#/")) throw new Error(`unsupported schema ref ${ref}`);
	const segments = ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
	let current: unknown = root;
	for (const segment of segments) {
		if (!isPlainObject(current) || !(segment in current)) {
			throw new Error(`missing schema ref target ${ref}`);
		}
		current = current[segment];
	}
	if (!isPlainObject(current)) throw new Error(`invalid schema ref target ${ref}`);
	return current as JsonSchemaNode;
}

function formatSchemaPath(basePath: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `${basePath}.${key}` : `${basePath}[${JSON.stringify(key)}]`;
}

function validateValueAgainstSchema(root: JsonSchemaNode, schema: JsonSchemaNode, value: unknown, currentPath: string): string | undefined {
	if (schema.$ref) {
		return validateValueAgainstSchema(root, resolveSchemaRef(root, schema.$ref), value, currentPath);
	}

	if (schema.anyOf && schema.anyOf.length > 0) {
		const errors = schema.anyOf
			.map((option) => validateValueAgainstSchema(root, option, value, currentPath))
			.filter((error): error is string => Boolean(error));
		if (errors.length === schema.anyOf.length) return errors[0];
		return undefined;
	}

	if (schema.type === "string" && typeof value !== "string") {
		return `${currentPath} must be a string`;
	}
	if (schema.type === "boolean" && typeof value !== "boolean") {
		return `${currentPath} must be a boolean`;
	}

	if (schema.type === "object") {
		if (!isPlainObject(value)) return `${currentPath} must be an object`;
		for (const required of schema.required ?? []) {
			if (!(required in value)) return `${formatSchemaPath(currentPath, required)} is required`;
		}

		const properties = schema.properties ?? {};
		for (const [key, childValue] of Object.entries(value)) {
			const propertySchema = properties[key];
			if (propertySchema) {
				const error = validateValueAgainstSchema(root, propertySchema, childValue, formatSchemaPath(currentPath, key));
				if (error) return error;
				continue;
			}

			if (schema.additionalProperties === false) {
				return `${formatSchemaPath(currentPath, key)} is not allowed`;
			}
			if (isPlainObject(schema.additionalProperties)) {
				const error = validateValueAgainstSchema(
					root,
					schema.additionalProperties as JsonSchemaNode,
					childValue,
					formatSchemaPath(currentPath, key),
				);
				if (error) return error;
			}
		}
	}

	if (schema.enum && !schema.enum.includes(value)) {
		return `${currentPath} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
	}

	return undefined;
}

export function validatePolicySchema(schema: JsonSchemaNode, policy: unknown): string | undefined {
	return validateValueAgainstSchema(schema, schema, policy, "$policy");
}

function validatePermissionConfigSemantics(config: PermissionConfig | undefined, scope: string): string | undefined {
	if (config === undefined) return undefined;
	if (typeof config === "string") return undefined;
	for (const [subject, rule] of Object.entries(config)) {
		if (!subject.trim()) return `${scope} permission subject keys must not be empty`;
		if (subject === "*" && typeof rule !== "string") {
			return `${scope}.${subject} must be an action string`;
		}
		if (typeof rule === "string") continue;
		for (const pattern of Object.keys(rule)) {
			if (!pattern) return `${scope}.${subject} contains an empty pattern key`;
		}
	}
	return undefined;
}

function validatePolicySemantics(policy: RawPolicy): string | undefined {
	const profiles = policy.profiles ?? {};
	const basePermissionError = validatePermissionConfigSemantics(policy.permission, "permission");
	if (basePermissionError) return basePermissionError;

	for (const [profileName, profile] of Object.entries(profiles)) {
		const permissionError = validatePermissionConfigSemantics(profile.permission, `profiles.${profileName}.permission`);
		if (permissionError) return permissionError;
		const inherited = normalizeProfileName(profile["inherits-from"]);
		if (inherited && inherited !== BASE_PROFILE_NAME && !profiles[inherited]) {
			return `profiles.${profileName}.inherits-from references unknown profile ${JSON.stringify(inherited)}`;
		}
	}

	const activeProfile = normalizeProfileName(policy.activeProfile);
	if (activeProfile && activeProfile !== BASE_PROFILE_NAME && !profiles[activeProfile]) {
		return `activeProfile references unknown profile ${JSON.stringify(activeProfile)}`;
	}

	const visited = new Set<string>();
	const stack = new Set<string>();
	const visit = (profileName: string): string | undefined => {
		if (visited.has(profileName)) return undefined;
		if (stack.has(profileName)) return `circular profile inheritance detected at ${JSON.stringify(profileName)}`;
		stack.add(profileName);
		const profile = profiles[profileName];
		const parent = normalizeProfileName(profile?.["inherits-from"]) ?? BASE_PROFILE_NAME;
		if (parent !== BASE_PROFILE_NAME) {
			const error = visit(parent);
			if (error) return error;
		}
		stack.delete(profileName);
		visited.add(profileName);
		return undefined;
	};

	for (const profileName of Object.keys(profiles)) {
		const error = visit(profileName);
		if (error) return error;
	}

	return undefined;
}

export function loadPolicy(policyPath: string, schemaPath: string): LoadedPolicy {
	let rawPolicy: unknown;
	try {
		rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			policyPath,
			schemaPath,
			error: `failed to load gate policy: ${message}. Tool calls are blocked until the gate policy is fixed.`,
		};
	}

	let schema: JsonSchemaNode;
	try {
		schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as JsonSchemaNode;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			policy: isPlainObject(rawPolicy) ? (rawPolicy as RawPolicy) : undefined,
			policyPath,
			schemaPath,
			error: `schema validation failed! failed to load ${path.basename(schemaPath)}: ${message}. Tool calls are blocked until the gate policy is fixed.`,
		};
	}

	const schemaError = validatePolicySchema(schema, rawPolicy);
	if (schemaError) {
		return {
			policy: isPlainObject(rawPolicy) ? (rawPolicy as RawPolicy) : undefined,
			policyPath,
			schemaPath,
			error: `schema validation failed! ${schemaError}. Tool calls are blocked until the gate policy is fixed.`,
		};
	}

	const policy = rawPolicy as RawPolicy;
	const semanticError = validatePolicySemantics(policy);
	if (semanticError) {
		return {
			policy,
			policyPath,
			schemaPath,
			error: `policy validation failed! ${semanticError}. Tool calls are blocked until the gate policy is fixed.`,
		};
	}

	return { policy, policyPath, schemaPath };
}

