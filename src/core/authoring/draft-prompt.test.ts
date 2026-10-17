import { describe, expect, it } from 'vitest';

import { AGENT_GUIDE, buildDraftPrompt, extractDraftText, SKILL_GUIDE } from './draft-prompt.js';

describe('buildDraftPrompt', () => {
  it('asks for an agent file with the field guide and the trimmed description', () => {
    const prompt = buildDraftPrompt('agent', '  reviews SQL migrations  \n');
    expect(prompt.startsWith('Write a Claude Code subagent definition file')).toBe(true);
    expect(prompt).toContain('- name (required):');
    expect(prompt).toContain('- permissionMode: default, acceptEdits');
    expect(prompt).toContain('Reply with only the file content');
    expect(prompt).toContain('do not wrap it in a code fence');
    expect(prompt).toContain('never em dashes or en dashes');
    expect(prompt.endsWith('What the user wants:\nreviews SQL migrations\n')).toBe(true);
    expect(prompt).not.toContain('SKILL.md');
  });

  it('asks for a skill file with the skill guide', () => {
    const prompt = buildDraftPrompt('skill', 'deploy to staging');
    expect(
      prompt.startsWith('Write a Claude Code skill file (.claude/skills/<name>/SKILL.md).'),
    ).toBe(true);
    expect(prompt).toContain('under 1,536 characters');
    expect(prompt).toContain('$ARGUMENTS expands');
    expect(prompt.endsWith('What the user wants:\ndeploy to staging\n')).toBe(true);
    expect(prompt).not.toContain('subagent definition');
  });

  it('never contains em or en dashes', () => {
    expect(buildDraftPrompt('agent', 'x')).not.toMatch(/[\u2013\u2014]/u);
    expect(buildDraftPrompt('skill', 'x')).not.toMatch(/[\u2013\u2014]/u);
    expect(buildDraftPrompt('skill', 'x', { alsoReadBy: ['A', 'B'] })).not.toMatch(
      /[\u2013\u2014]/u,
    );
  });

  it('is the same prompt as before for Claude Code alone', () => {
    expect(buildDraftPrompt('agent', 'x', {})).toBe(buildDraftPrompt('agent', 'x'));
    expect(buildDraftPrompt('agent', 'x', { guide: AGENT_GUIDE })).toBe(
      buildDraftPrompt('agent', 'x'),
    );
    expect(buildDraftPrompt('skill', 'x', { alsoReadBy: [] })).toBe(buildDraftPrompt('skill', 'x'));
  });

  it('uses another agent guide and names who else reads a skill', () => {
    const agent = buildDraftPrompt('agent', 'x', { guide: 'Write a Copilot CLI agent.' });
    expect(agent.startsWith('Write a Copilot CLI agent.\n\nOnly include fields')).toBe(true);
    expect(agent).not.toContain('subagent definition');
    const skill = buildDraftPrompt('skill', 'x', { alsoReadBy: ['Copilot CLI', 'Codex CLI'] });
    expect(skill.startsWith(SKILL_GUIDE)).toBe(true);
    expect(skill).toContain(
      '\n\nCopilot CLI and Codex CLI also read this file, so always set name',
    );
  });
});

describe('extractDraftText', () => {
  it('trims a plain reply and ends it with one newline', () => {
    expect(extractDraftText('\n---\nname: a\n---\nBody\n\n')).toBe('---\nname: a\n---\nBody\n');
  });

  it('unwraps a fenced reply with or without a language', () => {
    expect(extractDraftText('```markdown\n---\nname: a\n---\nBody\n```')).toBe(
      '---\nname: a\n---\nBody\n',
    );
    expect(extractDraftText('```\r\n---\r\nx\r\n```\n')).toBe('---\r\nx\n');
    expect(extractDraftText('```md\n\n---\nx  \n```')).toBe('---\nx\n');
  });

  it('leaves a reply alone when the fence is not the whole reply', () => {
    expect(extractDraftText('Here:\n```\nx\n```')).toBe('Here:\n```\nx\n```\n');
  });
});
