import { useState } from 'react';
import { isDeeplinkTimeoutError } from '../../src';
import { appDeeplinks } from './deeplinks';

export interface CallerMfeProps {
  /** Per-call budget; the default in the toolbox is 10000 ms. */
  timeout?: number;
}

/** Any MFE that wants an order opened: it only knows the key and the contract. */
export function CallerMfe({ timeout = 10000 }: CallerMfeProps) {
  const [message, setMessage] = useState('idle');

  async function openOrder() {
    setMessage('opening…');
    try {
      const result = await appDeeplinks.invoke('orders.open', { orderId: '42' }, { timeout });
      setMessage(`result: ${JSON.stringify(result)}`);
    } catch (error) {
      if (isDeeplinkTimeoutError(error)) {
        setMessage(
          error.phase === 'waiting'
            ? 'error: no MFE handles orders.open yet'
            : 'error: orders.open took too long',
        );
      } else {
        setMessage(`error: ${(error as Error).message}`);
      }
    }
  }

  return (
    <div>
      <button type="button" onClick={openOrder}>
        Open order 42
      </button>
      <output aria-label="caller result">{message}</output>
    </div>
  );
}
