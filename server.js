import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This tool is now just a FRONTEND. All Pricing 3.0 logic (identify, comps,
// price, listing, price-log) lives in the erlume backend under the admin-only
// /api/pricing-tool namespace (see backend-1.0). This server only serves the
// static UI; the browser talks to the backend directly.
//
// Configure which backend the UI uses at runtime — no rebuild needed:
//   • ?api=<url> in the URL, or
//   • localStorage.PRICING_API_BASE
// Default backend: http://127.0.0.1:3000
//
// The old Express API + lib/ pricing modules are retained on disk for
// reference/rollback but are no longer served here.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => {
  console.log(`erlume pricing tool (frontend) running at http://localhost:${PORT}`);
  console.log('Pricing logic is served by the erlume backend at /api/pricing-tool (admin-only).');
});
