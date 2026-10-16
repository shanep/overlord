// Frustration view. Owned by the frustration work; this stub keeps the build green.
import type { ReactElement } from 'react';

import type { FrustrationState } from '../../../src/shared/protocol.js';
import { EmptyState } from '../components/empty-state.js';

export function FrustrationView(props: { readonly state: FrustrationState }): ReactElement {
  return <EmptyState title="Frustration" detail={`${String(props.state.atClaude)} so far.`} />;
}
