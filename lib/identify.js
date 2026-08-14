import { geminiJSON } from './gemini.js';

// Gemini responseSchema uses the OpenAPI subset with UPPERCASE type names.
const IDENTIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    brand: { type: 'STRING', description: 'Brand name, e.g. "Chanel". Empty string if unidentifiable.' },
    model: { type: 'STRING', description: 'Model/line name, e.g. "Classic Flap", "Neverfull MM".' },
    size: { type: 'STRING', description: 'Size designation if determinable (e.g. "Medium", "MM", "25cm"), else empty.' },
    material: { type: 'STRING', description: 'Primary material, e.g. "Caviar leather", "Coated canvas".' },
    color: { type: 'STRING', description: 'Primary color as commonly listed on resale sites.' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    notes: { type: 'STRING', description: 'Authentication cues seen, ambiguities, or what extra photo would help.' },
  },
  required: ['brand', 'model', 'size', 'material', 'color', 'confidence', 'notes'],
  propertyOrdering: ['brand', 'model', 'size', 'material', 'color', 'confidence', 'notes'],
};

/**
 * Step A — identify a bag from 1–3 photos (Google Gemini vision, free tier).
 * @param {Array<{buffer: Buffer, mimetype: string}>} photos
 * @param {{brand?: string, model?: string}} hints staff-typed values; used to confirm, not replace
 */
export async function identifyBag(photos, hints = {}) {
  const parts = photos.map((p) => ({
    inline_data: { mime_type: p.mimetype, data: p.buffer.toString('base64') },
  }));

  let prompt =
    'You are an expert luxury handbag authenticator working for a pre-loved bag consignment platform. ' +
    'Identify the bag in the photo(s): brand, model/line, size, material, and color, exactly as they would appear in a resale listing title. ' +
    'Set confidence to "low" if you cannot clearly identify the brand AND model. ' +
    'In notes, mention any authentication cues you can see (logo stamps, hardware, stitching, serial/date codes) and, if confidence is not high, which additional photo would help most (a photo of the inside label or serial stamp usually helps).';

  if (hints.brand || hints.model) {
    prompt += `\n\nStaff typed the following — use it to CONFIRM your identification, not to replace what you see. If the photos contradict it, say so in notes and lower confidence: brand="${hints.brand || ''}", model="${hints.model || ''}".`;
  }

  parts.push({ text: prompt });

  return geminiJSON(parts, IDENTIFY_SCHEMA);
}
