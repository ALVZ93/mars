import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

const logo = [
  '███    ███  █████  ██████  ███████',
  '████  ████ ██   ██ ██   ██ ██     ',
  '██ ████ ██ ███████ ██████  ███████',
  '██  ██  ██ ██   ██ ██   ██      ██',
  '██      ██ ██   ██ ██   ██ ███████',
];
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '');

export function homeFrame(columns: number, rows: number, model: string, root: string, input = '', color = true): string {
  const width = Math.max(20, columns);
  const height = Math.max(12, rows);
  const box = Math.min(88, width - 4);
  const left = Math.max(1, Math.floor((width - box) / 2));
  const top = Math.max(1, Math.floor(height / 2) - 7);
  const paint = (code: string) => color ? `\x1b[${code}m` : '';
  const line = (row: number, col: number, text: string) => `\x1b[${row};${col}H${text}`;
  let output = '\x1b[?25l\x1b[0m\x1b[2J\x1b[H';
  const art = width >= 40 && height >= 22 ? logo : ['M A R S'];
  art.forEach((text, index) => { output += line(top + index, Math.max(1, Math.floor((width - text.length) / 2)), paint('38;2;238;65;55') + text + paint('0')); });
  const row = top + art.length + 2;
  for (let i = 0; i < 5; i++) output += line(row + i, left, paint('38;2;238;65;55') + '▎' + paint('48;2;30;30;30') + ' '.repeat(box - 1) + paint('0'));
  const visible = clean(input).slice(-(box - 6));
  output += line(row + 1, left + 3, paint('48;2;30;30;30') + paint(input ? '37' : '90') + (visible || '¿Qué vamos a construir?').slice(0, box - 6) + paint('0'));
  output += line(row + 3, left + 3, paint('48;2;30;30;30') + paint('38;2;238;65;55') + 'Build' + paint('37') + ` · ${clean(model)}`.slice(0, box - 12) + paint('0'));
  output += line(row + 6, left, paint('90') + 'enter enviar   tab modelos   ctrl+p comandos'.slice(0, box) + paint('0'));
  output += line(height - 1, 2, paint('90') + clean(root).slice(0, Math.max(0, width - 15)) + paint('0'));
  output += line(height - 1, Math.max(2, width - 10), paint('90') + 'MARS 0.1' + paint('0'));
  output += line(row + 1, left + 3 + [...visible].length, '') + '\x1b[?25h';
  return output;
}

/** Own raw mode only while the welcome composer is active; restore before tools/auth. */
export async function homePrompt(model: string, root: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  let value = '';
  input.setRawMode(true);
  input.resume();
  const draw = () => output.write(homeFrame(output.columns || 80, output.rows || 24, model, root, value, !process.env.NO_COLOR));
  draw();
  try {
    return await new Promise<string>(resolve => {
      const done = (answer: string) => { input.off('keypress', key); input.off('end', end); output.off('resize', draw); resolve(answer); };
      const end = () => done('/exit');
      const key = (text: string | undefined, event: { name?: string; ctrl?: boolean; meta?: boolean }) => {
        if (event.ctrl && ['c', 'd'].includes(event.name ?? '')) return done('/exit');
        if (event.name === 'tab') return done('/model');
        if (event.ctrl && event.name === 'p') return done('/help');
        if (event.name === 'return') { if (value.trim()) done(value.trim()); return; }
        if (event.name === 'backspace') value = [...value].slice(0, -1).join('');
        else if (event.ctrl && event.name === 'u') value = '';
        else if (text && !event.ctrl && !event.meta && !text.startsWith('\x1b')) value = (value + clean(text)).slice(0, 16000);
        draw();
      };
      input.on('keypress', key);
      input.once('end', end);
      output.on('resize', draw);
    });
  } finally {
    input.setRawMode(Boolean(wasRaw));
    input.pause();
    output.write('\x1b[0m\x1b[?25h\x1b[2J\x1b[H');
  }
}
