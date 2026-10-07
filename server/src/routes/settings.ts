import { Router } from 'express';
import { generateQuestion, LlmError } from '../llm/generate.js';
import { getPublicSettings, getSettings, saveSettings, type Provider } from '../llm/settings.js';

export const settingsRouter = Router();

const PROVIDERS: Provider[] = ['anthropic', 'openai-compatible'];
const SAMPLE = {
  title: 'Expense policy',
  headings: '',
  content:
    'Employees can expense meals while travelling, up to $75 per day. Submit receipts within 30 days. ' +
    'Flights over $800 need manager approval before booking.',
};

// The API key is never returned, only whether one is set and its last four characters.
settingsRouter.get('/llm', async (_req, res) => {
  res.json(await getPublicSettings());
});

// Any signed-in user may change these (there are no roles in the MVP).
settingsRouter.put('/llm', async (req, res) => {
  const { provider, model, baseUrl, apiKey } = req.body ?? {};
  if (!PROVIDERS.includes(provider)) {
    res.status(400).json({ error: `"provider" must be one of: ${PROVIDERS.join(', ')}` });
    return;
  }
  if (typeof model !== 'string' || !model.trim() || model.length > 200) {
    res.status(400).json({ error: '"model" is required' });
    return;
  }
  const url = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (url && !/^https?:\/\/\S+$/.test(url)) {
    res.status(400).json({ error: '"baseUrl" must be an http(s) URL' });
    return;
  }
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 500)) {
    res.status(400).json({ error: '"apiKey" must be a string' });
    return;
  }
  res.json(await saveSettings({ provider, model: model.trim(), baseUrl: url, apiKey: apiKey?.trim() }, req.user!));
});

// Generates a sample question with the saved settings, to check they work.
settingsRouter.post('/llm/test', async (_req, res) => {
  try {
    const settings = await getSettings();
    if (!settings) {
      res.status(400).json({ error: 'Save a provider, model, and API key first.' });
      return;
    }
    res.json({ ok: true, sample: await generateQuestion(settings, SAMPLE) });
  } catch (err) {
    if (err instanceof LlmError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});
