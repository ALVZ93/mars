import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import type { AgentEvent } from '../../../packages/core/src/index.js';
import { TerminalUsage } from './terminal.js';

const ESC = '\u001b[';
const RED = `${ESC}38;2;238;65;55m`;
const DIM = `${ESC}90m`;
const RESET = `${ESC}0m`;
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

export interface ConversationShellApproval {
  (command: string, cwd: string, signal: AbortSignal): Promise<boolean>;
}

function wrap(value: string, width: number): string[] {
  const text = clean(value);
  if (!text) return [''];
  const result: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let rest = line || ' ';
    while (rest.length > width) { result.push(rest.slice(0, width)); rest = rest.slice(width); }
    result.push(rest);
  }
  return result;
}

export class ConversationScreen {
  readonly usage = new TerminalUsage();
  #model: string;
  #root: string;
  #contextChars = 0;
  #contextLimit = 200_000;
  #lines: string[] = [];
  #input = '';
  #running = false;
  #rawBefore = false;
  #started = false;
  #resolveInput?: (value: string) => void;
  #keypress?: (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => void;
  #resize?: () => void;
  #interrupt?: () => void;

  constructor(model: string, root: string, contextLimit = 200_000) {
    this.#model = model;
    this.#root = root;
    this.#contextLimit = contextLimit;
  }

  start(): void {
    if (this.#started || !process.stdin.isTTY || !process.stdout.isTTY) return;
    this.#started = true;
    this.#rawBefore = Boolean(process.stdin.isRaw);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    this.#resize = () => this.render();
    process.stdout.on('resize', this.#resize);
    this.#keypress = (text, key) => this.#key(text, key);
    process.stdin.on('keypress', this.#keypress);
    this.render();
  }

  stop(): void {
    if (!this.#started) return;
    if (this.#keypress) process.stdin.off('keypress', this.#keypress);
    if (this.#resize) process.stdout.off('resize', this.#resize);
    process.stdin.setRawMode(this.#rawBefore);
    process.stdin.pause();
    process.stdout.write(`${ESC}0m${ESC}?25h${ESC}?1049l`);
    this.#started = false;
  }

  suspend(): void {
    if (!this.#started) return;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${ESC}0m${ESC}?25h${ESC}?1049l`);
  }

  resume(model = this.#model): void {
    this.#model = model;
    if (!this.#started) return;
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.render();
  }

  setModel(model: string): void { this.#model = model; this.render(); }
  setContext(chars: number): void { this.#contextChars = Math.max(0, chars); this.render(); }
  setInterrupt(handler: (() => void) | undefined): void { this.#interrupt = handler; }
  setRunning(running: boolean): void { this.#running = running; this.render(); }
  addUser(value: string): void { this.#lines.push(`› ${clean(value)}`); this.render(); }
  addNotice(value: string): void { this.#lines.push(value); this.render(); }

  async readInput(signal?: AbortSignal): Promise<string> {
    if (!this.#started) return '';
    this.#input = '';
    this.render();
    return new Promise(resolve => {
      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', abort);
        this.#resolveInput = undefined;
        resolve(value);
      };
      const abort = () => finish('');
      this.#resolveInput = finish;
      if (signal) {
        if (signal.aborted) finish('');
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  async confirm(command: string, cwd: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    this.#lines.push(`Shell (host access) · ${clean(cwd)}`, clean(command), 'Allow this command? [y/N]');
    this.render();
    const answer = await this.readInput(signal);
    this.#lines.push(`Permission: ${answer || 'N'}`);
    this.render();
    return /^y(?:es)?$/i.test(answer.trim());
  }

  handleEvent(event: AgentEvent): void {
    this.usage.accept(event);
    if (event.type === 'model:request') this.#lines.push('[MARS · pensando…]');
    if (event.type === 'tool:start') this.#lines.push(`[tool] ${event.tool}`);
    if (event.type === 'tool:end' && event.error) this.#lines.push(`[${event.error}] ${event.tool}`);
    if (event.type === 'permission:denied') this.#lines.push(`[PermissionDeniedError] ${event.permission}`);
    if (event.type === 'model:text') {
      const last = this.#lines.at(-1);
      if (last?.startsWith('[MARS · pensando…]')) this.#lines[this.#lines.length - 1] = event.text;
      else if (last?.startsWith('[tool] ')) this.#lines.push(event.text);
      else this.#lines[this.#lines.length - 1] = `${last ?? ''}${event.text}`;
    }
    if (event.type === 'model:error') this.#lines.push(`[MARS · error] ${event.error}`);
    this.render();
  }

  render(): void {
    if (!this.#started) return;
    const width = Math.max(60, process.stdout.columns || 100);
    const height = Math.max(18, process.stdout.rows || 30);
    const sidebar = width >= 115 ? 27 : 0;
    const main = width - sidebar;
    const inputHeight = 5;
    const transcriptHeight = Math.max(3, height - inputHeight - 4);
    const contentWidth = Math.max(20, main - 4);
    const lines = this.#lines.flatMap(line => wrap(line, contentWidth));
    const visible = lines.slice(-transcriptHeight);
    const percent = Math.min(100, Math.round(this.#contextChars / this.#contextLimit * 100));
    const filled = Math.round(percent / 10);
    const title = `MARS  ${clean(this.#model)}`.slice(0, Math.max(1, width - 2));
    let output = `${ESC}2J${ESC}H${RED}${title}${RESET}`;
    for (let row = 1; row < transcriptHeight + 1; row++) output += `${ESC}${row + 1};1H${' '.repeat(main)}`;
    visible.forEach((line, index) => { output += `${ESC}${index + 2};2H${clean(line).slice(0, contentWidth)}`; });
    const boxTop = height - inputHeight - 1;
    for (let row = 0; row < inputHeight; row++) output += `${ESC}${boxTop + row};1H${RED}▎${RESET}${' '.repeat(main - 1)}`;
    output += `${ESC}${boxTop + 1};4H${this.#running ? `${DIM}[MARS · pensando…]${RESET}` : '› '}${clean(this.#input).slice(0, contentWidth - 4)}`;
    output += `${ESC}${boxTop + 3};4H${RED}Build${RESET} · ${clean(this.#model)}`;
    output += `${ESC}${height};2H${DIM}enter enviar   tab modelos   ctrl+p comandos   ctrl+c salir${RESET}`;
    if (!sidebar) output += `${ESC}${height - 1};2H${DIM}${clean(this.#root).slice(0, width - 12)}${RESET}${ESC}${height - 1};${Math.max(2, width - 10)}H${DIM}MARS 0.1${RESET}`;
    if (sidebar) {
      const x = main + 2;
      output += `${ESC}2;${x}H${RED}SESSION${RESET}`;
      output += `${ESC}4;${x}HContext${ESC}5;${x}H${DIM}${Math.round(this.#contextChars / 4)} tokens · ${percent}%${RESET}`;
      output += `${ESC}7;${x}HTokens${ESC}8;${x}H${DIM}${this.usage.input + this.usage.output || 0} usados${RESET}`;
      output += `${ESC}10;${x}HModel${ESC}11;${x}H${DIM}${clean(this.#model).slice(0, sidebar - 3)}${RESET}`;
      output += `${ESC}${height - 2};${x}H${DIM}${clean(this.#root).slice(0, sidebar - 3)}${RESET}`;
    }
    process.stdout.write(`${output}${ESC}${boxTop + 1};${Math.min(main - 1, 4 + this.#input.length)}H${ESC}?25h`);
  }

  #key(text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }): void {
    if (key.ctrl && key.name === 'c') { if (this.#running) this.#interrupt?.(); else this.#resolveInput?.('/exit'); return; }
    if (key.name === 'escape') { this.#interrupt?.(); return; }
    if (!this.#resolveInput) return;
    if (key.ctrl && key.name === 'p') { const resolve = this.#resolveInput; this.#resolveInput = undefined; resolve('/help'); return; }
    if (key.name === 'tab') { const resolve = this.#resolveInput; this.#resolveInput = undefined; resolve('/model'); return; }
    if (key.name === 'return') { if (!this.#input.trim()) return; const value = this.#input.trim(); this.#input = ''; const resolve = this.#resolveInput; this.#resolveInput = undefined; resolve(value); return; }
    if (key.name === 'backspace') this.#input = [...this.#input].slice(0, -1).join('');
    else if (key.ctrl && key.name === 'u') this.#input = '';
    else if (text && !key.ctrl && !key.meta && !text.startsWith('\x1b')) this.#input = (this.#input + clean(text)).slice(0, 16_000);
    this.render();
  }
}
