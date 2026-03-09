/**
 * Task → Agent routing.
 * Analyzes the task description to determine which agent should handle it.
 */

import type { AgentType } from './model-router.js';

interface RouteDecision {
  agent: AgentType;
  confidence: number;
  reason: string;
}

const ROUTE_PATTERNS: Array<{
  agent: AgentType;
  patterns: RegExp[];
  reason: string;
}> = [
  {
    agent: 'ingest',
    patterns: [
      /\b(?:fetch|ingest|watch|subscribe|pull|download)\b.*\b(?:video|youtube|transcript|tweet|x\.com|twitter|timeline|channel)\b/i,
      /\b(?:youtube|yt|x\.com|twitter|nitter)\b.*\b(?:fetch|get|pull|ingest)\b/i,
      /\bdigest\b/i,
      /\b(?:new|latest|recent)\b.*\b(?:video|tweet|post)\b/i,
    ],
    reason: 'Content ingestion task (YouTube/X)',
  },
  {
    agent: 'research',
    patterns: [
      /\b(?:research|find|look up|search|investigate|explore|summarize|compare|analyze)\b/i,
      /\bwhat (?:is|are|does|do)\b/i,
      /\bhow (?:to|does|do)\b/i,
      /\b(?:crawl|scrape|browse|web)\b/i,
    ],
    reason: 'Research and web information gathering',
  },
  {
    agent: 'coder',
    patterns: [
      /\b(?:implement|code|write|create|build|develop|fix|refactor|add|modify|update|change)\b.*\b(?:function|class|module|component|system|feature|bug|method|endpoint|api)\b/i,
      /\b(?:git|commit|branch|merge|pr|pull request)\b/i,
      /\b(?:cargo|npm|pip|rust|typescript|python)\b/i,
    ],
    reason: 'Code generation or modification',
  },
  {
    agent: 'review',
    patterns: [
      /\b(?:review|audit|check|inspect|verify|validate|security)\b/i,
      /\b(?:pr|pull request)\b.*\b(?:review|check)\b/i,
      /\b(?:quality|standards|best practices)\b/i,
    ],
    reason: 'Code review, quality assurance, or security audit',
  },
  {
    agent: 'ops',
    patterns: [
      /\b(?:build|test|deploy|run|execute|start|stop|restart)\b/i,
      /\b(?:ci|cd|pipeline|cron|schedule|monitor)\b/i,
      /\b(?:docker|container|kubernetes|k8s)\b/i,
    ],
    reason: 'Build, test, deploy, or infrastructure operations',
  },
];

/**
 * Route a task to the appropriate agent.
 */
export function routeTask(task: string): RouteDecision {
  let bestMatch: RouteDecision = {
    agent: 'research', // Default fallback
    confidence: 0.1,
    reason: 'No strong pattern match — defaulting to research agent',
  };

  for (const route of ROUTE_PATTERNS) {
    let matchCount = 0;
    for (const pattern of route.patterns) {
      if (pattern.test(task)) matchCount++;
    }

    const confidence = matchCount / route.patterns.length;
    if (confidence > bestMatch.confidence) {
      bestMatch = {
        agent: route.agent,
        confidence,
        reason: route.reason,
      };
    }
  }

  return bestMatch;
}

/**
 * Route multiple subtasks from a complex request.
 * Splits compound requests and routes each part independently.
 */
export function routeCompoundTask(task: string): RouteDecision[] {
  // Split on common conjunctions and list patterns
  const subtasks = task
    .split(/\b(?:and then|then|also|after that|next|finally)\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  if (subtasks.length <= 1) {
    return [routeTask(task)];
  }

  return subtasks.map(routeTask);
}
