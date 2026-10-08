import mammoth from 'mammoth';
import TurndownService from 'turndown';
import gfmPlugins from '@joplin/turndown-plugin-gfm';
import { extractText } from 'unpdf';

const { gfm } = gfmPlugins;

// Converts uploaded files to Markdown, so every page stays plain Markdown.
// Markdown and text are imported as-is; Word and HTML keep headings, lists,
// links, and tables; PDF is text only (layout and images are dropped).

export const SUPPORTED = ['.md', '.markdown', '.txt', '.docx', '.html', '.htm', '.pdf'] as const;
export type Extension = (typeof SUPPORTED)[number];

export interface Converted {
  markdown: string;
  notes: string[];
}

export class ConversionError extends Error {}

function turndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  service.use(gfm);
  service.remove(['head', 'title', 'script', 'style', 'noscript', 'iframe', 'object', 'embed']);
  // Embedded (data:) images would bloat a page with base64; drop them.
  service.addRule('dropEmbeddedImages', {
    filter: (node) => node.nodeName === 'IMG' && /^data:/i.test(node.getAttribute('src') ?? ''),
    replacement: () => '',
  });
  return service;
}

const utf8 = (data: Buffer) => data.toString('utf8').replace(/^﻿/, '');

// Tidies converter output: "- item" instead of turndown's "-   item", no
// trailing spaces, and at most one blank line in a row.
const tidy = (markdown: string) =>
  markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^(\s*)([-*+]|\d+\.) {2,}/gm, '$1$2 ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';

// Word tables rarely mark a header row, and Markdown tables need one; treat
// the first row as the header instead of emitting an empty one.
function firstRowAsHeader(html: string): string {
  return html.replace(/<table>(\s*<tr>)([\s\S]*?)<\/tr>/g, (_match, open: string, row: string) => {
    if (/<th[\s>]/.test(row)) return `<table>${open}${row}</tr>`;
    const header = row
      .replace(/<td(\s[^>]*)?>/g, '<th>')
      .replace(/<\/td>/g, '</th>')
      .replace(/<\/?strong>/g, '');
    return `<table>${open}${header}</tr>`;
  });
}

async function fromDocx(data: Buffer): Promise<Converted> {
  const notes: string[] = [];
  const result = await mammoth.convertToHtml(
    { buffer: data },
    // Images become empty tags, which turndown drops.
    { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
  );
  if (/<img/i.test(result.value)) notes.push('Images were not imported.');
  if (result.messages.some((m) => m.type === 'warning')) {
    notes.push('Some Word formatting had no Markdown equivalent and was simplified.');
  }
  return { markdown: turndown().turndown(firstRowAsHeader(result.value.replace(/<img[^>]*>/gi, ''))), notes };
}

async function fromPdf(data: Buffer): Promise<Converted> {
  let pages: string[];
  try {
    ({ text: pages } = await extractText(new Uint8Array(data), { mergePages: false }));
  } catch {
    throw new ConversionError('This PDF could not be read (damaged or password-protected?).');
  }
  const text = pages.map((p) => p.trim()).filter(Boolean).join('\n\n');
  return { markdown: text, notes: ['PDF imported as plain text: layout, tables, and images were not kept.'] };
}

export async function convert(extension: Extension, data: Buffer): Promise<Converted> {
  let converted: Converted;
  switch (extension) {
    case '.md':
    case '.markdown':
    case '.txt':
      converted = { markdown: utf8(data), notes: [] };
      break;
    case '.html':
    case '.htm':
      converted = { markdown: turndown().turndown(utf8(data)), notes: [] };
      break;
    case '.docx':
      try {
        converted = await fromDocx(data);
      } catch (err) {
        if (err instanceof ConversionError) throw err;
        throw new ConversionError('This Word file could not be read (damaged, or an old .doc saved as .docx?).');
      }
      break;
    case '.pdf':
      converted = await fromPdf(data);
      break;
  }
  const markdown = tidy(converted.markdown);
  if (!markdown.trim()) {
    throw new ConversionError(
      extension === '.pdf' ? 'No text found. Scanned PDFs (images of text) are not supported.' : 'The file is empty.',
    );
  }
  return { markdown, notes: converted.notes };
}
