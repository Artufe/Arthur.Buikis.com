import { site } from '@/content/site';

export type CommandAction =
  | { type: 'navigate'; href: string }
  | { type: 'external'; href: string }
  | { type: 'download'; href: string; filename?: string }
  | { type: 'theme'; value: 'light' | 'dark' | 'system' }
  | { type: 'copy'; value: string }
  | { type: 'whoami' }
  | { type: 'help' };

export type CommandGroup = 'Navigate' | 'Meta' | 'Theme';

export type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  arrow: string;
  hint?: string;
  action: CommandAction;
  keywords?: string[];
};

export const commands: Command[] = [
  // Navigate
  { id: 'goto-work', label: 'goto work', group: 'Navigate', arrow: '→', hint: '/#work', action: { type: 'navigate', href: '/#work' } },
  { id: 'goto-about', label: 'goto about', group: 'Navigate', arrow: '→', hint: '/about', action: { type: 'navigate', href: '/about' } },
  { id: 'goto-building', label: 'goto building', group: 'Navigate', arrow: '→', hint: '/building', action: { type: 'navigate', href: '/building' } },
  { id: 'goto-contact', label: 'goto contact', group: 'Navigate', arrow: '→', hint: '/contact', action: { type: 'navigate', href: '/contact' } },
  { id: 'goto-cv', label: 'goto cv', group: 'Navigate', arrow: '→', hint: '/cv', action: { type: 'navigate', href: '/cv' } },
  { id: 'goto-home', label: 'goto home', group: 'Navigate', arrow: '→', hint: '/', action: { type: 'navigate', href: '/' }, keywords: ['/'] },

  // Meta
  { id: 'download-cv', label: 'download cv', group: 'Meta', arrow: '↓', hint: 'cv.pdf', action: { type: 'download', href: '/cv.pdf', filename: 'arthur-buikis-cv.pdf' } },
  { id: 'copy-email', label: 'copy email', group: 'Meta', arrow: '≡', hint: site.email, action: { type: 'copy', value: site.email } },
  { id: 'source', label: 'source', group: 'Meta', arrow: '↗', hint: 'github repo', action: { type: 'external', href: 'https://github.com/Artufe/Artufe.github.io' }, keywords: ['github', 'repo'] },
  { id: 'linkedin', label: 'linkedin', group: 'Meta', arrow: '↗', hint: 'profile', action: { type: 'external', href: 'https://www.linkedin.com/in/arthur-buikis-002145151/' } },
  { id: 'whoami', label: 'whoami', group: 'Meta', arrow: '?', hint: 'inline', action: { type: 'whoami' } },
  { id: 'help', label: 'help', group: 'Meta', arrow: '?', hint: 'shortcut keys', action: { type: 'help' } },

  // Theme
  { id: 'theme-light', label: 'theme light', group: 'Theme', arrow: '○', action: { type: 'theme', value: 'light' } },
  { id: 'theme-dark', label: 'theme dark', group: 'Theme', arrow: '◐', action: { type: 'theme', value: 'dark' } },
  { id: 'theme-auto', label: 'theme auto', group: 'Theme', arrow: '◓', hint: 'system', action: { type: 'theme', value: 'system' }, keywords: ['system'] },
];

export const whoamiLines = {
  prompt: 'arthur@buikis:~',
  lines: [
    'backend engineer · python + some rust',
    'twelve-ish years writing software · self-taught · riga',
    'best worked with when the system is real and the stakes are boring',
  ],
  hintSuggestions: ['help', 'goto work', 'theme auto'],
};

export const helpLines = {
  prompt: 'help',
  lines: [
    '/ — open this palette',
    '↑ ↓ — move selection',
    '↵ — run command',
    'esc — close',
  ],
  hint: 'keyboard only. no mouse required.',
};

export const commandGroups: CommandGroup[] = ['Navigate', 'Meta', 'Theme'];
