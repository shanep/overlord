import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Icon } from './icon.js';

describe('Icon', () => {
  it('draws the official filled Copilot mark', () => {
    const { container } = render(<Icon name="copilot" />);
    const mark = container.querySelector('path');
    expect(mark?.getAttribute('fill')).toBe('currentColor');
    expect(mark?.getAttribute('stroke')).toBe('none');
    expect(mark?.getAttribute('fill-rule')).toBe('evenodd');
  });
});
