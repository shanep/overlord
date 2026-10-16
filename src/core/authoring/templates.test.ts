import { describe, expect, it } from 'vitest';

import { findTemplate, renderTemplate, TEMPLATES } from './templates.js';
import { validateAgentFile, validateSkillFile } from './validate.js';

describe('TEMPLATES', () => {
  it('has three agents and two skills with unique ids', () => {
    expect(TEMPLATES.map((template) => [template.id, template.kind])).toStrictEqual([
      ['agent-reviewer', 'agent'],
      ['agent-researcher', 'agent'],
      ['agent-test-writer', 'agent'],
      ['skill-basic', 'skill'],
      ['skill-arguments', 'skill'],
    ]);
  });

  it.each(TEMPLATES)('$id renders to a file with no issues at all', (template) => {
    const text = renderTemplate(template);
    const issues = template.kind === 'agent' ? validateAgentFile(text) : validateSkillFile(text);
    expect(issues).toStrictEqual([]);
    expect(text.startsWith(`---\nname: ${template.spec.frontmatter.name ?? ''}\n`)).toBe(true);
    expect(template.label.length).toBeGreaterThan(0);
    expect(template.summary.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[\u2013\u2014]/u);
  });

  it('renders the arguments skill with its named arguments', () => {
    const template = findTemplate('skill-arguments');
    expect(template === null ? '' : renderTemplate(template)).toContain(
      'argument-hint: "[issue-number] [branch]"\narguments:\n  - issue\n  - branch\ndisable-model-invocation: true\n',
    );
  });

  it('renders the reviewer with its tools on one line', () => {
    const template = findTemplate('agent-reviewer');
    expect(template === null ? '' : renderTemplate(template)).toContain(
      'tools: Read, Grep, Glob, Bash\nmodel: inherit\ncolor: blue\n---\n\nYou are a careful code reviewer.',
    );
  });
});

describe('findTemplate', () => {
  it('finds by id or returns null', () => {
    expect(findTemplate('agent-test-writer')?.label).toBe('Test writer');
    expect(findTemplate('nope')).toBeNull();
  });
});
