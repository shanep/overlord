import { describe, expect, it } from 'vitest';

import { measureOf } from './test-helpers/fixtures.js';
import type { TopicScore } from './topics.js';
import { MAX_TOPICS, MIN_SESSIONS, topicReason, TOPICS, topTopics } from './topics.js';

function first(scores: readonly TopicScore[]): TopicScore {
  const [score] = scores;
  if (score === undefined) {
    throw new Error('no topic stood out');
  }
  return score;
}

function sessions(count: number, stack: Record<string, number>): ReturnType<typeof measureOf>[] {
  return Array.from({ length: count }, (_, index) =>
    measureOf({ sessionId: `s${String(index)}`, stack }),
  );
}

describe('topics', () => {
  it('gives every topic a unique id, a query, words and signals', () => {
    expect(new Set(TOPICS.map((topic) => topic.id)).size).toBe(TOPICS.length);
    for (const topic of TOPICS) {
      expect(topic.query).not.toBe('');
      expect(topic.words.length).toBeGreaterThan(0);
      expect(topic.signals.length).toBeGreaterThan(0);
    }
  });

  it('keeps topics that show up in enough sessions, most used first', () => {
    const scores = topTopics([
      ...sessions(MIN_SESSIONS, { '.py': 30, pytest: 10 }),
      ...sessions(MIN_SESSIONS, { '.tex': 10 }),
      // Lots of Rust, but in too few sessions to count.
      ...sessions(MIN_SESSIONS - 1, { cargo: 500 }),
    ]);
    expect(scores.map((score) => [score.topic.id, score.uses, score.sessions])).toStrictEqual([
      ['python', 120, 3],
      ['latex', 30, 3],
    ]);
    expect(topicReason(first(scores))).toBe(
      '90 .py file reads or edits and 30 pytest commands in 3 sessions.',
    );
  });

  it('keeps at most MAX_TOPICS and drops ones used too little', () => {
    const busy = sessions(MIN_SESSIONS, {
      '.py': 100,
      '.rs': 90,
      '.go': 80,
      '.java': 70,
      '.rb': 60,
      '.php': 1,
    });
    expect(topTopics(busy).map((score) => score.topic.id)).toHaveLength(MAX_TOPICS);
    expect(topTopics(busy).map((score) => score.topic.id)).not.toContain('php');
  });

  it('words a file with no extension and a single use', () => {
    const scores = topTopics(sessions(MIN_SESSIONS, { Dockerfile: 1, docker: 20 }));
    expect(scores).toHaveLength(1);
    expect(topicReason(first(scores))).toBe(
      '60 docker commands and 3 Dockerfile reads or edits in 3 sessions.',
    );
  });
});
