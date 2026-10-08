// Minimal types for Joplin's maintained fork of turndown-plugin-gfm.
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  type Plugin = (service: TurndownService) => void;
  const plugins: { gfm: Plugin; tables: Plugin; strikethrough: Plugin; taskListItems: Plugin };
  export default plugins;
}
