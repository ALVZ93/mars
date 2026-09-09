import type { AssistantMessage, ModelEvent, ModelProvider, ModelRequest } from '../../core/src/index.js';
import { checkAbort } from '../../core/src/index.js';

export type FakeStep = AssistantMessage | ((request: ModelRequest) => AssistantMessage);
export class FakeProvider implements ModelProvider {
  readonly id = 'fake';
  readonly requests: ModelRequest[] = [];
  #steps: FakeStep[];
  constructor(steps: FakeStep[] = []) { this.#steps = [...steps]; }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    checkAbort(signal);
    this.requests.push(structuredClone(request));
    const step = this.#steps.shift();
    const message = typeof step === 'function' ? step(request) : step ?? {
      role: 'assistant', content: 'Fake provider: script complete.', toolCalls: [],
    };
    if (message.content) yield { type: 'text', text: message.content };
    yield { type: 'done', message };
  }
}
