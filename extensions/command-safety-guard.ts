/**
 * Global Command Execution Safety Guard (`command-safety-guard.ts`)
 *
 * Lightweight harness-level guard using Pi's native `tool_call` and `tool_result` hooks:
 *   - Enforces timeout ceilings on `bash` commands regardless of model requests:
 *       * Searches (rg, grep, find, fd): 30s
 *       * Ordinary Bash: 120s
 *       * Git operations: 180s
 *       * Tests, builds, Python scripts: 600s (10m)
 *       * Authorized production deployments: 1800s (30m)
 *   - Blocks obvious runaway wide searches (root `/` or unbounded `$HOME`).
 *   - Blocks repeated identical timed-out commands within the session.
 *   - Blocks unauthorized production deployments while allowing authorized ones.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const TIMEOUT_POLICY_SECONDS = Object.freeze({
	search: 30,
	ordinary: 120,
	git: 180,
	test_build_python: 600,
	authorized_deploy: 1800,
});

export type CommandCategory = keyof typeof TIMEOUT_POLICY_SECONDS;

export interface ClassificationResult {
	blocked: boolean;
	blockCode?: "dangerous_wide_search" | "unauthorized_deploy" | "repeated_timeout" | "long_running_process";
	category: CommandCategory;
	policyTimeoutSeconds: number;
	effectiveTimeoutSeconds: number;
	requestedTimeoutSeconds?: number;
	clamped: boolean;
	reason?: string;
}

const SEARCH_BINS = new Set(["rg", "ripgrep", "grep", "egrep", "fgrep", "ugrep", "ag", "ack", "find", "fd", "fdfind"]);
const GIT_BINS = new Set(["git", "gh"]);
const PYTHON_BINS = new Set(["python", "python3", "pypy", "pypy3"]);
const TEST_BUILD_BINS = new Set([
	"pytest",
	"py.test",
	"vitest",
	"jest",
	"mocha",
	"playwright",
	"cypress",
	"tsc",
	"tsup",
	"esbuild",
	"rollup",
	"webpack",
	"turbo",
	"nx",
	"rustc",
	"make",
	"cmake",
	"ninja",
	"gradle",
	"gradlew",
	"mvn",
	"gcc",
	"g++",
	"clang",
	"clang++",
	"tox",
	"nox",
	"ruff",
	"mypy",
	"pyright",
	"eslint",
	"biome",
]);

const WIDE_ROOT_PATHS = new Set([
	"/",
	"/proc",
	"/sys",
	"/dev",
	"/Users",
	"/home",
	"/var",
	"/usr",
	"/etc",
	"/opt",
	"/storage",
	"/sdcard",
	"/data",
	"/data/data",
	"/data/data/com.termux",
	"/data/data/com.termux/files",
]);

export const guardState = {
	enabled: true,
	deployAuthorized: false,
	latestUserPrompt: "",
	timedOutCommands: new Map<string, { command: string; cwd: string; category: CommandCategory; timeoutSeconds: number; attempts: number }>(),
};

/** Ensure `<agent-dir>/bin` is at the end of PATH on non-macOS so Mach-O binaries don't shadow native tools. */
export function ensurePlatformPathOrder(): void {
	if (process.platform === "darwin" || process.platform === "win32") return;
	try {
		const binDir = path.join(getAgentDir(), "bin");
		const current = process.env.PATH || "";
		const parts = current.split(path.delimiter).filter((p) => Boolean(p) && p !== binDir);
		process.env.PATH = [...parts, binDir].join(path.delimiter);
	} catch {}
}

/** Strip `# ...` comments outside quotes. */
export function stripComments(command: string): string {
	let out = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle && i + 1 < command.length) {
			out += ch + command[++i];
			continue;
		}
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (!inSingle && !inDouble && ch === "#") {
			const prev = i === 0 ? "\n" : command[i - 1];
			if (/\s|[;&|(]/.test(prev)) {
				while (i < command.length && command[i] !== "\n") i++;
				if (i < command.length) out += "\n";
				continue;
			}
		}
		out += ch;
	}
	return out;
}

/** Canonical signature for detecting repeated identical timed-out commands. */
export function normalizeCommandSignature(command: string, cwd: string = process.cwd()): string {
	const clean = stripComments(String(command || ""))
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[;\s]+|[;\s]+$/g, "");
	return `${path.resolve(cwd)}::${clean}`;
}

/** Split command string into segments across `;`, `&&`, `||`, `\n`, and `|`, tracking whether a segment is piped stdin. */
function splitSegments(command: string): Array<{ raw: string; piped: boolean }> {
	const clean = stripComments(command);
	const result: Array<{ raw: string; piped: boolean }> = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let paren = 0;
	let nextPiped = false;

	const flush = (isPipe: boolean) => {
		const trimmed = buf.trim();
		buf = "";
		if (trimmed) result.push({ raw: trimmed, piped: nextPiped });
		nextPiped = isPipe;
	};

	for (let i = 0; i < clean.length; i++) {
		const ch = clean[i];
		const next = clean[i + 1];
		if (ch === "\\" && !inSingle && i + 1 < clean.length) {
			buf += ch + clean[++i];
			continue;
		}
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (!inSingle && !inDouble) {
			if (ch === "(") paren++;
			else if (ch === ")" && paren > 0) paren--;
			else if (paren === 0) {
				if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
					flush(false);
					i++;
					continue;
				}
				if (ch === "|") {
					flush(true);
					if (next === "&") i++;
					continue;
				}
				if (ch === ";" || ch === "\n") {
					flush(false);
					continue;
				}
			}
		}
		buf += ch;
	}
	flush(false);
	return result;
}

/** Tokenize a command segment into unquoted words (dropping redirections like `2>/dev/null`). */
function tokenizeWords(segment: string): string[] {
	const s = segment.replace(/\b\d*[<>]+&?\d*\s*[^\s;&|]*/g, " ").trim();
	const tokens: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "\\" && !inSingle && i + 1 < s.length) {
			cur += s[++i];
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

/** Skip leading env vars (`FOO=1`) and common wrappers (`env`, `sudo`, `time`, `nohup`, `npx`, `uv run`, `timeout`). */
function unwrapTokens(tokens: string[]): { bin: string; args: string[]; viaXargs: boolean } {
	let i = 0;
	let viaXargs = false;
	while (i < tokens.length) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
			i++;
			continue;
		}
		const base = path.basename(tokens[i]);
		if (base === "env" || base === "sudo" || base === "time" || base === "nohup" || base === "command" || base === "nice") {
			i++;
			while (i < tokens.length && (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
				if ((tokens[i] === "-u" || tokens[i] === "-n") && i + 1 < tokens.length) i += 2;
				else i++;
			}
			continue;
		}
		if (base === "timeout" || base === "gtimeout") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) i += 2;
			if (i < tokens.length && /^\d/.test(tokens[i])) i++;
			continue;
		}
		if (base === "xargs" || base === "gxargs") {
			viaXargs = true;
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				if (["-I", "-L", "-n", "-P"].includes(tokens[i])) i += 2;
				else i++;
			}
			continue;
		}
		if (base === "npx" || base === "pnpx" || base === "bunx") {
			i++;
			while (i < tokens.length && tokens[i].startsWith("-")) i++;
			continue;
		}
		if ((base === "uv" || base === "poetry" || base === "pdm") && tokens[i + 1] === "run") {
			i += 2;
			while (i < tokens.length && tokens[i].startsWith("-")) i++;
			continue;
		}
		break;
	}
	if (i >= tokens.length) return { bin: "", args: [], viaXargs };
	return { bin: path.basename(tokens[i]), args: tokens.slice(i + 1), viaXargs };
}

function resolveTarget(rawPath: string, cwd: string, homeDir: string): string {
	const p = (rawPath || ".").trim();
	if (p === "~" || p === "$HOME" || p === "${HOME}") return homeDir;
	if (p.startsWith("~/")) return path.resolve(homeDir, p.slice(2));
	if (p.startsWith("$HOME/")) return path.resolve(homeDir, p.slice(6));
	if (p.startsWith("${HOME}/")) return path.resolve(homeDir, p.slice(8));
	return path.resolve(cwd, p);
}

/** Check whether a search segment is an unbounded / wide search across `/` or `$HOME`. */
function checkSearchSegment(
	bin: string,
	args: string[],
	piped: boolean,
	viaXargs: boolean,
	cwd: string,
	homeDir: string,
): { isSearch: boolean; blocked?: boolean; reason?: string } {
	if (args.some((a) => a === "--version" || a === "-V" || a === "--help" || a === "-h")) {
		return { isSearch: false };
	}

	const isGrep = bin === "grep" || bin === "egrep" || bin === "fgrep";
	const isRecursiveGrep =
		!isGrep ||
		args.some((a) => a === "-r" || a === "-R" || a === "--recursive" || (/^-[a-zA-Z]+$/.test(a) && (a.includes("r") || a.includes("R"))));

	// Extract max-depth if provided
	let maxDepth: number | null = null;
	let unrestrictedCount = 0;
	let hasGlob = false;
	const positional: string[] = [];
	const valueFlags = new Set(["-e", "--regexp", "-f", "--file", "-g", "--glob", "-t", "--type", "-m", "--max-count", "-A", "-B", "-C", "--include", "--exclude", "--exclude-dir", "-name", "-iname", "-path"]);
	let hasExplicitPattern = bin === "find" || args.includes("--files");

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") {
			positional.push(...args.slice(i + 1));
			break;
		}
		if (a === "-d" || a === "--max-depth" || a === "--maxdepth" || a === "-maxdepth") {
			const n = Number.parseInt(args[i + 1], 10);
			if (Number.isFinite(n)) maxDepth = n;
			i++;
			continue;
		}
		if (a.startsWith("--max-depth=") || a.startsWith("--maxdepth=") || a.startsWith("-maxdepth=")) {
			const n = Number.parseInt(a.split("=")[1], 10);
			if (Number.isFinite(n)) maxDepth = n;
			continue;
		}
		if (a === "-e" || a === "--regexp" || a === "-f" || a === "--file") {
			hasExplicitPattern = true;
			i++;
			continue;
		}
		if (a === "-g" || a === "--glob" || a === "-t" || a === "--type" || a === "--include" || a.startsWith("--glob=") || a.startsWith("--include=")) {
			hasGlob = true;
			if (!a.includes("=")) i++;
			continue;
		}
		if (a === "--no-ignore" || a === "--unrestricted") unrestrictedCount++;
		if (/^-u+$/.test(a)) unrestrictedCount += a.length - 1;
		if (valueFlags.has(a)) {
			i++;
			continue;
		}
		if (a.startsWith("-") || a === "(" || a === ")" || a === "!") continue;
		positional.push(a);
	}

	const paths = bin === "find" ? (positional.length > 0 ? [positional[0]] : ["."]) : hasExplicitPattern ? positional : positional.slice(1);

	// Piped grep/rg with no file path and not recursive is a stdin filter (e.g. `git log | grep fix`)
	if (piped && !viaXargs && paths.length === 0 && (!isGrep || !isRecursiveGrep)) {
		return { isSearch: false };
	}

	const effectivePaths = paths.length > 0 ? paths : ["."];
	for (const rawTarget of effectivePaths) {
		const resolved = resolveTarget(rawTarget, cwd, homeDir);

		// Allow reading a single safe /proc file with non-recursive grep (e.g. /proc/meminfo)
		if (isGrep && !isRecursiveGrep && (resolved === "/proc/meminfo" || resolved === "/proc/cpuinfo" || resolved === "/proc/version")) {
			continue;
		}

		if (WIDE_ROOT_PATHS.has(resolved) || resolved.startsWith("/proc/") || resolved.startsWith("/sys/") || resolved.startsWith("/dev/")) {
			if (resolved === "/" || maxDepth === null || maxDepth > 2) {
				return {
					isSearch: true,
					blocked: true,
					reason: `[Command Safety Guard] Dangerous wide search blocked: '${bin}' targets system/root path '${resolved}'. Scope the search to a project directory or add '--max-depth 2' / '-maxdepth 2'.`,
				};
			}
		}

		if (resolved === homeDir && isRecursiveGrep) {
			const maxHomeDepth = bin === "find" ? 4 : 3;
			if (isGrep || maxDepth === null || maxDepth > maxHomeDepth) {
				return {
					isSearch: true,
					blocked: true,
					reason: `[Command Safety Guard] Dangerous wide search blocked: unbounded '${bin}' across home directory ('${resolved}'). Specify a project directory (e.g. '~/pi-config') or add '${bin === "find" ? "-maxdepth 3" : "--max-depth 3"}'.`,
				};
			}
		}

		if (unrestrictedCount >= 2 && (maxDepth === null || maxDepth > 3) && !hasGlob) {
			return {
				isSearch: true,
				blocked: true,
				reason: `[Command Safety Guard] Dangerous wide search blocked: '${bin}' uses unrestricted flags (-uu/-uuu) without '--max-depth 3' or '-g' glob filter.`,
			};
		}

		if (isGrep && isRecursiveGrep && (rawTarget === ".." || rawTarget.startsWith("../")) && !hasGlob) {
			return {
				isSearch: true,
				blocked: true,
				reason: `[Command Safety Guard] Dangerous wide search blocked: unfiltered recursive '${bin}' on '${rawTarget}'. Target a specific directory or use 'rg'.`,
			};
		}
	}

	return { isSearch: true };
}

function isDeployAuthorized(options: { deployAuthorized?: boolean; userPromptText?: string } = {}): boolean {
	if (typeof options.deployAuthorized === "boolean") return options.deployAuthorized;
	if (process.env.PI_GUARD_AUTHORIZE_DEPLOY === "1" || process.env.PI_ALLOW_PRODUCTION_DEPLOY === "1") return true;
	if (process.env.PI_GUARD_AUTHORIZE_DEPLOY === "0" || process.env.PI_ALLOW_PRODUCTION_DEPLOY === "0") return false;
	const prompt = options.userPromptText || "";
	if (prompt) {
		if (/\b(?:do\s+not|don't|never|must\s+not|not\s+authorization\s+to|without)\b[^.!?\n]{0,80}\b(?:deploy|deployments?|production)\b/i.test(prompt)) {
			return false;
		}
		if (/\b(?:please\s+deploy|deploy\s+(?:to|the|this|now|production|worker|app|service|changes)|authorize\s+deploy(?:ment)?)\b/i.test(prompt)) {
			return true;
		}
	}
	return false;
}

/** Classify a Bash command into one of the timeout policy tiers and check safety rules. */
export function classifyBashCommand(
	command: string,
	options: {
		cwd?: string;
		homeDir?: string;
		requestedTimeout?: number;
		deployAuthorized?: boolean;
		userPromptText?: string;
	} = {},
): ClassificationResult {
	const cwd = path.resolve(options.cwd || process.cwd());
	const homeDir = path.resolve(options.homeDir || os.homedir());
	const requested =
		typeof options.requestedTimeout === "number" && Number.isFinite(options.requestedTimeout) && options.requestedTimeout > 0
			? options.requestedTimeout
			: undefined;

	const segments = splitSegments(String(command || ""));
	let hasSearch = false;
	let hasDeploy = false;
	let deployDryRunOnly = true;
	let deployLabel = "";
	let hasTestBuildPython = false;
	let hasGit = false;
	let hasLongSleep = false;

	for (const seg of segments) {
		const tokens = tokenizeWords(seg.raw);
		if (tokens.length === 0) continue;
		const { bin, args, viaXargs } = unwrapTokens(tokens);
		if (!bin) continue;

		// Check standalone sleep > 30s (prevents `pytest && sleep 200` privilege escalation)
		if (bin === "sleep" && Number.parseFloat(args[0] || "0") > 30) {
			hasLongSleep = true;
			continue;
		}

		// 1. Search commands
		if (SEARCH_BINS.has(bin) || (bin === "git" && args[0] === "grep")) {
			const searchRes =
				bin === "git"
					? { isSearch: true, blocked: false }
					: checkSearchSegment(bin, args, seg.piped, viaXargs, cwd, homeDir);
			if (searchRes.blocked) {
				return {
					blocked: true,
					blockCode: "dangerous_wide_search",
					category: "search",
					policyTimeoutSeconds: TIMEOUT_POLICY_SECONDS.search,
					effectiveTimeoutSeconds: TIMEOUT_POLICY_SECONDS.search,
					requestedTimeoutSeconds: requested,
					clamped: false,
					reason: searchRes.reason,
				};
			}
			if (searchRes.isSearch) {
				hasSearch = true;
			}
			continue;
		}

		// Ignore trivial --version / --help checks so they cannot escalate compound commands
		if (args.some((a) => a === "--version" || a === "-V" || a === "--help" || a === "-h")) {
			continue;
		}

		const nonFlags = args.filter((a) => !a.startsWith("-"));
		const sub1 = nonFlags[0] || "";
		const sub2 = nonFlags[1] || "";
		const isDryRun = args.includes("--dry-run") || args.includes("--dryrun");

		// 2. Production deployment commands
		const isDeployCmd =
			((bin === "wrangler" || bin === "cf") &&
				(sub1 === "deploy" || sub1 === "publish" || (sub1 === "pages" && sub2 === "deploy") || (sub1 === "versions" && (sub2 === "upload" || sub2 === "deploy")))) ||
			(bin === "vercel" && (sub1 === "deploy" || args.includes("--prod") || args.includes("--production"))) ||
			((bin === "netlify" || bin === "fly" || bin === "flyctl" || bin === "render" || bin === "cdk" || bin === "sam" || bin === "serverless" || bin === "sls" || bin === "sst") &&
				sub1 === "deploy") ||
			(bin === "railway" && (sub1 === "up" || sub1 === "deploy")) ||
			((bin === "gcloud" || bin === "aws") && (sub2 === "deploy" || nonFlags[2] === "deploy")) ||
			(bin === "terraform" && sub1 === "apply") ||
			(bin === "pulumi" && sub1 === "up") ||
			(bin === "helm" && (sub1 === "upgrade" || sub1 === "install")) ||
			(bin === "kubectl" && (sub1 === "apply" || sub1 === "rollout")) ||
			((bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") &&
				((sub1 === "run" ? sub2 : sub1) === "deploy" || /^deploy[:_-]/i.test(sub1 === "run" ? sub2 : sub1))) ||
			(bin === "make" && sub1 === "deploy") ||
			/^deploy(?:\.[a-z0-9]+|-[a-z0-9._-]+)?$/i.test(bin) ||
			((bin === "bash" || bin === "sh") && /(?:^|\/)deploy[-_a-z0-9]*\.sh$/i.test(sub1));

		if (isDeployCmd) {
			hasDeploy = true;
			if (!isDryRun) deployDryRunOnly = false;
			deployLabel = deployLabel || `${bin} ${sub1}`.trim();
			continue;
		}

		// 3. Git / GitHub CLI commands
		if (GIT_BINS.has(bin)) {
			hasGit = true;
			continue;
		}

		// 4. Tests, builds, and Python scripts
		if (PYTHON_BINS.has(bin) || /^python3\.\d+$/.test(bin)) {
			const cIdx = args.indexOf("-c");
			const code = cIdx !== -1 ? (args[cIdx + 1] || "").trim() : "script";
			if (code && code !== "pass" && !/^print\s*\([^)]*\)$/.test(code)) {
				hasTestBuildPython = true;
			}
			continue;
		}

		if (
			TEST_BUILD_BINS.has(bin) ||
			(bin === "node" && args.some((a) => a === "--test" || a.startsWith("--test-"))) ||
			((bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun" || bin === "deno") &&
				/^(?:test|t|tst|build|install|i|ci|typecheck|check|lint|compile|verify)(?:[:_-]|$)/i.test(sub1 === "run" ? sub2 : sub1)) ||
			(bin === "cargo" && ["test", "build", "b", "check", "c", "clippy", "bench", "nextest"].includes(sub1)) ||
			(bin === "go" && ["test", "build", "vet", "install"].includes(sub1)) ||
			((bin === "uv" || bin === "poetry" || bin === "pdm" || bin === "pip" || bin === "pip3") &&
				["run", "pip", "sync", "build", "install", "wheel", "test"].includes(sub1)) ||
			((bin === "docker" || bin === "podman") && (sub1 === "build" || (sub1 === "compose" && sub2 === "build"))) ||
			((bin === "wrangler" || bin === "cf") && (sub1 === "build" || sub1 === "types"))
		) {
			hasTestBuildPython = true;
		}
	}

	const applyCeiling = (category: CommandCategory): ClassificationResult => {
		const policy = TIMEOUT_POLICY_SECONDS[category];
		const effective = requested !== undefined ? Math.min(requested, policy) : policy;
		return {
			blocked: false,
			category,
			policyTimeoutSeconds: policy,
			effectiveTimeoutSeconds: effective,
			requestedTimeoutSeconds: requested,
			clamped: requested !== undefined && requested > policy,
		};
	};

	// Searches always cap at 30s (cannot be escalated by prefixing another command)
	if (hasSearch) return applyCeiling("search");

	if (hasDeploy && !hasLongSleep) {
		const authorized = isDeployAuthorized(options);
		if (!authorized && !deployDryRunOnly) {
			return {
				blocked: true,
				blockCode: "unauthorized_deploy",
				category: "authorized_deploy",
				policyTimeoutSeconds: TIMEOUT_POLICY_SECONDS.authorized_deploy,
				effectiveTimeoutSeconds: 0,
				requestedTimeoutSeconds: requested,
				clamped: false,
				reason: `[Command Safety Guard] Production deployment command ('${deployLabel}') blocked: deployment is not authorized in this session ("An instruction to investigate is not authorization to deploy"). Authorize explicitly via user prompt, '/guard authorize-deploy', or '--dry-run'.`,
			};
		}
		if (authorized) return applyCeiling("authorized_deploy");
		return applyCeiling("test_build_python");
	}

	if (hasTestBuildPython && !hasLongSleep) return applyCeiling("test_build_python");
	if (hasGit && !hasLongSleep) return applyCeiling("git");
	return applyCeiling("ordinary");
}

function getLatestUserPrompt(ctx?: ExtensionContext): string {
	try {
		const branch = ctx?.sessionManager?.getBranch?.() ?? [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as any;
			if (entry?.type === "message" && entry.message?.role === "user") {
				const raw = entry.message.content;
				if (typeof raw === "string" && raw.trim()) return raw.trim();
				if (Array.isArray(raw)) {
					const text = raw
						.filter((p: any) => p?.type === "text" && typeof p.text === "string")
						.map((p: any) => p.text)
						.join(" ")
						.trim();
					if (text) return text;
				}
			}
		}
	} catch {}
	return guardState.latestUserPrompt;
}

export default function commandSafetyGuardExtension(pi: ExtensionAPI): void {
	ensurePlatformPathOrder();

	pi.on("session_start", (_event, ctx) => {
		ensurePlatformPathOrder();
		guardState.latestUserPrompt = getLatestUserPrompt(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if ((event as any).messageType === "user" && typeof (event as any).prompt === "string") {
			guardState.latestUserPrompt = (event as any).prompt;
		} else {
			guardState.latestUserPrompt = getLatestUserPrompt(ctx);
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (!guardState.enabled) return undefined;
		const cwd = ctx?.cwd || process.cwd();
		const homeDir = os.homedir();

		// Guard built-in grep / find tools against root / unbounded home scans
		if (event.toolName === "grep" || event.toolName === "find") {
			const rawPath = typeof (event.input as any)?.path === "string" ? (event.input as any).path : ".";
			const resolved = resolveTarget(rawPath, cwd, homeDir);
			if (WIDE_ROOT_PATHS.has(resolved) || resolved === homeDir) {
				return {
					block: true,
					reason: `[Command Safety Guard] Wide '${event.toolName}' scan on '${resolved}' blocked. Pass a specific project directory in 'path'.`,
				};
			}
			return undefined;
		}

		if (event.toolName !== "bash" || !event.input || typeof event.input.command !== "string") {
			return undefined;
		}

		const command = event.input.command;
		const sig = normalizeCommandSignature(command, cwd);
		const priorTimeout = guardState.timedOutCommands.get(sig);
		if (priorTimeout) {
			priorTimeout.attempts += 1;
			return {
				block: true,
				reason: `[Command Safety Guard] Blocked repeated identical timed-out command (attempt #${priorTimeout.attempts}; previously timed out after ${priorTimeout.timeoutSeconds}s in '${priorTimeout.category}'). Narrow the search path, filter targets, or use 'bg_run' for long-running tasks instead of retrying the identical command.`,
			};
		}

		const verdict = classifyBashCommand(command, {
			cwd,
			homeDir,
			requestedTimeout: typeof event.input.timeout === "number" ? event.input.timeout : undefined,
			deployAuthorized: guardState.deployAuthorized ? true : undefined,
			userPromptText: getLatestUserPrompt(ctx),
		});

		if (verdict.blocked) {
			return { block: true, reason: verdict.reason };
		}

		// Enforce timeout ceiling at the harness level regardless of model request
		event.input.timeout = verdict.effectiveTimeoutSeconds;
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!guardState.enabled || event.toolName !== "bash" || !event.isError) return undefined;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!command) return undefined;

		const textBlock = event.content?.find((c): c is { type: "text"; text: string } => c.type === "text");
		const text = textBlock?.text || "";
		const match = text.match(/Command timed out after (\d+(?:\.\d+)?) seconds/);
		if (!match) return undefined;

		const cwd = ctx?.cwd || process.cwd();
		const sig = normalizeCommandSignature(command, cwd);
		const timeoutSeconds = Number(match[1]);
		const verdict = classifyBashCommand(command, { cwd });

		guardState.timedOutCommands.set(sig, {
			command,
			cwd,
			category: verdict.category,
			timeoutSeconds,
			attempts: 1,
		});

		const hint = `\n[Command Safety Guard: category=${verdict.category} (limit ${verdict.policyTimeoutSeconds}s). Process group terminated. Do not retry this identical command; narrow the scope or use bg_run for background tasks.]`;
		if (text.includes("[Command Safety Guard:")) return undefined;

		return {
			content: event.content.map((c) => (c === textBlock ? { type: "text" as const, text: text + hint } : c)),
			structuredContent: event.structuredContent,
		};
	});

	const handleGuardCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const sub = (args || "").trim().toLowerCase();
		if (sub === "on" || sub === "enable") {
			guardState.enabled = true;
			ctx.ui?.notify?.("Command Safety Guard enabled.", "info");
		} else if (sub === "off" || sub === "disable") {
			guardState.enabled = false;
			ctx.ui?.notify?.("Command Safety Guard disabled for this session.", "warning");
		} else if (sub === "authorize-deploy" || sub === "deploy on") {
			guardState.deployAuthorized = true;
			ctx.ui?.notify?.("Production deployment authorized (30m timeout tier enabled).", "info");
		} else if (sub === "revoke-deploy" || sub === "deploy off") {
			guardState.deployAuthorized = false;
			ctx.ui?.notify?.("Production deployment authorization revoked.", "info");
		} else if (sub === "reset" || sub === "clear") {
			guardState.timedOutCommands.clear();
			ctx.ui?.notify?.("Cleared timed-out command blocklist.", "info");
		} else {
			ctx.ui?.notify?.(
				`Command Safety Guard: ${guardState.enabled ? "ON" : "OFF"} | Deploy(30m): ${guardState.deployAuthorized ? "AUTHORIZED" : "LOCKED"} | Blocked retries: ${guardState.timedOutCommands.size}\n` +
					`Tiers: search=${TIMEOUT_POLICY_SECONDS.search}s, bash=${TIMEOUT_POLICY_SECONDS.ordinary}s, git=${TIMEOUT_POLICY_SECONDS.git}s, test/python=${TIMEOUT_POLICY_SECONDS.test_build_python}s, deploy=${TIMEOUT_POLICY_SECONDS.authorized_deploy}s`,
				"info",
			);
		}
	};

	pi.registerCommand("guard", {
		description: "Configure Command Execution Safety Guard (/guard status|on|off|authorize-deploy|revoke-deploy|reset)",
		handler: handleGuardCommand,
	});
}
