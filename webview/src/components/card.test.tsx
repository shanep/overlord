import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectAccessible } from '../../test/render.js';

import {
  Avatar,
  Card,
  CardGrid,
  CardGroup,
  Notice,
  Segmented,
  StatTiles,
  StatusDot,
} from './card.js';

describe('Card', () => {
  it('adds an edge for a tone, a hover for actions and a full row when open', () => {
    const { getAllByRole } = render(
      <CardGrid label="Cards">
        <Card>plain</Card>
        <Card tone="critical" action open>
          all
        </Card>
      </CardGrid>,
    );
    expect(getAllByRole('listitem').map((item) => item.className)).toStrictEqual([
      'card',
      'card card-edge card-critical card-action card-open',
    ]);
  });

  it('makes a wide grid that fills gaps', () => {
    const { getByRole } = render(
      <CardGrid label="Wide" wide>
        <Card>one</Card>
      </CardGrid>,
    );
    expect(getByRole('list', { name: 'Wide' }).className).toBe('card-grid card-grid-wide');
  });
});

describe('CardGroup', () => {
  it('heads its grid with a count and passes axe', async () => {
    const { container, getByRole } = render(
      <CardGroup id="group" title="Ready" count={2}>
        <Card>a</Card>
        <Card>b</Card>
      </CardGroup>,
    );
    expect(getByRole('list', { name: 'Ready 2' }).className).toBe('card-grid');
    await expectAccessible(container);
  });

  it('renders nothing for an empty group', () => {
    const { container } = render(
      <CardGroup id="none" title="Needs attention" count={0} wide>
        {null}
      </CardGroup>,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('StatusDot and Avatar', () => {
  it('colors the dot by tone and hides it from screen readers', () => {
    const { container } = render(<StatusDot tone="warning" />);
    const dot = container.firstElementChild;
    expect(dot?.className).toBe('status-dot status-dot-warning');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives the same seed the same color and shows the first letter', () => {
    const first = render(<Avatar seed="io.github.x/sentry" text="sentry" />);
    const again = render(<Avatar seed="io.github.x/sentry" text="Other" />);
    const [one, two] = [first.container.firstElementChild, again.container.firstElementChild];
    expect(one?.textContent).toBe('S');
    expect(two?.textContent).toBe('O');
    expect(one?.className).toMatch(/^avatar avatar-[0-5]$/u);
    expect(one?.className).toBe(two?.className);
  });
});

describe('Segmented', () => {
  it('presses one option and reports a change', () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <Segmented
        label="Kind"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
        value="a"
        onChange={onChange}
      />,
    );
    expect(getByRole('group', { name: 'Kind' }).className).toBe('segmented');
    expect(getByRole('button', { name: 'A' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'B' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(getByRole('button', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('Notice', () => {
  it('is a status when it went well and an alert when it did not', () => {
    const good = render(<Notice ok>Added.</Notice>);
    expect(good.getByRole('status').className).toBe('notice notice-good');
    const bad = render(<Notice ok={false}>Failed.</Notice>);
    expect(bad.getByRole('alert').className).toBe('notice notice-critical');
  });
});

describe('StatTiles', () => {
  it('puts each label over its value, with a hover note when given', async () => {
    const { container } = render(
      <StatTiles
        tiles={[
          { label: 'Tokens', value: '1.5M', title: '1,512,000' },
          { label: 'Cost', value: '$4.82' },
        ]}
      />,
    );
    const tiles = [...container.querySelectorAll('.stat-tile')];
    expect(tiles.map((tile) => tile.textContent)).toStrictEqual(['Tokens1.5M', 'Cost$4.82']);
    expect(tiles[0]?.getAttribute('title')).toBe('1,512,000');
    expect(tiles[1]?.hasAttribute('title')).toBe(false);
    await expectAccessible(container);
  });
});
