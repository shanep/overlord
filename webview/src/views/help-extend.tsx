// The "Extending Overlord" part of the help page: what an extension can put
// in each numbered place on the screen map, and what Overlord puts there
// today. The numbers give us a shared name for each place, so a request can
// say "add a button to 4".

import type { ReactElement } from 'react';

import type { ExtensionPoint } from './help-screen-content.js';
import { OFF_SCREEN, SCREEN_AREAS } from './help-screen-content.js';
import { AreaNumber, SCREEN_MAP_ID } from './help-screen.js';

function usedBy(area: ExtensionPoint): string {
  return area.overlord ?? 'Not yet.';
}

export function ExtendSection(): ReactElement {
  return (
    <section className="section help-section" aria-labelledby="help-extend">
      <h2 id="help-extend">Extending Overlord</h2>
      <p className="muted">
        Every place on the VS Code screen an extension can draw into, numbered as on the map in{' '}
        <a href={`#${SCREEN_MAP_ID}`}>Where things are</a>. Ask for a change by number, like
        &quot;add a button to 4&quot; or &quot;show the cost in 12&quot;. A solid number is a place
        Overlord already uses, and a dashed one is still open. The places come from{' '}
        <code>contributes</code> in package.json and from the code in src/host.
      </p>
      <table className="grid help-table" aria-label="Places an extension can draw into">
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col" className="wrap">
              What an extension can put there
            </th>
            <th scope="col" className="wrap">
              In Overlord
            </th>
          </tr>
        </thead>
        <tbody>
          {SCREEN_AREAS.map((area) => (
            <tr key={area.number}>
              <td className="help-key">
                <span className="help-pair">
                  <AreaNumber number={area.number} used={area.overlord !== null} />
                  {area.name}
                </span>
              </td>
              <td className="wrap">{area.apis}</td>
              <td className="wrap">{usedBy(area)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Off the screen</h3>
      <p className="muted">These change VS Code without a place of their own.</p>
      <table className="grid help-table" aria-label="Extension points off the screen">
        <thead>
          <tr>
            <th scope="col">Point</th>
            <th scope="col" className="wrap">
              What it does
            </th>
            <th scope="col" className="wrap">
              In Overlord
            </th>
          </tr>
        </thead>
        <tbody>
          {OFF_SCREEN.map((point) => (
            <tr key={point.name}>
              <td className="help-key">{point.name}</td>
              <td className="wrap">{point.apis}</td>
              <td className="wrap">{usedBy(point)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
