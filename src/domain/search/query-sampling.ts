import type { AISearchResult } from "@domain/catalog/translator";
import { getHttpClient } from "@data/net/http-port";
import {
	SEARCH_INTENT_PROFILES,
	parseQueryIntent,
	type SearchMatchDiagnostics,
} from "@domain/search/query-intent";

/** P1.1 采样设置。默认值由设置层提供；这里再次校验，避免误发。 */
export interface QuerySamplingSettings {
	enabled: boolean;
	endpoint: string;
	sampleRate: number;
}

export interface QuerySamplingInput {
	query: string;
	mode: "ai" | "local";
	result: AISearchResult;
	clientVersion?: string;
	now?: number;
}

export interface QueryShapeFeatures {
	lengthBucket: "empty" | "1-4" | "5-8" | "9-16" | "17+";
	charClasses: Array<"cjk" | "latin" | "digit" | "space" | "punctuation" | "other">;
	tokenCount: number;
	positiveTermCount: number;
	negativeTermCount: number;
	unknownPositiveTermCount: number;
	unknownNegativeTermCount: number;
	quotedPhraseCount: number;
	activeIntentKeys: string[];
	negativeIntentKeys: string[];
	isPureNegative: boolean;
}

export interface QuerySamplingRankMetric {
	rank: number;
	keywordHit: boolean;
	vectorHit: boolean;
	titleHit: boolean;
	rrfScore: number;
	rerankScore: number;
	matchedTermCount: number;
	phraseMatchCount: number;
	intentMatchCount: number;
	negativeMatchCount: number;
}

export interface QuerySamplingEvent {
	schemaVersion: 1;
	type: "query-sample";
	day: string;
	clientVersion?: string;
	mode: "ai" | "local";
	query: QueryShapeFeatures;
	ranking: {
		candidateCount: number;
		resultCount: number;
		rankFallback: boolean;
		top: QuerySamplingRankMetric[];
		negativeHitCountTop10: number;
		intentHitCountTop10: number;
	};
}

export type QuerySamplingTransport = (endpoint: string, payload: QuerySamplingEvent) => Promise<void>;

export interface QuerySamplingReport {
	sent: boolean;
	reason?: "disabled" | "missing-endpoint" | "invalid-endpoint" | "not-sampled" | "transport-error";
}

const MAX_TOP_METRICS = 10;

function normalized(value: string): string {
	return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
}

function lengthBucket(value: string): QueryShapeFeatures["lengthBucket"] {
	const length = Array.from(value).length;
	if (length === 0) return "empty";
	if (length <= 4) return "1-4";
	if (length <= 8) return "5-8";
	if (length <= 16) return "9-16";
	return "17+";
}

function charClasses(value: string): QueryShapeFeatures["charClasses"] {
	const classes = new Set<QueryShapeFeatures["charClasses"][number]>();
	for (const char of value) {
		if (/\p{Script=Han}/u.test(char)) classes.add("cjk");
		else if (/[a-z]/i.test(char)) classes.add("latin");
		else if (/\d/.test(char)) classes.add("digit");
		else if (/\s/u.test(char)) classes.add("space");
		else if (/\p{P}/u.test(char)) classes.add("punctuation");
		else classes.add("other");
	}
	return [...classes].sort();
}

function profileMatchesTerm(term: string, profileTerms: string[]): boolean {
	const value = normalized(term);
	return value.length > 0 && profileTerms.some((candidate) => {
		const known = normalized(candidate);
		return value === known || value.includes(known) || known.includes(value);
	});
}

function intentKeysForTerms(terms: string[]): string[] {
	return SEARCH_INTENT_PROFILES
		.filter((profile) => terms.some((term) => profileMatchesTerm(term, [...profile.queryTerms, ...profile.candidateTerms])))
		.map((profile) => profile.key)
	.sort();
}

/**
 * 生成不含原文的查询特征。未知词只贡献计数，接收端无法据此还原用户输入。
 */
export function buildQueryShapeFeatures(query: string): QueryShapeFeatures {
	const parsed = parseQueryIntent(query);
	const knownTerms = SEARCH_INTENT_PROFILES.flatMap((profile) => [
		...profile.queryTerms,
		...profile.candidateTerms,
	]);
	const isKnown = (term: string) => profileMatchesTerm(term, knownTerms);
	const positiveTerms = parsed.positiveTerms;
	const negativeTerms = parsed.negativeTerms;
	return {
		lengthBucket: lengthBucket(normalized(query)),
		charClasses: charClasses(normalized(query)),
		tokenCount: positiveTerms.length + negativeTerms.length,
		positiveTermCount: positiveTerms.length,
		negativeTermCount: negativeTerms.length,
		unknownPositiveTermCount: positiveTerms.filter((term) => !isKnown(term)).length,
		unknownNegativeTermCount: negativeTerms.filter((term) => !isKnown(term)).length,
		quotedPhraseCount: parsed.phrases.length,
		activeIntentKeys: parsed.activeProfiles.map((profile) => profile.key).sort(),
		negativeIntentKeys: intentKeysForTerms(negativeTerms),
		isPureNegative: parsed.isPureNegative,
	};
}

function roundScore(value: number): number {
	return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
}

function buildRankMetrics(diagnostics: Record<string, SearchMatchDiagnostics>, rankedIds: string[]): QuerySamplingRankMetric[] {
	return rankedIds.slice(0, MAX_TOP_METRICS).map((id, index) => {
		const diagnostic = diagnostics[id];
		return {
			rank: index + 1,
			keywordHit: diagnostic?.keywordRank != null,
			vectorHit: diagnostic?.vectorRank != null,
			titleHit: diagnostic?.titleRank != null,
			rrfScore: roundScore(diagnostic?.rrfScore ?? 0),
			rerankScore: roundScore(diagnostic?.rerankScore ?? 0),
			matchedTermCount: diagnostic?.matchedTerms.length ?? 0,
			phraseMatchCount: diagnostic?.phraseMatches.length ?? 0,
			intentMatchCount: diagnostic?.intentMatches.length ?? 0,
			negativeMatchCount: diagnostic?.negativeMatches.length ?? 0,
		};
	});
}

/** 创建网络载荷；这里明确不接收 allPlugins，因此不会意外带出插件全文。 */
export function buildQuerySamplingEvent(input: QuerySamplingInput): QuerySamplingEvent {
	const diagnostics = input.result.matchDiagnostics ?? {};
	const top = buildRankMetrics(diagnostics, input.result.rankedIds);
	return {
		schemaVersion: 1,
		type: "query-sample",
		day: new Date(input.now ?? Date.now()).toISOString().slice(0, 10),
		...(input.clientVersion ? { clientVersion: input.clientVersion } : {}),
		mode: input.mode,
		query: buildQueryShapeFeatures(input.query),
		ranking: {
			candidateCount: Object.keys(diagnostics).length,
			resultCount: input.result.rankedIds.length,
			rankFallback: input.result.rankFallback === true,
			top,
			negativeHitCountTop10: top.filter((metric) => metric.negativeMatchCount > 0).length,
			intentHitCountTop10: top.filter((metric) => metric.intentMatchCount > 0).length,
		},
	};
}

function validateEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		if (url.username || url.password || url.search || url.hash) return false;
		if (url.protocol === "https:") return true;
		return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
	} catch {
		return false;
	}
}

const defaultTransport: QuerySamplingTransport = async (endpoint, payload) => {
		const response = await getHttpClient().request({
			url: endpoint,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`query sampling endpoint returned HTTP ${response.status}`);
		}
};

/**
 * 发送一次采样。网络错误和服务端错误都被吸收，绝不影响用户搜索结果。
 */
export async function reportQuerySample(
	settings: QuerySamplingSettings,
	input: QuerySamplingInput,
	transport: QuerySamplingTransport = defaultTransport,
	random: () => number = Math.random,
): Promise<QuerySamplingReport> {
	if (!settings.enabled) return { sent: false, reason: "disabled" };
	const endpoint = settings.endpoint.trim();
	if (!endpoint) return { sent: false, reason: "missing-endpoint" };
	if (!validateEndpoint(endpoint)) return { sent: false, reason: "invalid-endpoint" };
	const rate = Number.isFinite(settings.sampleRate) ? Math.min(1, Math.max(0, settings.sampleRate)) : 0;
	if (rate <= 0 || random() >= rate) return { sent: false, reason: "not-sampled" };
	try {
		await transport(endpoint, buildQuerySamplingEvent(input));
		return { sent: true };
	} catch {
		return { sent: false, reason: "transport-error" };
	}
}
