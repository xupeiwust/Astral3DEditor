#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const https = require("node:https");

const COMMENT_MARKER = "<!-- astral-issue-gatekeeper -->";
const API_USER_AGENT = "astral-issue-gatekeeper";
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ISSUE_LABELS = {
	bug: "bug",
	feature: "enhancement",
	invalid: "invalid",
	abuse: "invalid",
};
const OPTIONAL_ABUSE_LABEL = "abuse";

const DEFAULT_PLACEHOLDER_PATTERNS = [
	"a clear and concise",
	"code goes here",
	"ex. i'm always frustrated",
	"jsfiddle-latest-release webglrenderer",
	"jsfiddle-dev webglrenderer",
	"jsfiddle-latest-release webgpurenderer",
	"jsfiddle-dev webgpurenderer",
	"no response",
	"_no response_",
	"请在这里填写",
	"请描述",
	"请补充",
	"暂无",
];

/**
 * @typedef {"bug" | "feature" | "invalid" | "abuse"} IssueKind
 */

/**
 * @typedef {object} IssueCheckResult
 * @property {IssueKind} kind Issue 类型。
 * @property {boolean} isQualified Issue 内容是否通过自动检查。
 * @property {boolean} isTrustedAuthor 提交者是否为可信维护者。
 * @property {boolean} isAbuse Issue 是否命中高置信违规骚扰规则。
 * @property {boolean} shouldClose 是否应该由工作流自动关闭。
 * @property {boolean} shouldLock 是否应该由工作流自动锁定。
 * @property {string[]} labels 需要补充的标签。
 * @property {string[]} reasons 未通过原因。
 */

/**
 * 读取 GitHub Actions 事件正文。
 * @returns {object} GitHub webhook 事件。
 */
function readEventPayload() {
	const inlinePayload = process.env.ISSUE_GATEKEEPER_EVENT_JSON;

	if (inlinePayload) {
		return JSON.parse(inlinePayload);
	}

	const eventPath = process.env.GITHUB_EVENT_PATH;

	if (!eventPath) {
		throw new Error("[issue-gatekeeper] 缺少 GITHUB_EVENT_PATH，无法读取 Issue 事件。");
	}

	return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

/**
 * 归一化 Markdown 文本，避免换行和 HTML 注释影响判定。
 * @param {unknown} value 原始文本。
 * @returns {string} 归一化后的文本。
 */
function normalizeContent(value) {
	return String(value ?? "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\r\n?/g, "\n")
		.trim();
}

/**
 * 归一化表单标题，兼容中英文 Issue Form 字段。
 * @param {string} label 原始标题。
 * @returns {string} 用于查找的标题键。
 */
function normalizeLabel(label) {
	return normalizeContent(label)
		.replace(/<[^>]+>/g, "")
		.replace(/[：:]\s*$/u, "")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

/**
 * 从 Issue Form 生成的 Markdown 正文中提取各字段。
 * @param {string} body Issue 正文。
 * @returns {Map<string, string>} 字段标题到字段内容的映射。
 */
function parseSections(body) {
	const normalizedBody = normalizeContent(body);
	const sections = new Map();
	const headingPattern = /^(#{2,4})\s+(.+?)\s*$/gmu;
	let previousLabel = "";
	let previousContentStart = 0;
	let match;

	while ((match = headingPattern.exec(normalizedBody)) !== null) {
		if (previousLabel) {
			appendSection(sections, previousLabel, normalizedBody.slice(previousContentStart, match.index));
		}

		previousLabel = normalizeLabel(match[2]);
		previousContentStart = headingPattern.lastIndex;
	}

	if (previousLabel) {
		appendSection(sections, previousLabel, normalizedBody.slice(previousContentStart));
	}

	return sections;
}

/**
 * 追加字段内容，重复标题会合并，避免表单编辑造成信息丢失。
 * @param {Map<string, string>} sections 字段映射。
 * @param {string} label 字段标题。
 * @param {string} content 字段内容。
 * @returns {void}
 */
function appendSection(sections, label, content) {
	const normalizedContent = normalizeContent(content);
	const existingContent = sections.get(label);

	if (existingContent) {
		sections.set(label, `${existingContent}\n${normalizedContent}`.trim());
		return;
	}

	sections.set(label, normalizedContent);
}

/**
 * 按候选标题读取字段内容。
 * @param {Map<string, string>} sections 字段映射。
 * @param {string[]} labels 候选标题。
 * @returns {string} 匹配到的字段内容。
 */
function getSection(sections, labels) {
	for (const label of labels) {
		const value = sections.get(normalizeLabel(label));

		if (value !== undefined) {
			return value;
		}
	}

	return "";
}

/**
 * 去除 Markdown 结构噪声，只保留能代表用户输入的信息。
 * @param {string} value 原始字段内容。
 * @returns {string} 去噪后的内容。
 */
function stripMarkdownNoise(value) {
	return normalizeContent(value)
		.replace(/```[\s\S]*?```/g, (codeBlock) => codeBlock.replace(/```[\w-]*|```/g, ""))
		.replace(/^\s*(?:[-*]|\d+[.)])\s*/gmu, "")
		.replace(/\[[ xX]\]/g, "")
		.trim();
}

/**
 * 判断字段是否仍是模板占位内容。
 * @param {string} value 字段内容。
 * @returns {boolean} 是否为占位或空内容。
 */
function isPlaceholderContent(value) {
	const normalizedValue = stripMarkdownNoise(value).toLowerCase();
	const compactValue = normalizedValue.replace(/[\s`'"，。！？、,.!?;:：；()[\]{}<>-]+/gu, "");

	if (!compactValue || ["123", "na", "none", "null", "无"].includes(compactValue)) {
		return true;
	}

	return DEFAULT_PLACEHOLDER_PATTERNS.some((pattern) => normalizedValue.includes(pattern));
}

/**
 * 判断普通文本字段是否包含足够有效信息。
 * @param {string} value 字段内容。
 * @param {number} minLength 最小有效字符数。
 * @returns {boolean} 是否有效。
 */
function hasMeaningfulText(value, minLength) {
	if (isPlaceholderContent(value)) {
		return false;
	}

	const meaningfulChars = stripMarkdownNoise(value).replace(/[^\p{L}\p{N}]+/gu, "");
	return meaningfulChars.length >= minLength;
}

/**
 * 判断代码字段是否包含真实复现代码。
 * @param {string} value 字段内容。
 * @returns {boolean} 是否有有效代码。
 */
function hasMeaningfulCode(value) {
	if (isPlaceholderContent(value)) {
		return false;
	}

	const codeText = stripMarkdownNoise(value).replace(/\s+/g, "");
	return codeText.length >= 12;
}

/**
 * 判断字段是否包含用户提供的有效链接。
 * @param {string} value 字段内容。
 * @returns {boolean} 是否有有效链接。
 */
function hasUsableUrl(value) {
	if (isPlaceholderContent(value)) {
		return false;
	}

	return /https?:\/\/[^\s)]+/iu.test(value);
}

/**
 * 判断截图字段是否包含图片或附件。
 * @param {string} value 字段内容。
 * @returns {boolean} 是否有可用截图。
 */
function hasUsableScreenshot(value) {
	if (isPlaceholderContent(value)) {
		return false;
	}

	return /!\[[^\]]*\]\(https?:\/\/[^)]+\)/iu.test(value) || /user-attachments\/assets/iu.test(value);
}

/**
 * 判断复现步骤是否足够明确。
 * @param {string} value 字段内容。
 * @returns {boolean} 是否有至少两步有效操作。
 */
function hasEnoughReproductionSteps(value) {
	if (isPlaceholderContent(value)) {
		return false;
	}

	const meaningfulLines = stripMarkdownNoise(value)
		.split("\n")
		.map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "").trim())
		.filter((line) => line && hasMeaningfulText(line, 3));

	return meaningfulLines.length >= 2 || hasMeaningfulText(value, 24);
}

/**
 * 判断标题是否补充了有效描述。
 * @param {string} title Issue 标题。
 * @returns {boolean} 标题是否有效。
 */
function hasMeaningfulTitle(title) {
	const normalizedTitle = normalizeContent(title)
		.replace(/^\[(?:bug|feature|缺陷|功能|需求)\]\s*[:：-]?\s*/iu, "")
		.replace(/^(?:bug|feature|缺陷|功能|需求)\s*[:：-]\s*/iu, "");

	return hasMeaningfulText(normalizedTitle, 6);
}

/**
 * 统计正文中的链接数量，用于识别广告型内容。
 * @param {string} body Issue 正文。
 * @returns {number} 链接数量。
 */
function countUrls(body) {
	return (normalizeContent(body).match(/https?:\/\/[^\s)]+/giu) ?? []).length;
}

/**
 * 判断文本是否命中“举报/违规/刷量威胁”高置信组合。
 * 这里不按单个敏感词拦截，必须同时出现增长数据话题与平台处罚语义，降低误伤正常反馈的概率。
 * @param {object} issue Issue 对象。
 * @returns {string[]} 命中的违规骚扰原因。
 */
function detectAbuseReasons(issue) {
	const issueText = stripMarkdownNoise(`${issue.title ?? ""}\n${issue.body ?? ""}`);
	const hasGrowthTopic = /(?:star|stargazer|follower|刷星|刷量|刷赞|虚假(?:的)?数字|虚假人气|第三方推广|推广活动|账号的 follower)/iu.test(issueText);
	const hasPlatformThreat = /(?:已举报(?:平台|github)|举报平台|github\s*(?:将|会|应该).{0,30}(?:清理|处理|关闭|封禁)|(?:违规|举报).{0,40}(?:关闭项目|清理违规人气|封禁|处罚)|(?:关闭项目|清理违规人气).{0,40}(?:违规|举报))/iu.test(issueText);
	const hasCompetitiveAuditShape = /(?:竞品分析|公开透明).{0,80}(?:star|follower|stargazer)/iu.test(issueText);

	if (hasGrowthTopic && hasPlatformThreat) {
		return ["Issue 命中高置信违规骚扰规则：同时包含增长数据话题与平台举报/处罚威胁。"];
	}

	if (hasCompetitiveAuditShape && /(?:违规|举报|关闭项目|清理违规人气)/iu.test(issueText)) {
		return ["Issue 命中高置信违规骚扰规则：疑似借竞品分析名义提交举报威胁内容。"];
	}

	return [];
}

/**
 * 根据标题、标签和字段判断 Issue 类型。
 * @param {object} issue Issue 对象。
 * @param {Map<string, string>} sections 字段映射。
 * @returns {IssueKind} Issue 类型。
 */
function detectIssueKind(issue, sections) {
	const labels = (issue.labels ?? []).map((label) => String(label.name ?? label).toLowerCase());
	const title = normalizeContent(issue.title).toLowerCase();

	if (labels.includes("bug") || /\bbug\b|缺陷|错误|故障|异常/iu.test(title)) {
		return "bug";
	}

	if (labels.includes("enhancement") || labels.includes("feature") || /feature|enhancement|功能|需求|建议/iu.test(title)) {
		return "feature";
	}

	if (getSection(sections, ["复现步骤", "Reproduction steps"]) || getSection(sections, ["版本", "Version"])) {
		return "bug";
	}

	if (getSection(sections, ["期望方案", "Solution"]) || getSection(sections, ["替代方案", "Alternatives"])) {
		return "feature";
	}

	return "invalid";
}

/**
 * 校验缺陷反馈表单。
 * @param {object} issue Issue 对象。
 * @param {Map<string, string>} sections 字段映射。
 * @returns {string[]} 未通过原因。
 */
function validateBugIssue(issue, sections) {
	const reasons = [];
	const description = getSection(sections, ["问题描述", "Description"]);
	const reproductionSteps = getSection(sections, ["复现步骤", "Reproduction steps"]);
	const expectedResult = getSection(sections, ["期望结果", "Expected behavior", "Expected result"]);
	const actualResult = getSection(sections, ["实际结果", "Actual behavior", "Actual result", "运行结果"]);
	const code = getSection(sections, ["最小复现代码", "Code"]);
	const liveExample = getSection(sections, ["最小复现链接", "Live example"]);
	const screenshots = getSection(sections, ["截图或录屏", "Screenshots"]);
	const version = getSection(sections, ["版本", "Version"]);
	const device = getSection(sections, ["设备", "Device"]);
	const browser = getSection(sections, ["浏览器", "Browser"]);
	const os = getSection(sections, ["操作系统", "OS"]);

	if (!hasMeaningfulTitle(issue.title)) {
		reasons.push("标题需要概括具体问题，不能只保留模板前缀。");
	}

	if (!hasMeaningfulText(description, 20)) {
		reasons.push("请补充至少 20 个有效字符的问题描述。");
	}

	if (!hasEnoughReproductionSteps(reproductionSteps)) {
		reasons.push("请提供至少两步可执行的复现步骤。");
	}

	if (!hasMeaningfulText(expectedResult, 8)) {
		reasons.push("请说明期望结果。");
	}

	if (!hasMeaningfulText(actualResult, 8)) {
		reasons.push("请说明实际结果或报错表现。");
	}

	if (!hasMeaningfulText(version, 2) || /^r$/iu.test(stripMarkdownNoise(version))) {
		reasons.push("请填写具体版本号。");
	}

	if (!hasMeaningfulText(device, 3)) {
		reasons.push("请填写设备类型。");
	}

	if (!hasMeaningfulText(browser, 3)) {
		reasons.push("请填写浏览器信息。");
	}

	if (!hasMeaningfulText(os, 3)) {
		reasons.push("请填写操作系统信息。");
	}

	if (!hasMeaningfulCode(code) && !hasUsableUrl(liveExample) && !hasUsableScreenshot(screenshots)) {
		reasons.push("请补充最小复现代码、复现链接、截图或录屏之一。");
	}

	return reasons;
}

/**
 * 校验功能请求表单。
 * @param {object} issue Issue 对象。
 * @param {Map<string, string>} sections 字段映射。
 * @returns {string[]} 未通过原因。
 */
function validateFeatureIssue(issue, sections) {
	const reasons = [];
	const background = getSection(sections, ["需求背景", "Description"]);
	const solution = getSection(sections, ["期望方案", "Solution"]);
	const alternatives = getSection(sections, ["替代方案", "Alternatives"]);
	const useCase = getSection(sections, ["使用场景", "Use case"]);

	if (!hasMeaningfulTitle(issue.title)) {
		reasons.push("标题需要概括具体功能诉求，不能只保留模板前缀。");
	}

	if (!hasMeaningfulText(background, 20)) {
		reasons.push("请补充至少 20 个有效字符的需求背景。");
	}

	if (!hasMeaningfulText(solution, 20)) {
		reasons.push("请补充至少 20 个有效字符的期望方案。");
	}

	if (!hasMeaningfulText(alternatives, 8)) {
		reasons.push("请说明已经考虑过的替代方案；如果没有，请说明原因。");
	}

	if (!hasMeaningfulText(useCase, 12)) {
		reasons.push("请补充具体使用场景。");
	}

	return reasons;
}

/**
 * 汇总通用反垃圾规则。
 * @param {object} issue Issue 对象。
 * @returns {string[]} 未通过原因。
 */
function validateCommonSpamShape(issue) {
	const reasons = [];
	const body = normalizeContent(issue.body);
	const repeatedCharsPattern = /(.)\1{40,}/u;

	if (!hasMeaningfulText(body, 30)) {
		reasons.push("Issue 正文有效内容过少，请使用模板补全信息。");
	}

	if (countUrls(body) > 8) {
		reasons.push("Issue 正文包含过多链接，疑似广告或机器生成内容。");
	}

	if (repeatedCharsPattern.test(body) || repeatedCharsPattern.test(normalizeContent(issue.title))) {
		reasons.push("Issue 包含异常重复字符，疑似机器生成内容。");
	}

	return reasons;
}

/**
 * 校验 Issue 内容并决定后续动作。
 * @param {object} issue GitHub Issue 对象。
 * @returns {IssueCheckResult} 校验结果。
 */
function evaluateIssue(issue) {
	const sections = parseSections(issue.body ?? "");
	const isTrustedAuthor = TRUSTED_AUTHOR_ASSOCIATIONS.has(String(issue.author_association ?? "").toUpperCase());
	const abuseReasons = detectAbuseReasons(issue);
	const isAbuse = abuseReasons.length > 0;
	const kind = isAbuse ? "abuse" : detectIssueKind(issue, sections);
	let reasons = isAbuse ? abuseReasons : validateCommonSpamShape(issue);

	if (isAbuse) {
		// 高置信违规骚扰内容不再继续跑模板字段校验，避免输出冗长误导原因。
	} else if (kind === "bug") {
		reasons = reasons.concat(validateBugIssue(issue, sections));
	} else if (kind === "feature") {
		reasons = reasons.concat(validateFeatureIssue(issue, sections));
	} else {
		reasons.push("请使用“缺陷反馈”或“功能请求”模板创建 Issue，不要使用空白 Issue。");
	}

	const uniqueReasons = [...new Set(reasons)];
	const isQualified = kind !== "invalid" && uniqueReasons.length === 0;
	const labels = kind === "abuse"
		? [ISSUE_LABELS.abuse, OPTIONAL_ABUSE_LABEL]
		: [ISSUE_LABELS[kind] ?? ISSUE_LABELS.invalid];
	const shouldClose = (!isQualified || isAbuse) && !isTrustedAuthor;

	return {
		kind,
		isQualified,
		isTrustedAuthor,
		isAbuse,
		shouldClose,
		shouldLock: shouldClose && isAbuse,
		labels,
		reasons: uniqueReasons,
	};
}

/**
 * 发送 GitHub REST API 请求。
 * @param {string} method HTTP 方法。
 * @param {string} path API 路径。
 * @param {string} token GitHub Token。
 * @param {object | undefined} body 请求体。
 * @returns {Promise<unknown>} 响应 JSON。
 */
function requestGitHub(method, path, token, body) {
	const requestBody = body ? JSON.stringify(body) : "";
	const requestOptions = {
		hostname: "api.github.com",
		path,
		method,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": API_USER_AGENT,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	};

	if (requestBody) {
		requestOptions.headers["Content-Length"] = Buffer.byteLength(requestBody);
	}

	return new Promise((resolve, reject) => {
		const request = https.request(requestOptions, (response) => {
			let responseBody = "";

			response.on("data", (chunk) => {
				responseBody += chunk;
			});

			response.on("end", () => {
				if (response.statusCode === 204) {
					resolve(null);
					return;
				}

				const parsedBody = responseBody ? parseJsonResponse(responseBody) : null;

				if (response.statusCode >= 200 && response.statusCode < 300) {
					resolve(parsedBody);
					return;
				}

				reject(new Error(`[issue-gatekeeper] GitHub API ${method} ${path} 失败：${response.statusCode} ${responseBody.slice(0, 500)}`));
			});
		});

		request.on("error", reject);

		if (requestBody) {
			request.write(requestBody);
		}

		request.end();
	});
}

/**
 * 解析 API JSON 响应。
 * @param {string} responseBody 响应正文。
 * @returns {unknown} JSON 对象。
 */
function parseJsonResponse(responseBody) {
	try {
		return JSON.parse(responseBody);
	} catch (error) {
		throw new Error(`[issue-gatekeeper] GitHub API 返回了非 JSON 内容：${error.message}`);
	}
}

/**
 * 判断是否启用高置信违规 Issue 的删除动作。
 * 默认关闭删除，必须显式设置 ISSUE_GATEKEEPER_DELETE_ABUSE=1 才会执行。
 * @returns {boolean} 是否启用删除。
 */
function isAbuseDeletionEnabled() {
	return process.env.ISSUE_GATEKEEPER_DELETE_ABUSE === "1";
}

/**
 * 添加 Issue 标签。标签不存在时只记录警告，避免影响关闭链路。
 * @param {string} owner 仓库所有者。
 * @param {string} repo 仓库名。
 * @param {number} issueNumber Issue 编号。
 * @param {string[]} labels 标签列表。
 * @param {string} token GitHub Token。
 * @returns {Promise<void>}
 */
async function addLabels(owner, repo, issueNumber, labels, token) {
	const uniqueLabels = [...new Set(labels.filter(Boolean))];

	if (!uniqueLabels.length) {
		return;
	}

	for (const label of uniqueLabels) {
		try {
			await requestGitHub(
				"POST",
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
				token,
				{ labels: [label] },
			);
		} catch (error) {
			console.warn(`[issue-gatekeeper] 标签 ${label} 添加失败，不影响后续处理：${error.message}`);
		}
	}
}

/**
 * 查找工作流此前写入的固定评论。
 * @param {string} owner 仓库所有者。
 * @param {string} repo 仓库名。
 * @param {number} issueNumber Issue 编号。
 * @param {string} token GitHub Token。
 * @returns {Promise<object | null>} 已存在的评论。
 */
async function findGatekeeperComment(owner, repo, issueNumber, token) {
	const comments = await requestGitHub(
		"GET",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`,
		token,
	);

	if (!Array.isArray(comments)) {
		return null;
	}

	return comments.find((comment) => typeof comment.body === "string" && comment.body.includes(COMMENT_MARKER)) ?? null;
}

/**
 * 创建或更新工作流评论，避免每次 edited 事件重复刷屏。
 * @param {string} owner 仓库所有者。
 * @param {string} repo 仓库名。
 * @param {number} issueNumber Issue 编号。
 * @param {string} token GitHub Token。
 * @param {string} body 评论正文。
 * @returns {Promise<void>}
 */
async function upsertGatekeeperComment(owner, repo, issueNumber, token, body) {
	let existingComment = null;

	try {
		existingComment = await findGatekeeperComment(owner, repo, issueNumber, token);
	} catch (error) {
		console.warn(`[issue-gatekeeper] 查询历史评论失败，将尝试创建新评论：${error.message}`);
	}

	if (existingComment) {
		await requestGitHub(
			"PATCH",
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${existingComment.id}`,
			token,
			{ body },
		);
		return;
	}

	await requestGitHub(
		"POST",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
		token,
		{ body },
	);
}

/**
 * 关闭不合格 Issue。
 * @param {string} owner 仓库所有者。
 * @param {string} repo 仓库名。
 * @param {number} issueNumber Issue 编号。
 * @param {string} token GitHub Token。
 * @returns {Promise<void>}
 */
async function closeIssue(owner, repo, issueNumber, token) {
	await requestGitHub(
		"PATCH",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
		token,
		{
			state: "closed",
			state_reason: "not_planned",
		},
	);
}

/**
 * 锁定高置信违规骚扰 Issue，阻断后续刷屏或争论。
 * @param {string} owner 仓库所有者。
 * @param {string} repo 仓库名。
 * @param {number} issueNumber Issue 编号。
 * @param {string} token GitHub Token。
 * @returns {Promise<void>}
 */
async function lockIssue(owner, repo, issueNumber, token) {
	await requestGitHub(
		"PUT",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/lock`,
		token,
		{ lock_reason: "spam" },
	);
}

/**
 * 通过 GraphQL 删除 Issue。该动作默认不启用，且通常需要更高权限。
 * @param {string} issueNodeId Issue 的 GraphQL Node ID。
 * @param {string} token GitHub Token。
 * @returns {Promise<void>}
 */
async function deleteIssue(issueNodeId, token) {
	const response = await requestGitHub(
		"POST",
		"/graphql",
		token,
		{
			query: "mutation DeleteIssue($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { clientMutationId } }",
			variables: {
				issueId: issueNodeId,
			},
		},
	);

	if (response && Array.isArray(response.errors) && response.errors.length > 0) {
		throw new Error(`[issue-gatekeeper] GraphQL deleteIssue 失败：${JSON.stringify(response.errors).slice(0, 500)}`);
	}
}

/**
 * 构建不合格 Issue 的回复内容。
 * @param {object} issue Issue 对象。
 * @param {IssueCheckResult} result 校验结果。
 * @returns {string} 评论正文。
 */
function buildUnqualifiedComment(issue, result) {
	const reasonList = result.reasons.map((reason, index) => `${index + 1}. ${reason}`).join("\n");

	return `${COMMENT_MARKER}
你好 @${issue.user?.login ?? "contributor"}，这个 Issue 因为信息不足或疑似机器生成内容被自动关闭。

未通过原因：
${reasonList}

请使用仓库提供的 Issue 表单重新提交，或补齐信息后手动重新打开。维护者会优先处理包含可复现步骤、版本、环境和最小复现材料的 Issue。`;
}

/**
 * 构建高置信违规骚扰 Issue 的短回复内容。
 * @returns {string} 评论正文。
 */
function buildAbuseComment() {
	return `${COMMENT_MARKER}
该 Issue 命中仓库自动风控规则，已被关闭并锁定。`;
}

/**
 * 构建重新检查通过后的回复内容。
 * @param {object} issue Issue 对象。
 * @returns {string} 评论正文。
 */
function buildQualifiedComment(issue) {
	return `${COMMENT_MARKER}
@${issue.user?.login ?? "contributor"}，这个 Issue 已经通过自动检查，不再由工作流自动关闭。`;
}

/**
 * 从事件中解析仓库坐标。
 * @param {object} eventPayload GitHub 事件。
 * @returns {{owner: string, repo: string}} 仓库坐标。
 */
function resolveRepository(eventPayload) {
	const fullName = process.env.GITHUB_REPOSITORY || eventPayload.repository?.full_name;

	if (!fullName || !fullName.includes("/")) {
		throw new Error("[issue-gatekeeper] 无法解析 GITHUB_REPOSITORY。");
	}

	const [owner, repo] = fullName.split("/");
	return { owner, repo };
}

/**
 * 执行工作流主逻辑。
 * @returns {Promise<void>}
 */
async function main() {
	const eventPayload = readEventPayload();
	const issue = eventPayload.issue;

	if (!issue || issue.pull_request) {
		console.log("[issue-gatekeeper] 当前事件不是普通 Issue，跳过。");
		return;
	}

	const result = evaluateIssue(issue);
	const dryRun = process.env.ISSUE_GATEKEEPER_DRY_RUN === "1";
	console.log(`[issue-gatekeeper] #${issue.number} kind=${result.kind} qualified=${result.isQualified} trusted=${result.isTrustedAuthor} abuse=${result.isAbuse}`);

	if (dryRun) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

	if (!token) {
		throw new Error("[issue-gatekeeper] 缺少 GITHUB_TOKEN，无法写入标签、评论或关闭 Issue。");
	}

	const { owner, repo } = resolveRepository(eventPayload);
	await addLabels(owner, repo, issue.number, result.labels, token);

	if (result.shouldClose) {
		const commentBody = result.isAbuse ? buildAbuseComment() : buildUnqualifiedComment(issue, result);
		await upsertGatekeeperComment(owner, repo, issue.number, token, commentBody);

		if (issue.state !== "closed") {
			await closeIssue(owner, repo, issue.number, token);
		}

		if (result.shouldLock) {
			try {
				await lockIssue(owner, repo, issue.number, token);
			} catch (error) {
				console.warn(`[issue-gatekeeper] 锁定违规 Issue 失败，不影响关闭结果：${error.message}`);
			}
		}

		if (result.isAbuse && isAbuseDeletionEnabled()) {
			if (!issue.node_id) {
				console.warn("[issue-gatekeeper] 事件 payload 缺少 issue.node_id，无法执行 GraphQL deleteIssue。");
			} else {
				try {
					await deleteIssue(issue.node_id, token);
				} catch (error) {
					console.warn(`[issue-gatekeeper] 删除违规 Issue 失败，已保留关闭和锁定结果：${error.message}`);
				}
			}
		}

		return;
	}

	if (!result.isQualified && result.isTrustedAuthor) {
		console.log("[issue-gatekeeper] 可信作者未通过校验，但不会自动关闭。");
		return;
	}

	try {
		const existingComment = await findGatekeeperComment(owner, repo, issue.number, token);

		if (existingComment && result.isQualified) {
			await upsertGatekeeperComment(owner, repo, issue.number, token, buildQualifiedComment(issue));
		}
	} catch (error) {
		console.warn(`[issue-gatekeeper] 更新历史评论失败，不影响通过结果：${error.message}`);
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

module.exports = {
	detectAbuseReasons,
	evaluateIssue,
	parseSections,
};
