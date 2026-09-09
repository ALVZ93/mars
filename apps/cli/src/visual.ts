const RESET = '\u001b[0m';
const BRIGHT_RED = '\u001b[91m';
const DIM_RED = '\u001b[2;31m';

export const MARS_ART = [
  ' __  __    _    ____  ____ ',
  '|  \\/  |  / \\  |  _ \\|  _ \\',
  '| |\\/| | / _ \\ | |_) | |_) |',
  '| |  | |/ ___ \\|  _ <|  __/ ',
  '|_|  |_/_/   \\_\\_| \\_\\_|   ',
];

export function renderMarsFrame(frame: number): string {
  const pulse = ['·    ', '··   ', '···  ', '···· ', '·····'][Math.max(0, frame) % 5];
  const shadow = MARS_ART.map(line => `  ${line}`).join('\n');
  const face = MARS_ART.map(line => `${BRIGHT_RED}${line}${RESET}`).join('\n');
  return `${DIM_RED}${shadow}${RESET}\n${face}\n${BRIGHT_RED}MARS // INITIALIZING [${pulse}]${RESET}`;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', abort, { once: true });
    setTimeout(() => signal.removeEventListener('abort', abort), ms + 1);
  });
}

export async function showMarsBoot(signal: AbortSignal, enabled = true): Promise<void> {
  if (!enabled || !process.stdout.isTTY || process.env.NO_COLOR || process.env.MARS_NO_ANIMATION || process.env.TERM === 'dumb') return;
  const frame = renderMarsFrame(0);
  const lines = frame.split('\n').length;
  let drawn = false;
  process.stdout.write('\u001b[?25l');
  try {
    for (let index = 0; index < 5 && !signal.aborted; index++) {
      if (drawn) process.stdout.write(`\u001b[${lines}A`);
      process.stdout.write(renderMarsFrame(index) + '\n');
      drawn = true;
      await pause(70, signal);
    }
  } finally {
    if (drawn) process.stdout.write(`\u001b[${lines}A\u001b[0J`);
    process.stdout.write(`${RESET}\u001b[?25h`);
  }
}
