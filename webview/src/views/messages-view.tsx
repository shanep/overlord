// Agent messages view. Owned by the messaging work; this stub keeps the build green.
import type { ReactElement } from 'react';

import type { MessagesState } from '../../../src/shared/protocol.js';
import { EmptyState } from '../components/empty-state.js';

export function MessagesView(props: { readonly state: MessagesState }): ReactElement {
  return (
    <EmptyState title="Agent messages" detail={`${String(props.state.messages.length)} so far.`} />
  );
}
