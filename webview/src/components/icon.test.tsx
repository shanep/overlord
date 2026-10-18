import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { codexAgent } from '../../test/fixtures-agents.js';

import { agentIcon, Icon } from './icon.js';

describe('Icon', () => {
  it('draws the official filled Copilot mark', () => {
    const { container } = render(<Icon name="copilot" />);
    const mark = container.querySelector('path');
    expect(mark?.getAttribute('fill')).toBe('currentColor');
    expect(mark?.getAttribute('stroke')).toBe('none');
    expect(mark?.getAttribute('fill-rule')).toBe('evenodd');
  });

  it("draws OpenAI's filled logomark for Codex and keeps the codicon mapping for the rest", () => {
    expect(agentIcon(codexAgent)).toBe('openai');
    expect(agentIcon({ id: 'custom', icon: 'terminal' })).toBe('window');
    expect(agentIcon({ id: 'custom', icon: 'unknown' })).toBe('prompt');
    const { container } = render(<Icon name="openai" />);
    expect(container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });
});
