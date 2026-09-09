import { stripVTControlCharacters } from 'node:util';
import type { AgentEvent } from '../../../packages/core/src/index.js';

export function validTarget(value: string): boolean {
  return /^[a-z][a-z0-9-]*:[^\s]+$/.test(value) && !/^(model|your[-_]?model|<.*>)$/i.test(value.slice(value.indexOf(':') + 1));
}

export async function choose(label: string, items: string[], ask: (label: string) => Promise<string>, write: (text: string) => void, preferred = 0): Promise<number> {
  write(`\n${label}\n${items.map((item, index) => `  ${index + 1}. ${stripVTControlCharacters(item)}${index === preferred ? '  ◀' : ''}`).join('\n')}\n`);
  while (true) {
    const answer = (await ask(`Selecciona [${preferred + 1}] · q cancelar: `)).trim();
    if (answer.toLowerCase() === 'q') throw new Error('Selección cancelada.');
    const index = answer === '' ? preferred : Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < items.length) return index;
    write('Introduce un número de la lista.\n');
  }
}

export class TerminalUsage {
  input = 0;
  output = 0;
  reported = 0;
  responses = 0;
  accept(event: AgentEvent): void {
    if (event.type === 'model:response') this.responses++;
    if (event.type === 'model:usage') {
      this.input += event.inputTokens;
      this.output += event.outputTokens;
      this.reported++;
    }
  }
  render(chars: number, limit: number): string {
    const percent = Math.min(100, Math.round(chars / limit * 100));
    const filled = Math.round(percent / 10);
    const tokens = this.reported ? `${this.input} entrada · ${this.output} salida${this.reported < this.responses ? ' (parcial)' : ''}` : 'no reportados';
    return `Tokens desde apertura: ${tokens}\nContexto local [${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${percent}% · ${chars}/${limit} caracteres · ventana del modelo: no disponible`;
  }
}
