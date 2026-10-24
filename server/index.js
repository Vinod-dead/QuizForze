import { config } from './config.js';
import { createApp } from './app.js';
import { aiEnabled } from './ai.js';

const { server } = createApp({ dbPath: config.dbPath });
server.listen(config.port, () => {
  console.log(`\n  QuizForge running on http://localhost:${config.port}`);
  console.log(`  AI: ${aiEnabled() ? `Nebius Token Factory (${config.nebius.model})` : 'offline question bank (set NEBIUS_API_KEY to enable AI)'}\n`);
});
