import { codeToHtml } from 'shiki';

export async function CodeBlock({ code, language = 'ts' }: { code: string; language?: string }) {
  const html = await codeToHtml(code, {
    lang: language,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
  return (
    <div className="my-6 bg-[var(--bg-muted)] border-t border-[var(--fg)]/10 p-6 overflow-x-auto font-mono text-sm">
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
