#!/usr/bin/env bash
# Awesome Agent Skills Router — curated OMK hints from VoltAgent/awesome-agent-skills
set -euo pipefail

# This hook is advisory only: no network access, no third-party skill install,
# and no prompt blocking. It maps common awesome-agent-skills domains to the
# already-installed OMK skills/workflows that are safe to consider.
if ! command -v node &>/dev/null; then
  exit 0
fi

INPUT_FILE="$(mktemp)"
trap 'rm -f "$INPUT_FILE"' EXIT
cat > "$INPUT_FILE"

node - "$INPUT_FILE" <<'NODE'
const fs = require('node:fs');
// Static slash markers for non-shell smoke validation:
// /open-design /awesome-design-md /omk-design-md /omk-quality-gate /graph-view /omk-kimi-runtime

function readPayload(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function textFrom(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(textFrom).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    for (const key of ['prompt', 'user_prompt', 'message', 'input', 'text', 'content', 'command_args']) {
      const found = textFrom(value[key]);
      if (found) return found;
    }
  }
  return '';
}

const payload = readPayload(process.argv[2]);
const prompt = textFrom(payload.prompt)
  || textFrom(payload.user_prompt)
  || textFrom(payload.message)
  || textFrom(payload.input)
  || textFrom(payload.command_args)
  || textFrom(payload.tool_input)
  || textFrom(payload);

const normalized = prompt.toLowerCase();
if (normalized.trim().length < 3) {
  process.exit(0);
}

const routes = [
  {
    id: 'design-ui',
    patterns: [
      'design', 'ui', 'ux', 'frontend', 'front-end', 'figma', 'stitch', 'open-design',
      'prototype', 'landing', 'component', 'visual', 'screenshot', 'responsive', 'accessibility',
      'react', 'next.js', 'vite', 'expo', 'react native',
      '디자인', '화면', '프론트', '랜딩', '컴포넌트', '시각', '스크린샷', '반응형', '접근성', '프로토타입',
    ],
    skills: ['open-design', 'awesome-design-md', 'omk-design-md', 'omk-flow-design-to-code', 'omk-multimodal-ui-review', 'react-doctor'],
    note: 'For visual work, read DESIGN.md, reuse tokens, use awesome-design-md references when a named style is requested, and launch localhost with omk design open-design when interactive design is useful.',
  },
  {
    id: 'bugfix-debug',
    patterns: [
      'bug', 'error', 'failed', 'failure', 'traceback', 'exception', 'fix', 'regression', 'broken', 'debug',
      '버그', '에러', '오류', '실패', '고쳐', '수정', '안됨', '안돼', '문제', '디버그',
    ],
    skills: ['omk-flow-bugfix', 'andrej-karpathy-skills', 'matt-pocock-skills', 'omk-quality-gate'],
    note: 'For failures, isolate root cause first, keep the patch small, and rerun the failing command plus the quality gate.',
  },
  {
    id: 'feature-build',
    patterns: [
      'implement', 'build', 'add ', 'create', 'scaffold', 'generate', 'feature', 'new command',
      '구현', '추가', '만들', '생성', '기능', '신규',
    ],
    skills: ['omk-plan-first', 'omk-flow-feature-dev', 'matt-pocock-skills', 'andrej-karpathy-skills', 'omk-quality-gate'],
    note: 'For new capability work, plan the smallest reversible diff and include regression coverage before completion.',
  },
  {
    id: 'review-security',
    patterns: [
      'review', 'audit', 'security', 'vulnerability', 'secret', 'token', 'auth', 'permission', 'xss', 'sql injection', 'ssrf',
      '리뷰', '검토', '보안', '취약', '시크릿', '토큰', '인증', '권한',
    ],
    skills: ['omk-code-review', 'omk-quality-gate'],
    note: 'For security-sensitive work, do not print secrets, review trust boundaries, and run the project secret scan when available.',
  },
  {
    id: 'release-git',
    patterns: [
      'release', 'publish', 'npm', 'version', 'changelog', 'commit', 'pull request', ' pr ', 'pr로', 'push', 'tag',
      '배포', '릴리즈', '버전', '변경로그', '커밋', '푸시',
    ],
    skills: ['omk-flow-release', 'omk-flow-pr-review', 'omk-quality-gate'],
    note: 'For release or PR work, verify build/test/package evidence before reporting publish or PR readiness.',
  },
  {
    id: 'spec-planning',
    patterns: [
      'spec', 'prd', 'requirements', 'acceptance', 'tasks', 'speckit', 'plan', 'architecture',
      '명세', '요구사항', '수락기준', '계획', '아키텍처',
    ],
    skills: ['omk-plan-first', 'speckit-specify', 'speckit-plan', 'speckit-tasks'],
    note: 'For specification work, produce acceptance criteria and a test shape before implementation.',
  },
  {
    id: 'refactor-cleanup',
    patterns: [
      'refactor', 'cleanup', 'simplify', 'deslop', 'debt', 'migration',
      '리팩토', '정리', '단순화', '마이그레이션',
    ],
    skills: ['omk-flow-refactor', 'andrej-karpathy-skills', 'matt-pocock-skills', 'omk-quality-gate'],
    note: 'For refactors, preserve behavior with tests first and avoid unrelated rewrites.',
  },
  {
    id: 'ontology-graph',
    patterns: [
      'ontology', 'graph', 'graph-view', 'node', 'nodes', 'edge', 'edges', 'relationship',
      'memory graph', 'risk map', 'decision graph', 'trace map',
      '온톨로지', '그래프', '노드', '엣지', '관계', '메모리 그래프', '리스크맵', '결정 그래프',
    ],
    skills: ['graph-view', 'omk-kimi-runtime', 'omk-quality-gate'],
    note: 'For graph or memory-relationship work, inspect .omk/memory/graph-state.json with omk graph view --open or /graph-view before changing code.',
  },
  {
    id: 'agent-orchestration',
    patterns: [
      'agent', 'subagent', 'multi-agent', 'orchestration', 'workflow', 'mcp', 'hook', 'hooks', 'skill', 'skills', 'memory',
      '에이전트', '서브에이전트', '워크플로', '훅', '스킬', '메모리',
    ],
    skills: ['omk-task-router', 'omk-project-rules', 'omk-kimi-runtime', 'omk-flow-team-run', 'agentmemory', 'multica', 'andrej-karpathy-skills'],
    note: 'For agent or hook work, keep routing advisory, avoid installing unreviewed external skills, and verify generated config locally.',
  },
  {
    id: 'tests-quality',
    patterns: [
      'test', 'tests', 'qa', 'quality', 'lint', 'typecheck', 'playwright', 'e2e', 'coverage',
      '테스트', '검증', '품질', '타입체크', '커버리지',
    ],
    skills: ['omk-quality-gate'],
    note: 'For validation requests, run the actual project scripts and report exact pass/fail evidence.',
  },
  {
    id: 'docs-research',
    patterns: [
      'docs', 'documentation', 'readme', 'research', 'verify', 'official docs', 'look up',
      '문서', '조사', '검증', '검색', '찾아',
    ],
    skills: ['omk-plan-first', 'omk-quality-gate'],
    note: 'For docs or external references, prefer official/current sources and cite or record what was verified.',
  },
];

const matched = routes.filter((route) => route.patterns.some((pattern) => normalized.includes(pattern)));
if (matched.length === 0) {
  process.exit(0);
}

const skills = [];
for (const route of matched) {
  for (const skill of route.skills) {
    if (!skills.includes(skill)) skills.push(skill);
  }
}

if (!skills.includes('omk-quality-gate')) {
  skills.push('omk-quality-gate');
}

const context = [
  'OMK awesome-agent-skills routing hint (curated from VoltAgent/awesome-agent-skills; advisory only).',
  'Matched domains: ' + matched.map((route) => route.id).join(', '),
  'Prefer installed OMK skills/workflows: ' + skills.map((skill) => '/' + skill).join(', '),
  'Do not auto-install third-party skills from awesome-agent-skills. Review source, license, and security before adoption.',
  ...matched.slice(0, 4).map((route) => route.note),
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: context,
  },
}) + '\n');
NODE
