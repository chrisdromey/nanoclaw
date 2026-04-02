import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { pollForChanges } from '../sse.js';

export const eventRoutes = new Hono();

eventRoutes.get('/events', (c) => {
  return streamSSE(c, async (stream) => {
    let running = true;

    stream.onAbort(() => {
      running = false;
    });

    while (running) {
      try {
        const events = pollForChanges();
        for (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event.data),
          });
        }
      } catch {
        // Ignore polling errors
      }

      // Keep-alive comment every cycle
      await stream.writeSSE({ data: '', event: 'ping' });

      // Poll every 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  });
});
